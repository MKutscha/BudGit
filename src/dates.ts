import { useEffect, useState } from 'react';
import type { Debt } from './api';

const pad = (n: number) => String(n).padStart(2, '0');

/** Heutiges Datum im lokalen Kalender als „JJJJ-MM-TT“. */
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const utcDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Ganze Tage von `from` bis `to` (positiv = `to` liegt später). Unabhängig von Sommerzeit. */
export const daysBetween = (from: string, to: string) => Math.round((utcDay(to) - utcDay(from)) / 86_400_000);

/** „2026-10-31“ -> „31.10.2026“ */
export const formatDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

/**
 * „Heute“ als Zustand: Bleibt die App über Mitternacht geöffnet, wechseln überfällige Einträge
 * von selbst auf Rot, ohne dass man etwas anklicken muss.
 */
export function useToday(): string {
  const [today, setToday] = useState(todayIso);
  useEffect(() => {
    const refresh = () => setToday(todayIso());
    const timer = setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  return today;
}

export type DueKind = 'none' | 'ok' | 'soon' | 'today' | 'overdue';
export interface Due { kind: DueKind; days: number }

/** Fristen-Status eines offenen Eintrags. „soon“ = innerhalb der nächsten 7 Tage. */
export function dueStatus(due: string | null, today: string): Due {
  if (!due) return { kind: 'none', days: 0 };
  const diff = daysBetween(today, due);
  if (diff < 0) return { kind: 'overdue', days: -diff };
  if (diff === 0) return { kind: 'today', days: 0 };
  return { kind: diff <= 7 ? 'soon' : 'ok', days: diff };
}

const tage = (n: number) => `${n} ${n === 1 ? 'Tag' : 'Tagen'}`;

export function dueText(s: Due): string {
  switch (s.kind) {
    case 'overdue': return `überfällig seit ${tage(s.days)}`;
    case 'today': return 'heute fällig';
    case 'soon':
    case 'ok': return `fällig in ${tage(s.days)}`;
    default: return 'ohne Frist';
  }
}

/** Offene Einträge mit überschrittener Frist. */
export const countOverdue = (debts: Debt[], today: string) =>
  debts.filter(d => d.paid_on === null && d.due_on !== null && d.due_on < today).length;
