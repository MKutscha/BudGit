import { invoke } from '@tauri-apps/api/core';
import type { Account, Debt, Deduction, Expense, Group, HouseholdInfo, Member, Snapshot, TemplateInfo } from '../api';

export const tauriApi = {
  list: () => invoke<HouseholdInfo[]>('list_households'),
  dataDir: () => invoke<string>('data_dir'),
  templates: () => invoke<TemplateInfo[]>('list_templates'),
  create: (name: string, members: Member[], template: string) =>
    invoke<Snapshot>('create_household', { name, members, template }),
  open: (id: string) => invoke<Snapshot>('open_household', { id }),
  close: () => invoke<void>('close_household'),
  remove: (id: string) => invoke<void>('delete_household', { id }),
  exportTo: (path: string) => invoke<void>('export_household', { path }),
  importFrom: (path: string) => invoke<Snapshot>('import_household', { path }),

  rename: (name: string) => invoke<Snapshot>('rename_household', { name }),
  saveMember: (member: Member) => invoke<Snapshot>('save_member', { member }),
  deleteMember: (id: number) => invoke<Snapshot>('delete_member', { id }),
  saveGroup: (group: Group) => invoke<Snapshot>('save_group', { group }),
  deleteGroup: (id: number) => invoke<Snapshot>('delete_group', { id }),
  saveDebt: (debt: Debt) => invoke<Snapshot>('save_debt', { debt }),
  deleteDebt: (id: number) => invoke<Snapshot>('delete_debt', { id }),
  saveAccount: (account: Account) => invoke<Snapshot>('save_account', { account }),
  deleteAccount: (id: number) => invoke<Snapshot>('delete_account', { id }),
  saveExpense: (expense: Expense) => invoke<Snapshot>('save_expense', { expense }),
  deleteExpense: (id: number) => invoke<Snapshot>('delete_expense', { id }),
  saveDeduction: (deduction: Deduction) => invoke<Snapshot>('save_deduction', { deduction }),
  deleteDeduction: (id: number) => invoke<Snapshot>('delete_deduction', { id }),

  undo: () => invoke<Snapshot>('undo'),
  redo: () => invoke<Snapshot>('redo'),
  /** Zeitpunkte der automatischen Sicherungen in Unix-Sekunden, neueste zuerst. */
  backups: () => invoke<number[]>('list_backups'),
  restoreBackup: (at: number) => invoke<Snapshot>('restore_backup', { at }),
};
