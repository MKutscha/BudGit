// Regeln, die im Desktop-Build SQLite (CHECK/FOREIGN KEY) und db.rs erzwingen. Meldungen 1:1 aus db.rs.
import type { Account, Debt, Deduction, Expense, Group, Member } from '../api';

/** Wirft im Format, das toProblem() in api.ts erwartet. */
export function fail(message: string, kind: 'warning' | 'error' = 'warning'): never {
  throw { kind, message };
}

/** Entspricht einer verletzten SQLite-Datenregel (CHECK / FOREIGN KEY). */
export const constraint = (): never => fail('Diese Änderung ist nicht zulässig, sie verletzt eine Datenregel.');

/** Betragsobergrenze: hält alle Summen sicher im ganzzahligen Bereich von JS (10 Mrd. €). */
export const MAX_CENTS = 1_000_000_000_000;

export const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const cents = (n: unknown): number => {
  if (!isInt(n)) return fail('Ungültiger Betrag.');
  if (n > MAX_CENTS) return fail('Der Betrag ist zu groß.');
  return n;
};

export function cleanName(s: unknown): string {
  const t = typeof s === 'string' ? s.trim() : '';
  if (t === '') return fail('Der Name darf nicht leer sein.');
  if ([...t].length > 80) return fail('Der Name ist zu lang (max. 80 Zeichen).');
  return t;
}

export function checkMember(m: Member): string {
  const name = cleanName(m.name);
  if (typeof m.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(m.color)) fail('Ungültige Farbe.');
  if (isInt(m.income_cents) && m.income_cents < 0) fail('Das Einkommen darf nicht negativ sein.');
  cents(m.income_cents);
  return name;
}

/** Prüft „JJJJ-MM-TT“ (Jahr 1900–2200, echte Kalendertage inkl. Schaltjahr). */
export function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [1, 3, 5, 7, 8, 10, 12].includes(mo) ? 31 : [4, 6, 9, 11].includes(mo) ? 30 : leap ? 29 : 28;
  return d >= 1 && d <= days;
}

function checkDate(d: string | null, what: string) {
  if (d !== null && (typeof d !== 'string' || !validDate(d))) fail(`${what}: Bitte ein gültiges Datum angeben.`);
}

export const PERIODS = ['monthly', 'quarterly', 'yearly'];
export const SPLITS = ['income', 'equal', 'only', 'custom'];

/** Normalisierter Posten wie ihn save_expense in die Datenbank schreibt. */
export function checkExpense(e: Expense, knownMember: (id: number) => boolean, knownAccount: (id: number) => boolean): Expense {
  const name = cleanName(e.name);
  if (e.account_id !== null && e.account_id !== undefined && !knownAccount(e.account_id)) fail('Dieses Konto existiert nicht mehr.');
  if (isInt(e.amount_cents) && e.amount_cents < 0) fail('Der Betrag darf nicht negativ sein.');
  cents(e.amount_cents);
  if (!PERIODS.includes(e.period)) fail('Ungültiger Rhythmus.');
  let only: number | null = null;
  if (e.split === 'only') {
    if (e.split_member === null || e.split_member === undefined) fail('Bitte eine Person wählen.');
    only = e.split_member;
  } else if (!['income', 'equal', 'custom'].includes(e.split)) fail('Ungültige Aufteilung.');
  const weights: Record<number, number> = {};
  if (e.split === 'custom') {
    const entries = Object.entries(e.weights ?? {}).map(([k, v]) => [Number(k), v] as const);
    if (entries.some(([, w]) => !isInt(w) || w < 0 || w > 10_000)) fail('Prozentwerte müssen zwischen 0 und 100 liegen.');
    if (entries.reduce((a, [, w]) => a + w, 0) <= 0) fail('Mindestens ein Anteil muss größer als 0 sein.');
    for (const [m, w] of entries) {
      if (!isInt(m) || !knownMember(m)) constraint();
      weights[m] = w;
    }
  }
  if (only !== null && !knownMember(only)) constraint();
  return { ...e, name, split_member: only, weights, account_id: e.account_id ?? null };
}

export function checkDeduction(d: Deduction): Deduction {
  const name = cleanName(d.name);
  if (isInt(d.amount_cents) && d.amount_cents < 0) fail('Der Betrag darf nicht negativ sein.');
  cents(d.amount_cents);
  return { ...d, name };
}

export function checkGroup(g: Group): Group { return { ...g, name: cleanName(g.name) }; }
export function checkAccount(a: Account): Account { return { ...a, name: cleanName(a.name) }; }

export function checkDebt(d: Debt): Debt {
  if (!['receivable', 'payable'].includes(d.kind)) fail('Ungültige Art (Forderung oder Schuld).');
  const who = (d.counterparty ?? '').trim();
  if (who === '') fail(`Bitte ${d.kind === 'receivable' ? 'den Schuldner' : 'den Gläubiger'} angeben.`);
  if ([...who].length > 80) fail('Der Name ist zu lang (max. 80 Zeichen).');
  const purpose = (d.purpose ?? '').trim();
  if ([...purpose].length > 200) fail('Der Verwendungszweck ist zu lang (max. 200 Zeichen).');
  if (!isInt(d.amount_cents) || d.amount_cents <= 0) fail('Der Betrag muss größer als 0 sein.');
  cents(d.amount_cents);
  checkDate(d.due_on ?? null, 'Fälligkeitsdatum');
  checkDate(d.paid_on ?? null, 'Bezahlt am');
  return { ...d, counterparty: who, purpose, due_on: d.due_on ?? null, paid_on: d.paid_on ?? null };
}
