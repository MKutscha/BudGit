import { useState } from 'react';
import type { Snapshot } from './api';
import { eur } from './money';
import { printHint } from './platform';
import { AccountTable, LedgerTable, LeftoverTable } from './Tables';

const percent = (part: number, whole: number) =>
  `${((part / whole) * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;

/**
 * Druckansicht: ein A4-Blatt mit der Aufstellung, zum Ausdrucken oder (über den Druckdialog)
 * als PDF zu speichern, z. B. für Vermieter, WG-Akte oder Steuer.
 * Netto-Einkommen und Rest sind privat und werden nur auf Wunsch mit ausgegeben.
 */
export function Report({ snap, onBack }: { snap: Snapshot; onBack: () => void }) {
  const [personal, setPersonal] = useState(false);
  const [withAccounts, setWithAccounts] = useState(true);
  const { members, summary } = snap;
  const total = summary.total_cents;
  const today = new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  const hasAccounts = snap.expenses.some(e => e.account_id != null);

  return (
    <>
      <div className="report-bar no-print">
        <button className="link" onClick={onBack}>← Zurück zur Übersicht</button>
        <label className="check">
          <input type="checkbox" checked={personal} onChange={e => setPersonal(e.target.checked)} />
          Netto-Einkommen und Rest mit ausgeben
        </label>
        <label className="check">
          <input type="checkbox" checked={withAccounts} onChange={e => setWithAccounts(e.target.checked)} />
          Konten mit ausgeben
        </label>
        <button className="btn primary" onClick={() => window.print()}>Drucken / als PDF speichern</button>
      </div>
      <p className="muted small no-print">{printHint}</p>

      <article className="paper">
        <header className="paper-head">
          <div>
            <span className="paper-brand">BudGit</span>
            <h1>Fixkosten-Aufstellung</h1>
            <p className="paper-sub">{snap.name}</p>
          </div>
          <dl className="paper-meta">
            <dt>Stand</dt><dd>{today}</dd>
            <dt>Personen</dt><dd>{members.map(m => m.name).join(', ')}</dd>
          </dl>
        </header>

        {total === 0 ? (
          <p className="empty">Noch keine Kosten eingetragen.</p>
        ) : (
          <>
            <section aria-label="Gesamtkosten">
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
            </section>

            <section>
              <h2>Anteile pro Person</h2>
              <table className="ledger">
                <thead>
                  <tr><th>Person</th><th className="num">Anteil pro Monat</th><th className="num">Anteil</th></tr>
                </thead>
                <tbody>
                  {members.map((m, i) => (
                    <tr key={m.id}>
                      <td><i className="dot" style={{ background: m.color }} />{m.name}</td>
                      <td className="num strong">{eur(summary.members[i].share_cents)}</td>
                      <td className="num">{percent(summary.members[i].share_cents, total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h2>Posten im Detail</h2>
              <LedgerTable snap={snap} showAccounts={withAccounts} />
            </section>

            {withAccounts && hasAccounts && (
              <section>
                <h2>Fixkosten pro Konto</h2>
                <AccountTable snap={snap} />
              </section>
            )}
          </>
        )}

        {personal && (
          <section>
            <h2>Einkommen und Rest</h2>
            <LeftoverTable snap={snap} />
          </section>
        )}

        <footer className="paper-foot">
          Beträge in Euro pro Monat. Vierteljährliche und jährliche Posten sind auf den Monat umgerechnet.
          Erstellt mit BudGit am {today}.
        </footer>
      </article>
    </>
  );
}
