import type { Snapshot } from './api';
import { countOverdue, useToday } from './dates';
import { eur } from './money';
import { AccountTable, LedgerTable, LeftoverTable } from './Tables';
import type { View } from './ui';

export function Overview({ snap, go }: { snap: Snapshot; go: (v: View) => void }) {
  const { members, summary } = snap;
  const total = summary.total_cents;
  const overdue = countOverdue(snap.debts, useToday());

  return (
    <>
      <header className="page-head page-head-row">
        <div>
          <h1>Übersicht</h1>
          <p className="muted">Monatliche Fixkosten und wer welchen Anteil trägt.</p>
        </div>
        {total > 0 && <button className="btn no-print" onClick={() => go('report')}>Druckansicht / PDF</button>}
      </header>

      {overdue > 0 && (
        <p className="alert no-print" role="status">
          <b>{overdue === 1 ? '1 überfälliger Eintrag' : `${overdue} überfällige Einträge`}</b> bei den Schulden.{' '}
          <button className="link" onClick={() => go('debts')}>Ansehen</button>
        </p>
      )}

      {total === 0 ? (
        <p className="empty">
          Noch keine Kosten eingetragen. Trage unter <button className="link" onClick={() => go('costs')}>Kosten</button> die
          Beträge ein und unter <button className="link" onClick={() => go('people')}>Personen</button> das Netto-Einkommen.
        </p>
      ) : (
        <section aria-label="Verteilung der Kosten">
          <div className="total">
            <span className="total-num">{eur(total)}</span>
            <span className="muted"> Fixkosten pro Monat</span>
          </div>
          <div className="bar" role="img"
            aria-label={members.map((m, i) => `${m.name} ${eur(summary.members[i].share_cents)}`).join(', ')}>
            {members.map((m, i) => (
              <span key={m.id} style={{ flexGrow: summary.members[i].share_cents, background: m.color }} />
            ))}
          </div>
          <ul className="legend">
            {members.map((m, i) => (
              <li key={m.id}>
                <i className="dot" style={{ background: m.color }} />
                {m.name} <b>{eur(summary.members[i].share_cents)}</b>
                <span className="muted"> {Math.round((summary.members[i].share_cents / total) * 100)} %</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {total > 0 && (
        <section>
          <h2>Wer zahlt was</h2>
          <LedgerTable snap={snap} compact />
        </section>
      )}

      {total > 0 && snap.expenses.some(e => e.account_id != null) && (
        <section>
          <h2>Fixkosten pro Konto</h2>
          <AccountTable snap={snap} />
        </section>
      )}

      <section>
        <h2>Was übrig bleibt</h2>
        <LeftoverTable snap={snap} compact />
      </section>
    </>
  );
}