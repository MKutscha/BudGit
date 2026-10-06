// Die Unit-Tests aus src-tauri/src/split.rs, 1:1 übertragen.
import { describe, expect, it } from 'vitest';
import { allocate, compute, monthlyCents } from '../src/backend/split';
import type { Deduction, Expense, Member } from '../src/api';

const member = (id: number, income: number): Member => ({ id, name: `P${id}`, color: '#000000', income_cents: income });
const expense = (id: number, amount: number, period: string, split: string, only: number | null = null): Expense => ({
  id, group_id: 1, name: 'x', amount_cents: amount, period: period as Expense['period'],
  split: split as Expense['split'], split_member: only, weights: {}, account_id: null,
});
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('split', () => {
  it('shares_always_sum_to_total', () => {
    for (const total of [0, 1, 7, 100, 999, 82500, 1_000_003]) {
      expect(sum(allocate(total, [210_000, 190_000, 57_777]))).toBe(total);
    }
  });
  it('proportional_to_income', () => expect(allocate(1000, [3000, 1000])).toEqual([750, 250]));
  it('zero_income_falls_back_to_equal', () => expect(allocate(1001, [0, 0])).toEqual([501, 500]));
  it('yearly_and_quarterly_become_monthly', () => {
    expect(monthlyCents(12_000, 'yearly')).toBe(1_000);
    expect(monthlyCents(3_000, 'quarterly')).toBe(1_000);
    expect(monthlyCents(500, 'monthly')).toBe(500);
  });
  it('split_modes', () => {
    const ms = [member(1, 3000), member(2, 1000)];
    const es = [
      expense(1, 1000, 'monthly', 'income'),
      expense(2, 1000, 'monthly', 'equal'),
      expense(3, 1000, 'monthly', 'only', 2),
    ];
    const s = compute(ms, es, []);
    expect(s.lines[0].shares).toEqual([750, 250]);
    expect(s.lines[1].shares).toEqual([500, 500]);
    expect(s.lines[2].shares).toEqual([0, 1000]);
    expect(s.total_cents).toBe(3000);
    expect(s.members[0].share_cents).toBe(1250);
    expect(s.members[1].share_cents).toBe(1750);
    expect(s.members[0].free_cents).toBe(3000 - 1250);
  });
  it('custom_weights_split_exactly', () => {
    const ms = [member(1, 1000), member(2, 1000), member(3, 1000)];
    const e = expense(1, 10_000, 'monthly', 'custom');
    e.weights = { 1: 5000, 2: 3000, 3: 2000 };
    expect(compute(ms, [e], []).lines[0].shares).toEqual([5000, 3000, 2000]);
    e.amount_cents = 1000;
    e.weights = { 1: 3333, 2: 3333, 3: 3334 };
    expect(sum(compute(ms, [e], []).lines[0].shares)).toBe(1000);
    e.weights = { 1: 1000, 2: 3000 };
    expect(compute(ms, [e], []).lines[0].shares).toEqual([250, 750, 0]);
  });
  it('custom_without_any_weight_falls_back_to_equal', () => {
    const ms = [member(1, 100), member(2, 900)];
    expect(compute(ms, [expense(1, 1000, 'monthly', 'custom')], []).lines[0].shares).toEqual([500, 500]);
  });
  it('deductions_reduce_free_money', () => {
    const d: Deduction[] = [{ id: 1, member_id: 1, name: 'Gym', amount_cents: 3_000 }];
    expect(compute([member(1, 200_000)], [], d).members[0].free_cents).toBe(197_000);
  });
  // Zusatz: Betrag × Gewicht überschreitet 2^53 – hier würde reines number falsch rechnen
  it('big_numbers_stay_exact', () => {
    const parts = allocate(900_000_000_000, [9_000_000_000_000, 1_000_000_000_000]);
    expect(parts).toEqual([810_000_000_000, 90_000_000_000]);
  });
  it('only_with_missing_person_falls_back_to_income', () => {
    const ms = [member(1, 3000), member(2, 1000)];
    expect(compute(ms, [expense(1, 1000, 'monthly', 'only', 99)], []).lines[0].shares).toEqual([750, 250]);
  });
});
