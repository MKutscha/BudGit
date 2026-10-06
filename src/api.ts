import { tauriApi } from './backend/tauri';
import { webApi } from './backend/web';

export type Period = 'monthly' | 'quarterly' | 'yearly';
export type SplitMode = 'income' | 'equal' | 'only' | 'custom';

export interface Member { id: number; name: string; color: string; income_cents: number }
export interface Group { id: number; name: string }
/** Bankkonto, über das Posten abgerechnet werden. */
export interface Account { id: number; name: string }
export interface Expense {
  id: number; group_id: number; name: string; amount_cents: number;
  period: Period; split: SplitMode; split_member: number | null;
  /** nur bei 'custom': Person-ID -> Anteil in Hundertstel-Prozent (6000 = 60 %) */
  weights: Record<number, number>;
  /** Konto, über das der Posten läuft; null = keins zugeordnet */
  account_id: number | null;
}
/**
 * Einmaliger Betrag mit Frist. receivable = Forderung (jemand schuldet uns), payable = Schuld (wir schulden jemandem).
 * Daten als „JJJJ-MM-TT“; paid_on gesetzt = bezahlt (Archiv).
 */
export interface Debt {
  id: number; kind: 'receivable' | 'payable'; counterparty: string; purpose: string;
  amount_cents: number; due_on: string | null; paid_on: string | null;
}
export interface Deduction { id: number; member_id: number; name: string; amount_cents: number }

export interface Line { expense_id: number; monthly_cents: number; shares: number[] }
export interface MemberSum { member_id: number; share_cents: number; deductions_cents: number; free_cents: number }
export interface Summary { total_cents: number; lines: Line[]; members: MemberSum[] }

/** Beschreibung des nächsten Schritts für Rückgängig / Wiederholen; null = nicht möglich. */
export interface History { undo: string | null; redo: string | null }

export interface Snapshot {
  id: string; name: string;
  members: Member[]; groups: Group[]; accounts: Account[]; expenses: Expense[]; deductions: Deduction[]; debts: Debt[];
  summary: Summary; history: History;
}
export interface HouseholdInfo { id: string; name: string; members: string[] }
export interface TemplateInfo {
  id: string; name: string; description: string;
  groups: { name: string; items: string[] }[];
}

/** Beide Backends haben dieselbe Form; welches gebaut wird, entscheidet der Build-Modus. */
export type Api = typeof tauriApi;
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const api: Api = import.meta.env.VITE_TARGET === 'web' || !inTauri ? webApi : tauriApi;

// ---------- Fehler ----------

/** Das Backend liefert Fehler als { kind: "warning" | "error", message }. */
export interface Problem { level: 'warning' | 'error'; message: string }

export function toProblem(e: unknown): Problem {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const { kind, message } = e as { kind?: string; message?: unknown };
    return { level: kind === 'warning' ? 'warning' : 'error', message: String(message) };
  }
  if (typeof e === 'string') return { level: 'error', message: e };
  return { level: 'error', message: 'Unerwarteter Fehler. Starte BudGit neu, falls das Problem bleibt.' };
}

/** Findet einen Eintrag im aktuellen Zustand oder meldet verständlich, dass er fehlt. */
export function need<T>(item: T | undefined, what: string): T {
  if (item === undefined) throw { kind: 'warning', message: `${what} existiert nicht mehr.` };
  return item;
}
