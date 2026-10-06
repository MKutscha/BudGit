import type { Expense, Member, Snapshot } from './api';
import { eur } from './money';

const minus = (c: number) => (c > 0 ? `− ${eur(c)}` : eur(0));

/** „vierteljährlich · 150,00 € je Zahlung“, damit Sonderzahlungen sofort auffallen. */
const payment = (e: Expense) => {
  if (e.period === 'monthly') return '';
  const name = e.period === 'quarterly' ? 'vierteljährlich' : 'jährlich';
  return e.amount_cents > 0 ? `${name} · ${eur(e.amount_cents)} je Zahlung` : name;
};

const how = (e: Expense, members: Member[]) => {
  const parts: string[] = [];
  if (e.split === 'equal') parts.push('zu gleichen Teilen');
  if (e.split === 'custom') {
    const w = members.map(m => e.weights[m.id] ?? 0);
    const sum = w.reduce((a, b) => a + b, 0) || 1;
    parts.push(`individuell ${w.map(x => Math.round((x / sum) * 100)).join(' / ')} %`);
  }
  if (e.split === 'only') {
    const m = members.find(x => x.id === e.split_member);
    if (m) parts.push(`nur ${m.name}`);
  }
  return parts.join(', ');
};

/** „Wer zahlt was“: alle Posten nach Gruppen, mit Anteil je Person. Wird in Übersicht und Druckansicht genutzt. */
export function LedgerTable({ snap, showAccounts = true, compact = false }:{ snap: Snapshot; showAccounts?: boolean; compact?: boolean }) {
  const { members, groups, expenses, accounts, summary } = snap;
  const line = new Map(summary.lines.map(l => [l.expense_id, l]));
  const accountName = new Map(accounts.map(a => [a.id, a.name]));
  const cols = 2 + members.length;

  return (
    <div className="scroll">
      <table className={`ledger${compact ? ' compact' : ''}`}>
        <thead>
          <tr>
            <th>Posten</th>
            <th className="num">Pro Monat</th>
            {members.map(m => (
              <th className="num" key={m.id}><i className="dot" style={{ background: m.color }} />{m.name}</th>
            ))}
          </tr>
        </thead>
        {groups.map(g => {
          const items = expenses.filter(e => e.group_id === g.id);
          if (items.length === 0) return null;
          const lines = items.map(e => line.get(e.id)!);
          return (
            <tbody key={g.id}>
              <tr className="grp"><th colSpan={cols}>{g.name}</th></tr>
              {items.map((e, k) => (
                <tr key={e.id}>
                  <td>
                    {e.name}
                    {showAccounts && e.account_id != null && accountName.has(e.account_id) && (
                      <span className="badge">{accountName.get(e.account_id)}</span>
                    )}
                    {(payment(e) || how(e, members)) && (
                      <small className="sub-line muted">{[payment(e), how(e, members)].filter(Boolean).join(' · ')}</small>
                    )}
                  </td>
                  <td className="num">{eur(lines[k].monthly_cents)}</td>
                  {members.map((m, i) => <td className="num" key={m.id}>{eur(lines[k].shares[i])}</td>)}
                </tr>
              ))}
              <tr className="sub">
                <td>Summe {g.name}</td>
                <td className="num">{eur(lines.reduce((s, l) => s + l.monthly_cents, 0))}</td>
                {members.map((m, i) => <td className="num" key={m.id}>{eur(lines.reduce((s, l) => s + l.shares[i], 0))}</td>)}
              </tr>
            </tbody>
          );
        })}
        <tfoot>
          <tr className="grand">
            <td>Gesamt</td>
            <td className="num">{eur(summary.total_cents)}</td>
            {members.map((m, i) => <td className="num" key={m.id}>{eur(summary.members[i].share_cents)}</td>)}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** „Was übrig bleibt“: Netto, Fixkosten-Anteil und eigene Abzüge je Person. */
export function LeftoverTable({ snap, compact = false }: { snap: Snapshot; compact?: boolean }) {
  const { members, summary } = snap;
  return (
    <div className="scroll">
      <table className={`ledger${compact ? ' stack' : ''}`}>  
        <thead>
          <tr>
            <th>Person</th><th className="num">Netto</th><th className="num">Fixkosten-Anteil</th>
            <th className="num">Eigene Abzüge</th><th className="num">Bleibt</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m, i) => {
            const s = summary.members[i];
            return (
              <tr key={m.id}>
                <td><i className="dot" style={{ background: m.color }} />{m.name}</td>
                <td className="num" data-label="Netto">{eur(m.income_cents)}</td>
                <td className="num" data-label="Fixkosten-Anteil">{minus(s.share_cents)}</td>
                <td className="num" data-label="Eigene Abzüge">{minus(s.deductions_cents)}</td>
                <td className={`num strong${s.free_cents < 0 ? ' neg' : ''}`} data-label="Bleibt">{eur(s.free_cents)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** „Fixkosten pro Konto“: welche monatlichen Kosten von welchem Bankkonto abgehen. */
export function AccountTable({ snap }: { snap: Snapshot }) {
  const { accounts, expenses, summary } = snap;
  const monthly = new Map(summary.lines.map(l => [l.expense_id, l.monthly_cents]));
  const rows = [
    ...accounts.map(a => ({ key: String(a.id), name: a.name, items: expenses.filter(e => e.account_id === a.id) })),
    { key: 'none', name: 'Ohne Konto', items: expenses.filter(e => e.account_id == null && (monthly.get(e.id) ?? 0) > 0) },
  ]
    .map(r => ({ ...r, sum: r.items.reduce((s, e) => s + (monthly.get(e.id) ?? 0), 0) }))
    .filter(r => r.items.length > 0);

  return (
    <div className="scroll">
      <table className="ledger">
        <thead>
          <tr><th>Konto</th><th className="num">Pro Monat</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key}>
              <td>
                <span className={r.key === 'none' ? 'muted' : undefined}>{r.name}</span>
                <small className="muted"> {r.items.map(e => e.name).join(', ')}</small>
              </td>
              <td className="num">{eur(r.sum)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="grand">
            <td>Gesamt</td>
            <td className="num">{eur(summary.total_cents)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
