// Regeln aus db.rs (Validierung, Kaskaden, Import/Export) für das Browser-Backend.
import { describe, expect, it } from 'vitest';
import { webApi as api, parseBackup } from '../src/backend/web';
import { validDate } from '../src/backend/validate';
import { TEMPLATES } from '../src/backend/templates';
import type { Member } from '../src/api';

const people = (): Member[] => [
  { id: 0, name: 'Anna', color: '#0e5b4c', income_cents: 300_000 },
  { id: 0, name: 'Ben', color: '#aa3300', income_cents: 100_000 },
];
const warn = (message?: string) => ({ kind: 'warning', ...(message ? { message } : {}) });

describe('Haushalt', () => {
  it('jede Vorlage lässt sich anlegen, unbekannte nicht', async () => {
    for (const t of TEMPLATES) {
      const s = await api.create('Test', people(), t.id);
      expect(s.groups.map(g => g.name)).toEqual(t.groups.map(g => g.name));
      expect(s.expenses.length).toBe(t.groups.reduce((a, g) => a + g.items.length, 0));
      expect(s.history).toEqual({ undo: null, redo: null });
    }
    await expect(api.create('Test', people(), 'gibt-es-nicht')).rejects.toMatchObject(warn('Unbekannte Vorlage.'));
    await expect(api.create('  ', people(), 'leer')).rejects.toMatchObject(warn('Der Name darf nicht leer sein.'));
    await expect(api.create('X', [], 'leer')).rejects.toMatchObject(warn('Mindestens eine Person wird benötigt.'));
  });

  it('CRUD, Rechnung und Kaskaden', async () => {
    let s = await api.create('WG', people(), 'leer');
    const [anna, ben] = s.members;
    s = await api.saveGroup({ id: 0, name: 'Wohnen' });
    const g = s.groups[0];
    s = await api.saveAccount({ id: 0, name: 'Giro' });
    const acc = s.accounts[0];
    s = await api.saveExpense({ id: 0, group_id: g.id, name: 'Miete', amount_cents: 100_000, period: 'monthly', split: 'income', split_member: null, weights: {}, account_id: acc.id });
    s = await api.saveExpense({ id: 0, group_id: g.id, name: 'Strom', amount_cents: 12_000, period: 'yearly', split: 'only', split_member: ben.id, weights: {}, account_id: null });
    s = await api.saveExpense({ id: 0, group_id: g.id, name: 'Netz', amount_cents: 3_000, period: 'monthly', split: 'custom', split_member: null, weights: { [anna.id]: 7000, [ben.id]: 3000 }, account_id: null });
    expect(s.summary.total_cents).toBe(104_000);
    expect(s.summary.lines[0].shares).toEqual([75_000, 25_000]);
    s = await api.saveDeduction({ id: 0, member_id: ben.id, name: 'Gym', amount_cents: 3_000 });

    // Konto löschen: Posten bleibt, Konto null
    s = await api.deleteAccount(acc.id);
    expect(s.expenses[0].account_id).toBeNull();
    // Person löschen: Abzug weg, „nur“-Posten -> Einkommen, Gewicht entfernt
    s = await api.deleteMember(ben.id);
    expect(s.deductions).toEqual([]);
    expect(s.expenses[1].split).toBe('income');
    expect(s.expenses[1].split_member).toBeNull();
    expect(s.expenses[2].weights).toEqual({ [anna.id]: 7000 });
    await expect(api.deleteMember(anna.id)).rejects.toMatchObject(warn('Die letzte Person kann nicht entfernt werden.'));
    // Gruppe löschen: Posten mit
    s = await api.deleteGroup(g.id);
    expect(s.expenses).toEqual([]);
    await expect(api.deleteGroup(g.id)).rejects.toMatchObject(warn('Eintrag nicht gefunden.'));
  });

  it('lehnt falsche Eingaben ab und ändert dabei nichts', async () => {
    let s = await api.create('V', people(), 'minimal');
    const e = s.expenses[0];
    const bad = (patch: object, msg: string) => expect(api.saveExpense({ ...e, ...patch })).rejects.toMatchObject(warn(msg));
    await bad({ amount_cents: -1 }, 'Der Betrag darf nicht negativ sein.');
    await bad({ period: 'weekly' }, 'Ungültiger Rhythmus.');
    await bad({ split: 'x' }, 'Ungültige Aufteilung.');
    await bad({ split: 'only', split_member: null }, 'Bitte eine Person wählen.');
    await bad({ split: 'only', split_member: 999 }, 'Diese Änderung ist nicht zulässig, sie verletzt eine Datenregel.');
    await bad({ split: 'custom', weights: { 1: 10_001 } }, 'Prozentwerte müssen zwischen 0 und 100 liegen.');
    await bad({ split: 'custom', weights: { 1: 0 } }, 'Mindestens ein Anteil muss größer als 0 sein.');
    await bad({ account_id: 42 }, 'Dieses Konto existiert nicht mehr.');
    await bad({ group_id: 999 }, 'Diese Änderung ist nicht zulässig, sie verletzt eine Datenregel.');
    await bad({ id: 999 }, 'Eintrag nicht gefunden.');
    await expect(api.saveMember({ ...s.members[0], color: 'rot' })).rejects.toMatchObject(warn('Ungültige Farbe.'));
    await expect(api.saveMember({ ...s.members[0], income_cents: -5 })).rejects.toMatchObject(warn('Das Einkommen darf nicht negativ sein.'));
    s = await api.saveAccount({ id: 0, name: 'Giro' });
    await expect(api.saveAccount({ id: 0, name: 'giro' })).rejects.toMatchObject(warn('Ein Konto mit diesem Namen gibt es schon.'));
    expect((await api.open(s.id)).expenses[0]).toEqual(e);
  });

  it('Schulden: Prüfungen und Kalender', async () => {
    const s = await api.create('S', people(), 'leer');
    const debt = { id: 0, kind: 'receivable' as const, counterparty: 'Tom', purpose: ' Pizza ', amount_cents: 1250, due_on: '2026-10-31', paid_on: null };
    const t = await api.saveDebt(debt);
    expect(t.debts[0].purpose).toBe('Pizza');
    await expect(api.saveDebt({ ...debt, amount_cents: 0 })).rejects.toMatchObject(warn('Der Betrag muss größer als 0 sein.'));
    await expect(api.saveDebt({ ...debt, counterparty: ' ' })).rejects.toMatchObject(warn('Bitte den Schuldner angeben.'));
    await expect(api.saveDebt({ ...debt, kind: 'payable', counterparty: ' ' })).rejects.toMatchObject(warn('Bitte den Gläubiger angeben.'));
    await expect(api.saveDebt({ ...debt, due_on: '2026-02-30' })).rejects.toMatchObject(warn('Fälligkeitsdatum: Bitte ein gültiges Datum angeben.'));
    expect([validDate('2024-02-29'), validDate('2023-02-29'), validDate('1899-12-31'), validDate('2026-13-01'), validDate('2026-1-01')])
      .toEqual([true, false, false, false, false]);
    expect(s.id).toBeTruthy();
  });
});

describe('Export / Import', () => {
  it('Roundtrip behält alles, Zahlen identisch', async () => {
    let s = await api.create('Rund', people(), 'paar');
    s = await api.saveAccount({ id: 0, name: 'Giro' });
    s = await api.saveExpense({ ...s.expenses[0], amount_cents: 82_500, split: 'custom', weights: { [s.members[0].id]: 6000, [s.members[1].id]: 4000 }, account_id: s.accounts[0].id });
    s = await api.saveDeduction({ id: 0, member_id: s.members[0].id, name: 'Sparen', amount_cents: 20_000 });
    s = await api.saveDebt({ id: 0, kind: 'payable', counterparty: 'Oma', purpose: '', amount_cents: 500, due_on: null, paid_on: null });
    const { json } = api.exportJson();
    const raw = JSON.parse(json);
    expect(Object.keys(raw)).toEqual(['format', 'name', 'members', 'groups', 'accounts', 'expenses', 'deductions', 'debts']);
    expect(raw.format).toBe(1);
    const t = await api.importText(json);
    expect(t.id).not.toBe(s.id);
    const strip = ({ id: _i, ...rest }: typeof s) => rest;
    expect(strip(t)).toEqual(strip(s));
    // neue IDs beim Weiterarbeiten kollidieren nicht
    const u = await api.saveGroup({ id: 0, name: 'Neu' });
    const ids = [...u.members, ...u.groups, ...u.expenses].map(x => x.id);
    expect(new Set(u.groups.map(x => x.id)).size).toBe(u.groups.length);
    expect(Math.max(...u.groups.map(g => g.id))).toBeGreaterThan(Math.max(...ids.filter(i => !u.groups.some(g => g.id === i))) - 1000);
  });

  it('ältere Dateien ohne Konten/Schulden und Zusatzfelder werden akzeptiert', () => {
    const old = { format: 1, name: 'Alt', future: 1, members: [{ id: 1, name: 'A', color: '#000000', income_cents: 1, x: 1 }], groups: [], expenses: [], deductions: [] };
    const { data, nextId } = parseBackup(JSON.stringify(old));
    expect(data.accounts).toEqual([]);
    expect(data.debts).toEqual([]);
    expect(nextId).toBe(2);
  });

  it('kaputte Dateien geben verständliche Meldungen', () => {
    const bad = (t: string, re: RegExp) => { try { parseBackup(t); } catch (e) { expect(String((e as { message: string }).message)).toMatch(re); return; } throw new Error('kein Fehler'); };
    bad('kein json', /kein gültiger BudGit-Speicherstand/);
    bad('[]', /kein gültiger BudGit-Speicherstand/);
    bad('{"format":2}', /Unbekanntes Speicherstand-Format/);
    bad('x'.repeat(5 * 1024 * 1024 + 1), /zu groß/);
    const base = { format: 1, name: 'N', members: [{ id: 1, name: 'A', color: '#000000', income_cents: 1 }], groups: [{ id: 2, name: 'G' }], expenses: [], deductions: [] };
    const exp = { id: 3, group_id: 2, name: 'E', amount_cents: 1, period: 'monthly', split: 'income', split_member: null };
    bad(JSON.stringify({ ...base, expenses: [{ ...exp, group_id: 9 }] }), /Datenregel/);          // Fremdschlüssel
    bad(JSON.stringify({ ...base, expenses: [exp, exp] }), /Datenregel/);                          // doppelte ID
    bad(JSON.stringify({ ...base, expenses: [{ ...exp, period: 'x' }] }), /Datenregel/);           // CHECK
    bad(JSON.stringify({ ...base, deductions: [{ id: 4, member_id: 9, name: 'x', amount_cents: 1 }] }), /Datenregel/);
    bad(JSON.stringify({ ...base, members: [{ id: 1, name: 'A', color: 'rot', income_cents: 1 }] }), /Ungültige Farbe/);
  });
});
