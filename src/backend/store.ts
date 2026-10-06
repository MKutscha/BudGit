// Speicher im Browser: pro Haushalt ein Dokument in IndexedDB, bei jeder Änderung ein einziger Schreibvorgang.
import { createStore, del, entries, get, set } from 'idb-keyval';
import type { Account, Debt, Deduction, Expense, Group, Member } from '../api';

/** Exakt das .budgit-Format (format: 1). */
export interface Backup {
  format: 1;
  name: string;
  members: Member[];
  groups: Group[];
  accounts: Account[];
  expenses: Expense[];
  deductions: Deduction[];
  debts: Debt[];
}

export interface Doc {
  id: string;
  /** Version des Browser-Speichers (für spätere Migrationen) */
  schema: 1;
  data: Backup;
  /** ein globaler Zähler genügt, IDs müssen nur je Tabelle eindeutig sein */
  nextId: number;
  updatedAt: number;
  lastExportAt: number | null;
  /** Änderungen seit dem letzten Export (für die Export-Erinnerung) */
  changes: number;
}

const store = createStore('budgit', 'households');

export const saveDoc = (doc: Doc) => set(doc.id, doc, store);
export const deleteDoc = (id: string) => del(id, store);

export async function listDocs(): Promise<Doc[]> {
  const all = await entries<string, Doc>(store);
  return all.map(([, d]) => d).filter(d => d && d.schema === 1).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadDoc(id: string): Promise<Doc | undefined> {
  const d = await get<Doc>(id, store);
  return d && d.schema === 1 ? d : undefined;
}
