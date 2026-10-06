//! Verteil-Engine: reine Funktionen, keine Datenbank, keine UI.
//! Alle Beträge sind ganze Cent; die Anteile ergeben immer exakt die Summe.

use crate::model::*;

/// Largest-Remainder-Verfahren. Sind alle Gewichte 0, wird gleich verteilt.
pub fn allocate(total: i64, weights: &[i64]) -> Vec<i64> {
    let n = weights.len();
    if n == 0 {
        return vec![];
    }
    let mut w: Vec<i64> = weights.iter().map(|x| (*x).max(0)).collect();
    if w.iter().sum::<i64>() == 0 {
        w = vec![1; n];
    }
    let sum: i128 = w.iter().map(|x| *x as i128).sum();

    let mut out = Vec::with_capacity(n);
    let mut rest: Vec<(usize, i128)> = Vec::with_capacity(n);
    let mut used = 0i64;
    for (i, wi) in w.iter().enumerate() {
        let num = total as i128 * *wi as i128;
        let q = (num / sum) as i64;
        out.push(q);
        used += q;
        rest.push((i, num % sum));
    }
    rest.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut left = total - used;
    for (i, _) in rest {
        if left <= 0 {
            break;
        }
        out[i] += 1;
        left -= 1;
    }
    out
}

fn div_round(a: i64, d: i64) -> i64 {
    (a + d / 2) / d
}

pub fn monthly_cents(amount: i64, period: &str) -> i64 {
    match period {
        "quarterly" => div_round(amount, 3),
        "yearly" => div_round(amount, 12),
        _ => amount,
    }
}

pub fn compute(members: &[Member], expenses: &[Expense], deductions: &[Deduction]) -> Summary {
    let incomes: Vec<i64> = members.iter().map(|m| m.income_cents).collect();
    let equal = vec![1i64; members.len()];
    let mut totals = vec![0i64; members.len()];
    let mut lines = Vec::with_capacity(expenses.len());
    let mut total = 0i64;

    for e in expenses {
        let monthly = monthly_cents(e.amount_cents, &e.period);
        let only_idx = if e.split == "only" {
            e.split_member
                .and_then(|id| members.iter().position(|m| m.id == id))
        } else {
            None
        };
        let shares = if let Some(i) = only_idx {
            let mut v = vec![0; members.len()];
            v[i] = monthly;
            v
        } else if e.split == "equal" {
            allocate(monthly, &equal)
        } else if e.split == "custom" {
            let w: Vec<i64> = members.iter().map(|m| e.weights.get(&m.id).copied().unwrap_or(0)).collect();
            allocate(monthly, &w)
        } else {
            allocate(monthly, &incomes)
        };
        for (t, s) in totals.iter_mut().zip(&shares) {
            *t += s;
        }
        total += monthly;
        lines.push(Line { expense_id: e.id, monthly_cents: monthly, shares });
    }

    let members = members
        .iter()
        .zip(totals)
        .map(|(m, share)| {
            let ded: i64 = deductions
                .iter()
                .filter(|d| d.member_id == m.id)
                .map(|d| d.amount_cents)
                .sum();
            MemberSum {
                member_id: m.id,
                share_cents: share,
                deductions_cents: ded,
                free_cents: m.income_cents - share - ded,
            }
        })
        .collect();

    Summary { total_cents: total, lines, members }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: i64, income: i64) -> Member {
        Member { id, name: format!("P{id}"), color: "#000000".into(), income_cents: income }
    }
    fn expense(id: i64, amount: i64, period: &str, split: &str, only: Option<i64>) -> Expense {
        Expense {
            id, group_id: 1, name: "x".into(), amount_cents: amount,
            period: period.into(), split: split.into(), split_member: only,
            weights: Default::default(), account_id: None,
        }
    }

    #[test]
    fn shares_always_sum_to_total() {
        for total in [0, 1, 7, 100, 999, 82500, 1_000_003] {
            let parts = allocate(total, &[210_000, 190_000, 57_777]);
            assert_eq!(parts.iter().sum::<i64>(), total);
        }
    }

    #[test]
    fn proportional_to_income() {
        assert_eq!(allocate(1000, &[3000, 1000]), vec![750, 250]);
    }

    #[test]
    fn zero_income_falls_back_to_equal() {
        assert_eq!(allocate(1001, &[0, 0]), vec![501, 500]);
    }

    #[test]
    fn yearly_and_quarterly_become_monthly() {
        assert_eq!(monthly_cents(12_000, "yearly"), 1_000);
        assert_eq!(monthly_cents(3_000, "quarterly"), 1_000);
        assert_eq!(monthly_cents(500, "monthly"), 500);
    }

    #[test]
    fn split_modes() {
        let ms = [member(1, 3000), member(2, 1000)];
        let es = [
            expense(1, 1000, "monthly", "income", None),
            expense(2, 1000, "monthly", "equal", None),
            expense(3, 1000, "monthly", "only", Some(2)),
        ];
        let s = compute(&ms, &es, &[]);
        assert_eq!(s.lines[0].shares, vec![750, 250]);
        assert_eq!(s.lines[1].shares, vec![500, 500]);
        assert_eq!(s.lines[2].shares, vec![0, 1000]);
        assert_eq!(s.total_cents, 3000);
        assert_eq!(s.members[0].share_cents, 1250);
        assert_eq!(s.members[1].share_cents, 1750);
        assert_eq!(s.members[0].free_cents, 3000 - 1250);
    }

    #[test]
    fn custom_weights_split_exactly() {
        let ms = [member(1, 1000), member(2, 1000), member(3, 1000)];
        let mut e = expense(1, 10_000, "monthly", "custom", None);
        e.weights = [(1, 5000), (2, 3000), (3, 2000)].into_iter().collect();
        let s = compute(&ms, &[e.clone()], &[]);
        assert_eq!(s.lines[0].shares, vec![5000, 3000, 2000]);

        // Drittel-Verteilung: Summe bleibt auf den Cent exakt
        e.amount_cents = 1000;
        e.weights = [(1, 3333), (2, 3333), (3, 3334)].into_iter().collect();
        let s = compute(&ms, &[e.clone()], &[]);
        assert_eq!(s.lines[0].shares.iter().sum::<i64>(), 1000);

        // Gewichte müssen nicht 100 % ergeben: sie werden relativ gerechnet; fehlende Person = 0
        e.weights = [(1, 1000), (2, 3000)].into_iter().collect();
        let s = compute(&ms, &[e], &[]);
        assert_eq!(s.lines[0].shares, vec![250, 750, 0]);
    }

    #[test]
    fn custom_without_any_weight_falls_back_to_equal() {
        let ms = [member(1, 100), member(2, 900)];
        let e = expense(1, 1000, "monthly", "custom", None);
        assert_eq!(compute(&ms, &[e], &[]).lines[0].shares, vec![500, 500]);
    }

    #[test]
    fn deductions_reduce_free_money() {
        let ms = [member(1, 200_000)];
        let d = [Deduction { id: 1, member_id: 1, name: "Gym".into(), amount_cents: 3_000 }];
        let s = compute(&ms, &[], &d);
        assert_eq!(s.members[0].free_cents, 197_000);
    }
}
