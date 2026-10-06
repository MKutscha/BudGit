// Browser-Backend: gleiche Signaturen wie backend/tauri.ts, Daten in IndexedDB (siehe store.ts).
import type { Account, Debt, Deduction, Expense, Group, HouseholdInfo, Member, Snapshot } from '../api';
import { compute } from './split';
import { findTemplate, templateInfos } from './templates';
import { deleteDoc, listDocs, loadDoc, saveDoc, type Backup, type Doc } from './store';
import {
  checkAccount, checkDebt, checkDeduction, checkExpense, checkGroup, checkMember, cleanName,
  constraint, fail, isInt,
} from './validate';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

let current: Doc | null = null;

const newDocId = () => 'h' + (globalThis.crypto?.randomUUID?.().replace(/-/g, '') ?? Math.random().toString(16).slice(2) + Date.now().toString(16));

const touched = <T>(item: T | undefined): T => item ?? fail('Eintrag nicht gefunden.');

function toSnapshot(doc: Doc): Snapshot {
  const d = doc.data;
  return {
    id: doc.id, name: d.name,
    members: d.members, groups: d.groups, accounts: d.accounts,
    expenses: d.expenses, deductions: d.deductions, debts: d.debts,
    summary: compute(d.members, d.expenses, d.deductions),
    history: { undo: null, redo: null }, // im Web gibt es kein Rückgängig/Wiederholen
  };
}

const byId = <T extends { id: number }>(a: T, b: T) => a.id - b.id;

/** Arbeitskopie ändern, prüfen, mit EINEM Schreibvorgang speichern. Wirft bei Fehlern, ohne etwas zu ändern. */
async function mutate(fn: (data: Backup, newId: () => number) => void): Promise<Snapshot> {
  if (!current) return fail('Kein Haushalt geöffnet.');
  const doc = structuredClone(current);
  fn(doc.data, () => doc.nextId++);
  doc.updatedAt = Date.now();
  doc.changes += 1;
  await saveDoc(doc);
  current = doc;
  return toSnapshot(doc);
}

// ---------- Import / Export ----------

function uniqueIds(items: { id: number }[], what: string) {
  const seen = new Set<number>();
  for (const i of items) {
    if (!isInt(i.id) || i.id <= 0) fail(`Die Datei ist kein gültiger BudGit-Speicherstand (ungültige ID bei ${what}).`);
    if (seen.has(i.id)) constraint();
    seen.add(i.id);
  }
  return seen;
}

/** Liest und prüft einen Speicherstand; wirft verständliche Meldungen. Unbekannte Zusatzfelder werden ignoriert. */
export function parseBackup(text: string): { data: Backup; nextId: number } {
  if (text.length > MAX_IMPORT_BYTES) fail('Die Datei ist zu groß für einen BudGit-Speicherstand (max. 5 MB).');
  let raw: any;
  try { raw = JSON.parse(text); } catch (e) {
    return fail(`Die Datei ist kein gültiger BudGit-Speicherstand (${(e as Error).message}).`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('Die Datei ist kein gültiger BudGit-Speicherstand (kein Objekt).');
  if (raw.format !== 1) fail('Unbekanntes Speicherstand-Format.');
  const arr = (k: string, optional = false): any[] => {
    const v = raw[k] ?? (optional ? [] : undefined);
    if (!Array.isArray(v)) return fail(`Die Datei ist kein gültiger BudGit-Speicherstand (missing field \`${k}\`).`);
    return v.map(x => (typeof x === 'object' && x !== null ? x : fail('Die Datei ist kein gültiger BudGit-Speicherstand (ungültiger Eintrag).')));
  };

  const name = cleanName(raw.name);
  const members: Member[] = arr('members').map(m => {
    const n = checkMember(m);
    return { id: m.id, name: n, color: m.color, income_cents: m.income_cents };
  });
  if (members.length === 0) fail('Mindestens eine Person wird benötigt.');
  const groups: Group[] = arr('groups').map(g => ({ id: g.id, name: cleanName(g.name) }));
  const accounts: Account[] = arr('accounts', true).map(a => ({ id: a.id, name: cleanName(a.name) }));
  const memberIds = uniqueIds(members, 'Personen');
  const groupIds = uniqueIds(groups, 'Gruppen');
  const accountIds = uniqueIds(accounts, 'Konten');

  const expenses: Expense[] = arr('expenses').map(e => {
    const ex: Expense = {
      id: e.id, group_id: e.group_id, name: cleanName(e.name), amount_cents: e.amount_cents,
      period: e.period, split: e.split, split_member: e.split_member ?? null,
      weights: {}, account_id: e.account_id ?? null,
    };
    if (!isInt(ex.amount_cents) || ex.amount_cents < 0 || !['monthly', 'quarterly', 'yearly'].includes(ex.period)
      || !['income', 'equal', 'only', 'custom'].includes(ex.split)) constraint();
    if (!groupIds.has(ex.group_id)) constraint();
    if (ex.split_member !== null && !memberIds.has(ex.split_member)) constraint();
    if (ex.account_id !== null && !accountIds.has(ex.account_id)) constraint();
    if (ex.split === 'custom') {
      for (const [k, w] of Object.entries(e.weights ?? {})) {
        if (!isInt(w) || w < 0 || !memberIds.has(Number(k))) constraint();
        ex.weights[Number(k)] = w as number;
      }
    }
    return ex;
  });
  uniqueIds(expenses, 'Posten');

  const deductions: Deduction[] = arr('deductions').map(d => {
    const de: Deduction = { id: d.id, member_id: d.member_id, name: cleanName(d.name), amount_cents: d.amount_cents };
    if (!isInt(de.amount_cents) || de.amount_cents < 0 || !memberIds.has(de.member_id)) constraint();
    return de;
  });
  uniqueIds(deductions, 'Abzüge');

  const debts: Debt[] = arr('debts', true).map(d => {
    const de: Debt = {
      id: d.id, kind: d.kind, counterparty: cleanName(d.counterparty), purpose: String(d.purpose ?? '').trim(),
      amount_cents: d.amount_cents, due_on: d.due_on ?? null, paid_on: d.paid_on ?? null,
    };
    if (!['receivable', 'payable'].includes(de.kind) || !isInt(de.amount_cents) || de.amount_cents < 0) constraint();
    for (const s of [de.due_on, de.paid_on]) if (s !== null && typeof s !== 'string') constraint();
    return de;
  });
  uniqueIds(debts, 'Schulden');

  const all = [...members, ...groups, ...accounts, ...expenses, ...deductions, ...debts];
  const data: Backup = {
    format: 1, name,
    members: members.sort(byId), groups: groups.sort(byId), accounts: accounts.sort(byId),
    expenses: expenses.sort(byId), deductions: deductions.sort(byId), debts: debts.sort(byId),
  };
  return { data, nextId: Math.max(0, ...all.map(i => i.id)) + 1 };
}

const toBackup = (d: Backup): Backup => ({
  format: 1, name: d.name, members: d.members, groups: d.groups, accounts: d.accounts,
  expenses: d.expenses.map(e => ({ ...e, split_member: e.split_member ?? null, account_id: e.account_id ?? null, weights: e.weights ?? {} })),
  deductions: d.deductions, debts: d.debts,
});

async function openNew(data: Backup, nextId: number): Promise<Snapshot> {
  const doc: Doc = { id: newDocId(), schema: 1, data, nextId, updatedAt: Date.now(), lastExportAt: null, changes: 0 };
  await saveDoc(doc);
  current = doc;
  return toSnapshot(doc);
}

// ---------- API ----------

const unsupported = () => Promise.reject({ kind: 'error', message: 'Diese Funktion gibt es in der Web-Version nicht.' });

export const webApi = {
  list: async (): Promise<HouseholdInfo[]> =>
    (await listDocs()).map(d => ({ id: d.id, name: d.data.name, members: d.data.members.slice().sort(byId).map(m => m.name) })),
  dataDir: async () => '',
  templates: async () => templateInfos(),

  create: async (name: string, members: Member[], template: string): Promise<Snapshot> => {
    const n = cleanName(name);
    const tpl = findTemplate(template) ?? fail('Unbekannte Vorlage.');
    if (members.length === 0) fail('Mindestens eine Person wird benötigt.');
    let next = 1;
    const data: Backup = {
      format: 1, name: n, accounts: [], deductions: [], debts: [], groups: [], expenses: [],
      members: members.map(m => ({ id: next++, name: checkMember(m), color: m.color, income_cents: m.income_cents })),
    };
    for (const g of tpl.groups) {
      const gid = next++;
      data.groups.push({ id: gid, name: g.name });
      for (const item of g.items) {
        data.expenses.push({
          id: next++, group_id: gid, name: item, amount_cents: 0, period: 'monthly',
          split: tpl.split, split_member: null, weights: {}, account_id: null,
        });
      }
    }
    return openNew(data, next);
  },
  open: async (id: string): Promise<Snapshot> => {
    const doc = await loadDoc(id);
    if (!doc) return fail('Dieser Speicherstand existiert nicht mehr.');
    current = doc;
    return toSnapshot(doc);
  },
  close: async () => { current = null; },
  remove: async (id: string) => {
    if (current?.id === id) current = null;
    await deleteDoc(id);
  },
  /** Im Web gibt es keine Dateipfade: stattdessen exportJson() / importText(). */
  exportTo: (_path: string) => unsupported() as Promise<void>,
  importFrom: (_path: string) => unsupported() as Promise<Snapshot>,

  rename: (name: string) => mutate(d => { d.name = cleanName(name); }),

  saveMember: (member: Member) => mutate((d, newId) => {
    const name = checkMember(member);
    if (member.id > 0) {
      const m = touched(d.members.find(x => x.id === member.id));
      Object.assign(m, { name, color: member.color, income_cents: member.income_cents });
    } else {
      d.members.push({ id: newId(), name, color: member.color, income_cents: member.income_cents });
    }
  }),
  deleteMember: (id: number) => mutate(d => {
    if (d.members.length <= 1) fail('Die letzte Person kann nicht entfernt werden.');
    for (const e of d.expenses) {
      if (e.split_member === id) { e.split = 'income'; e.split_member = null; }
      delete e.weights[id];
    }
    d.deductions = d.deductions.filter(x => x.member_id !== id);
    const before = d.members.length;
    d.members = d.members.filter(m => m.id !== id);
    touched(d.members.length < before ? true : undefined);
  }),

  saveGroup: (group: Group) => mutate((d, newId) => {
    const g = checkGroup(group);
    if (group.id > 0) touched(d.groups.find(x => x.id === group.id)).name = g.name;
    else d.groups.push({ id: newId(), name: g.name });
  }),
  deleteGroup: (id: number) => mutate(d => {
    touched(d.groups.find(g => g.id === id));
    d.groups = d.groups.filter(g => g.id !== id);
    d.expenses = d.expenses.filter(e => e.group_id !== id); // ON DELETE CASCADE
  }),

  saveDebt: (debt: Debt) => mutate((d, newId) => {
    const c = checkDebt(debt);
    if (debt.id > 0) {
      const cur = touched(d.debts.find(x => x.id === debt.id));
      Object.assign(cur, { kind: c.kind, counterparty: c.counterparty, purpose: c.purpose, amount_cents: c.amount_cents, due_on: c.due_on, paid_on: c.paid_on });
    } else {
      d.debts.push({ id: newId(), kind: c.kind, counterparty: c.counterparty, purpose: c.purpose, amount_cents: c.amount_cents, due_on: c.due_on, paid_on: c.paid_on });
    }
  }),
  deleteDebt: (id: number) => mutate(d => {
    touched(d.debts.find(x => x.id === id));
    d.debts = d.debts.filter(x => x.id !== id);
  }),

  saveAccount: (account: Account) => mutate((d, newId) => {
    const a = checkAccount(account);
    const same = d.accounts.some(x => x.name.toLowerCase() === a.name.toLowerCase() && x.id !== account.id);
    if (same) fail('Ein Konto mit diesem Namen gibt es schon.');
    if (account.id > 0) touched(d.accounts.find(x => x.id === account.id)).name = a.name;
    else d.accounts.push({ id: newId(), name: a.name });
  }),
  /** Zugeordnete Posten bleiben erhalten und haben danach kein Konto (ON DELETE SET NULL). */
  deleteAccount: (id: number) => mutate(d => {
    touched(d.accounts.find(x => x.id === id));
    d.accounts = d.accounts.filter(x => x.id !== id);
    for (const e of d.expenses) if (e.account_id === id) e.account_id = null;
  }),

  saveExpense: (expense: Expense) => mutate((d, newId) => {
    const e = checkExpense(
      expense,
      id => d.members.some(m => m.id === id),
      id => d.accounts.some(a => a.id === id),
    );
    if (!d.groups.some(g => g.id === e.group_id)) constraint();
    if (expense.id > 0) {
      const cur = touched(d.expenses.find(x => x.id === expense.id));
      Object.assign(cur, { group_id: e.group_id, name: e.name, amount_cents: e.amount_cents, period: e.period, split: e.split, split_member: e.split_member, account_id: e.account_id, weights: e.weights });
    } else {
      d.expenses.push({ id: newId(), group_id: e.group_id, name: e.name, amount_cents: e.amount_cents, period: e.period, split: e.split, split_member: e.split_member, weights: e.weights, account_id: e.account_id });
    }
  }),
  deleteExpense: (id: number) => mutate(d => {
    touched(d.expenses.find(x => x.id === id));
    d.expenses = d.expenses.filter(x => x.id !== id);
  }),

  saveDeduction: (deduction: Deduction) => mutate((d, newId) => {
    const c = checkDeduction(deduction);
    if (deduction.id > 0) {
      const cur = touched(d.deductions.find(x => x.id === deduction.id));
      Object.assign(cur, { name: c.name, amount_cents: c.amount_cents });
    } else {
      if (!d.members.some(m => m.id === deduction.member_id)) constraint();
      d.deductions.push({ id: newId(), member_id: deduction.member_id, name: c.name, amount_cents: c.amount_cents });
    }
  }),
  deleteDeduction: (id: number) => mutate(d => {
    touched(d.deductions.find(x => x.id === id));
    d.deductions = d.deductions.filter(x => x.id !== id);
  }),

  // Nur am Desktop: im Web ohne Wirkung (die UI blendet sie über platform.caps aus).
  undo: (): Promise<Snapshot> => unsupported() as Promise<Snapshot>,
  redo: (): Promise<Snapshot> => unsupported() as Promise<Snapshot>,
  backups: async (): Promise<number[]> => [],
  restoreBackup: (_at: number): Promise<Snapshot> => unsupported() as Promise<Snapshot>,

  // ---------- nur Web ----------

  /** Aktueller Zustand aus dem Speicher, synchron (wichtig für navigator.share, braucht frische Nutzer-Geste). */
  exportJson: (): { name: string; json: string } => {
    if (!current) return fail('Kein Haushalt geöffnet.');
    return { name: current.data.name, json: JSON.stringify(toBackup(current.data), null, 2) };
  },
  markExported: async () => {
    if (!current) return;
    const doc = structuredClone(current);
    doc.lastExportAt = Date.now();
    doc.changes = 0;
    await saveDoc(doc);
    current = doc;
  },
  /** Legt aus dem Inhalt einer .budgit-Datei einen NEUEN Haushalt an und öffnet ihn. */
  importText: (text: string) => {
    const { data, nextId } = parseBackup(text);
    return openNew(data, nextId);
  },
  /** Für Export-Erinnerung und Speicher-Status in den Einstellungen. */
  meta: () => (current ? { lastExportAt: current.lastExportAt, changes: current.changes, updatedAt: current.updatedAt } : null),
};
