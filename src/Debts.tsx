import { useState, type FormEvent } from 'react';
import { api, need, type Debt, type Snapshot } from './api';
import { dueStatus, dueText, formatDate, todayIso, useToday } from './dates';
import { eur, parseCents } from './money';
import { DateField, DeleteButton, MoneyField, OptionalTextField, TextField, type Act } from './ui';

interface Props { snap: Snapshot; act: Act }

const KINDS: [Debt['kind'], string][] = [['receivable', 'Forderung'], ['payable', 'Schuld']];
const kindWord = (k: Debt['kind']) => (k === 'receivable' ? 'Forderung' : 'Schuld');
const whoLabel = (k: Debt['kind']) => (k === 'receivable' ? 'Schuldner' : 'Gläubiger');

/** Offene Einträge: nach Frist, Einträge ohne Frist zuletzt. */
const byDue = (a: Debt, b: Debt) =>
  (a.due_on ?? '9999-99-99').localeCompare(b.due_on ?? '9999-99-99') || a.id - b.id;

export function Debts({ snap, act }: Props) {
  const today = useToday();
  const open = snap.debts.filter(d => d.paid_on === null).sort(byDue);
  const done = snap.debts.filter(d => d.paid_on !== null)
    .sort((a, b) => (b.paid_on ?? '').localeCompare(a.paid_on ?? '') || b.id - a.id);

  const sum = (kind: Debt['kind']) => open.filter(d => d.kind === kind).reduce((s, d) => s + d.amount_cents, 0);
  const owedToUs = sum('receivable');
  const weOwe = sum('payable');
  const overdue = open.filter(d => dueStatus(d.due_on, today).kind === 'overdue').length;

  // Änderungen werden immer auf den neuesten Stand angewendet, nie auf veraltete Props.
  const patch = (id: number, p: Partial<Debt>) =>
    act(s => api.saveDebt({ ...need(s.debts.find(d => d.id === id), 'Der Eintrag'), ...p }));

  return (
    <>
      <header className="page-head">
        <h1>Schulden</h1>
        <p className="muted">
          Einmalige Beträge mit Frist, zum Beispiel nach einem Verkauf oder wenn du jemandem Geld ausgelegt hast.
          Eine <b>Forderung</b> heißt: jemand schuldet euch Geld. Eine <b>Schuld</b>: ihr schuldet jemandem Geld.
          Überfällige Einträge werden automatisch rot.
        </p>
      </header>

      {open.length > 0 && (
        <ul className="debt-sum" aria-label="Zusammenfassung der offenen Beträge">
          <li>Offene Forderungen <b>{eur(owedToUs)}</b></li>
          <li>Offene Schulden <b>{eur(weOwe)}</b></li>
          {overdue > 0 && <li className="neg"><b>{overdue}</b> {overdue === 1 ? 'Eintrag überfällig' : 'Einträge überfällig'}</li>}
        </ul>
      )}

      <section aria-label="Offene Einträge">
        <h2>Offen</h2>
        {open.length === 0 && (
          <p className="empty">Nichts offen. Trage unten eine Forderung oder Schuld ein.</p>
        )}
        {open.map(d => <OpenRow key={d.id} debt={d} today={today} act={act} patch={patch} />)}
        <AddDebt act={act} />
      </section>

      {done.length > 0 && (
        <section aria-label="Bezahlte Einträge">
          <details className="archive">
            <summary>Bezahlt und archiviert ({done.length})</summary>
            {done.map(d => (
              <div className="debt done" key={d.id}>
                <span className="muted">{kindWord(d.kind)}</span>
                <span className="cell-text"><b>{d.counterparty}</b>{d.purpose && <small className="muted"> {d.purpose}</small>}</span>
                <span className="num cell-text">{eur(d.amount_cents)}</span>
                <span className="muted small cell-text">bezahlt am {formatDate(d.paid_on!)}</span>
                <span className="debt-actions">
                  <button type="button" className="btn compact" onClick={() => patch(d.id, { paid_on: null })}>Wieder öffnen</button>
                  <DeleteButton label={`${kindWord(d.kind)} „${d.counterparty}“ löschen`}
                    onClick={() => act(() => api.deleteDebt(d.id))} />
                </span>
              </div>
            ))}
          </details>
        </section>
      )}
    </>
  );
}

function OpenRow({ debt: d, today, act, patch }: {
  debt: Debt; today: string; act: Act; patch: (id: number, p: Partial<Debt>) => Promise<boolean>;
}) {
  const status = dueStatus(d.due_on, today);
  return (
    <div className={`debt ${status.kind}`}>
      <select aria-label={`Art von ${d.counterparty}`} value={d.kind}
        onChange={ev => patch(d.id, { kind: ev.target.value as Debt['kind'] })}>
        {KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <TextField label={whoLabel(d.kind)} placeholder={whoLabel(d.kind)} value={d.counterparty}
        onCommit={counterparty => patch(d.id, { counterparty })} />
      <OptionalTextField label={`Verwendungszweck für ${d.counterparty}`} placeholder="Verwendungszweck" value={d.purpose}
        onCommit={purpose => patch(d.id, { purpose })} />
      <MoneyField label={`Betrag für ${d.counterparty}`} cents={d.amount_cents}
        onCommit={amount_cents => patch(d.id, { amount_cents })} />
      <div className="due">
        <DateField label={`Fälligkeitsdatum für ${d.counterparty}`} value={d.due_on}
          onCommit={due_on => patch(d.id, { due_on })} />
        <small>{dueText(status)}</small>
      </div>
      <span className="debt-actions">
        <button type="button" className="btn compact" onClick={() => patch(d.id, { paid_on: todayIso() })}
          title="In das Archiv verschieben">Bezahlt</button>
        <DeleteButton label={`${kindWord(d.kind)} „${d.counterparty}“ löschen`}
          onClick={() => act(() => api.deleteDebt(d.id))} />
      </span>
    </div>
  );
}

function AddDebt({ act }: { act: Act }) {
  const [kind, setKind] = useState<Debt['kind']>('receivable');
  const [who, setWho] = useState('');
  const [purpose, setPurpose] = useState('');
  const [amount, setAmount] = useState('');
  const [due, setDue] = useState('');

  const cents = parseCents(amount);
  const badAmount = amount.trim() !== '' && cents === null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (cents === null) return;
    const ok = await act(() => api.saveDebt({
      id: 0, kind, counterparty: who, purpose, amount_cents: cents, due_on: due === '' ? null : due, paid_on: null,
    }));
    if (ok) { setWho(''); setPurpose(''); setAmount(''); setDue(''); } // bei Fehlern bleibt die Eingabe stehen
  };

  return (
    <form className="debt-add" onSubmit={submit} aria-label="Neuer Eintrag">
      <select aria-label="Art" value={kind} onChange={e => setKind(e.target.value as Debt['kind'])}>
        {KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <input aria-label={whoLabel(kind)} placeholder={whoLabel(kind)} value={who} onChange={e => setWho(e.target.value)} />
      <input aria-label="Verwendungszweck" placeholder="Verwendungszweck" value={purpose} onChange={e => setPurpose(e.target.value)} />
      <input className="num" aria-label="Betrag in Euro" inputMode="decimal" placeholder="0,00 €" value={amount}
        aria-invalid={badAmount || undefined} onChange={e => setAmount(e.target.value)} />
      <label className="due-label">
        <span className="muted small">Fällig am</span>
        <input type="date" aria-label="Fälligkeitsdatum" min="1900-01-01" max="2200-12-31" value={due}
          onChange={e => setDue(e.target.value)} />
      </label>
      <button className="btn" type="submit">Hinzufügen</button>
    </form>
  );
}
