// Port von src-tauri/src/split.rs. Alle Beträge sind ganze Cent, die Anteile ergeben immer exakt die Summe.
// Muss auf den Cent genauso rechnen wie die Rust-Version (Largest-Remainder).
import type { Deduction, Expense, Member, Summary } from '../api';

/** Largest-Remainder-Verfahren. Sind alle Gewichte 0, wird gleich verteilt. */
export function allocate(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  let w = weights.map(x => BigInt(Math.max(0, Math.trunc(x))));
  if (w.every(x => x === 0n)) w = w.map(() => 1n);
  const sum = w.reduce((a, b) => a + b, 0n);
  const T = BigInt(total);
  const out = w.map(wi => (T * wi) / sum);
  const rest = w
    .map((wi, i) => ({ i, r: (T * wi) % sum }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1)); // größter Rest zuerst, bei Gleichstand kleinerer Index
  let left = Number(T - out.reduce((a, b) => a + b, 0n));
  for (const { i } of rest) {
    if (left <= 0) break;
    out[i] += 1n;
    left--;
  }
  return out.map(Number);
}

const divRound = (a: number, d: number) => Math.floor((a + Math.floor(d / 2)) / d);

export function monthlyCents(amount: number, period: string): number {
  return period === 'quarterly' ? divRound(amount, 3) : period === 'yearly' ? divRound(amount, 12) : amount;
}

export function compute(members: Member[], expenses: Expense[], deductions: Deduction[]): Summary {
  const incomes = members.map(m => m.income_cents);
  const equal = members.map(() => 1);
  const totals = members.map(() => 0);
  const lines: Summary['lines'] = [];
  let total = 0;

  for (const e of expenses) {
    const monthly = monthlyCents(e.amount_cents, e.period);
    const onlyIdx = e.split === 'only' && e.split_member !== null
      ? members.findIndex(m => m.id === e.split_member)
      : -1;
    let shares: number[];
    if (onlyIdx >= 0) {
      shares = members.map(() => 0);
      shares[onlyIdx] = monthly;
    } else if (e.split === 'equal') {
      shares = allocate(monthly, equal);
    } else if (e.split === 'custom') {
      shares = allocate(monthly, members.map(m => e.weights[m.id] ?? 0));
    } else {
      // 'income' – und 'only' mit nicht (mehr) vorhandener Person fällt ebenfalls hierher, wie in Rust
      shares = allocate(monthly, incomes);
    }
    shares.forEach((s, i) => { totals[i] += s; });
    total += monthly;
    lines.push({ expense_id: e.id, monthly_cents: monthly, shares });
  }

  return {
    total_cents: total,
    lines,
    members: members.map((m, i) => {
      const ded = deductions.filter(d => d.member_id === m.id).reduce((a, d) => a + d.amount_cents, 0);
      return { member_id: m.id, share_cents: totals[i], deductions_cents: ded, free_cents: m.income_cents - totals[i] - ded };
    }),
  };
}
