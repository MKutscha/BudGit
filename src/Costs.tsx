import { useEffect, useState } from 'react';
import { api, need, type Account, type Expense, type Group, type Member, type Snapshot } from './api';
import { bpToText, eur, toBasisPoints } from './money';
import { AddRow, DeleteButton, MoneyField, PercentField, TextField, confirmDelete, type Act } from './ui';

interface Props { snap: Snapshot; act: Act }

const PERIODS: [Expense['period'], string][] = [
  ['monthly', 'monatlich'], ['quarterly', 'vierteljährlich'], ['yearly', 'jährlich'],
];

/** Dezenter Hinweis unter dem Namen: wann der Posten fällig ist und was das pro Monat bedeutet. */
const periodHint = (e: Expense, monthlyCents: number): string | null => {
  if (e.period === 'monthly') return null;
  const when = e.period === 'quarterly' ? 'Fällig alle 3 Monate' : 'Fällig einmal im Jahr';
  return e.amount_cents > 0 ? `${when} · entspricht ${eur(monthlyCents)} pro Monat` : when;
};

const byMember = (members: Member[], bps: number[]): Record<number, number> =>
  Object.fromEntries(members.map((m, i) => [m.id, bps[i]]));

/** Startwerte für „individuell“: das aktuelle Einkommensverhältnis. */
const incomeWeights = (members: Member[]) => byMember(members, toBasisPoints(members.map(m => m.income_cents)));

export function Costs({ snap, act }: Props) {
  const monthly = new Map(snap.summary.lines.map(l => [l.expense_id, l.monthly_cents]));
  const [library, setLibrary] = useState<string[]>([]);

  useEffect(() => {
    api.templates()
      .then(t => setLibrary([...new Set(t.flatMap(x => x.groups.flatMap(g => g.items)))]))
      .catch(() => {}); // Vorschläge sind optional
  }, []);
  const used = new Set(snap.expenses.map(e => e.name.toLowerCase()));
  const suggestions = library.filter(n => !used.has(n.toLowerCase()));

  // Änderungen werden immer auf den neuesten Stand angewendet, nie auf veraltete Props.
  const patch = (id: number, p: Partial<Expense>) =>
    act(s => api.saveExpense({ ...need(s.expenses.find(e => e.id === id), 'Der Posten'), ...p }));
  const renameGroup = (id: number, name: string) =>
    act(s => api.saveGroup({ ...need(s.groups.find(g => g.id === id), 'Die Gruppe'), name }));

  const dropGroup = async (g: Group, count: number) => {
    if (count === 0 || await confirmDelete(`Gruppe „${g.name}“ mit ${count} Posten löschen?`)) {
      act(() => api.deleteGroup(g.id));
    }
  };

  const renameAccount = (id: number, name: string) =>
    act(s => api.saveAccount({ ...need(s.accounts.find(a => a.id === id), 'Das Konto'), name }));

  const dropAccount = async (a: Account, count: number) => {
    const text = `Konto „${a.name}“ löschen? Die ${count} zugeordneten Posten bleiben erhalten, haben dann aber kein Konto mehr.`;
    if (count === 0 || await confirmDelete(text)) act(() => api.deleteAccount(a.id));
  };

  const setSplit = (id: number, value: string) => {
    if (value === 'custom') {
      act(s => api.saveExpense({
        ...need(s.expenses.find(e => e.id === id), 'Der Posten'),
        split: 'custom', split_member: null, weights: incomeWeights(s.members),
      }));
    } else if (value.startsWith('only:')) {
      patch(id, { split: 'only', split_member: Number(value.slice(5)) });
    } else {
      patch(id, { split: value as Expense['split'], split_member: null });
    }
  };

  return (
    <>
      <header className="page-head">
        <h1>Kosten</h1>
        <p className="muted">
          Beträge in Euro. Vierteljährliche und jährliche Posten rechnen wir auf den Monat um.
          Änderungen werden automatisch gespeichert.
        </p>
      </header>

      {snap.groups.length === 0 && <p className="empty">Lege unten die erste Gruppe an, zum Beispiel „Wohnen“.</p>}

      {snap.groups.map(g => {
        const items = snap.expenses.filter(e => e.group_id === g.id);
        const sum = items.reduce((s, e) => s + (monthly.get(e.id) ?? 0), 0);
        return (
          <section className="block" key={g.id}>
            <div className="block-head">
              <TextField className="title-input" label="Gruppenname" value={g.name} onCommit={name => renameGroup(g.id, name)} />
              <span className="muted">{eur(sum)} pro Monat</span>
              <DeleteButton label={`Gruppe „${g.name}“ löschen`} onClick={() => dropGroup(g, items.length)} />
            </div>
            {items.map(e => (
              <div className="expense" key={e.id}>
                <div className={`erow${snap.accounts.length > 0 ? ' acc' : ''}${e.split === 'custom' ? ' open' : ''}`}>
                  <div className="namecell">
                    <TextField label="Bezeichnung" value={e.name} onCommit={name => patch(e.id, { name })} />
                    {periodHint(e, monthly.get(e.id) ?? 0) && (
                      <small className="hint">{periodHint(e, monthly.get(e.id) ?? 0)}</small>
                    )}
                  </div>
                  <MoneyField label={`Betrag für ${e.name}`} cents={e.amount_cents} onCommit={amount_cents => patch(e.id, { amount_cents })} />
                  <select aria-label={`Rhythmus für ${e.name}`} value={e.period}
                    className={e.period === 'monthly' ? undefined : 'special'}
                    onChange={ev => patch(e.id, { period: ev.target.value as Expense['period'] })}>
                    {PERIODS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                  <select aria-label={`Aufteilung für ${e.name}`}
                    value={e.split === 'only' ? `only:${e.split_member}` : e.split}
                    onChange={ev => setSplit(e.id, ev.target.value)}>
                    <option value="income">nach Einkommen</option>
                    <option value="equal">zu gleichen Teilen</option>
                    <option value="custom">individuell (Prozent)</option>
                    {snap.members.map(m => <option key={m.id} value={`only:${m.id}`}>nur {m.name}</option>)}
                  </select>
                  {snap.accounts.length > 0 && (
                    <select aria-label={`Konto für ${e.name}`} value={e.account_id ?? ''}
                      onChange={ev => patch(e.id, { account_id: ev.target.value === '' ? null : Number(ev.target.value) })}>
                      <option value="">kein Konto</option>
                      {snap.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  )}
                  <DeleteButton label={`${e.name} entfernen`} onClick={() => act(() => api.deleteExpense(e.id))} />
                </div>
                {e.split === 'custom' && <Weights expense={e} members={snap.members} act={act} />}
              </div>
            ))}
            <AddRow placeholder="Neuer Posten" suggestions={suggestions}
              onAdd={(name, amount_cents) => act(() => api.saveExpense({
                id: 0, group_id: g.id, name, amount_cents, period: 'monthly', split: 'income', split_member: null, weights: {}, account_id: null,
              }))} />
          </section>
        );
      })}

      <section className="block">
        <h2>Neue Gruppe</h2>
        <AddRow placeholder="Name der Gruppe" withAmount={false} onAdd={name => act(() => api.saveGroup({ id: 0, name }))} />
      </section>

      <section className="block" aria-label="Konten">
        <h2>Konten</h2>
        <p className="muted small">
          Über welches Bankkonto läuft welcher Posten? Lege hier Konten an, zum Beispiel „Gemeinschaftskonto“, und
          wähle sie oben bei den Posten aus.
        </p>
        {snap.accounts.map(a => {
          const items = snap.expenses.filter(e => e.account_id === a.id);
          const sum = items.reduce((s, e) => s + (monthly.get(e.id) ?? 0), 0);
          return (
            <div className="arow" key={a.id}>
              <TextField label="Kontoname" value={a.name} onCommit={name => renameAccount(a.id, name)} />
              <span className="muted small num">{items.length} Posten · {eur(sum)} pro Monat</span>
              <DeleteButton label={`Konto „${a.name}“ löschen`} onClick={() => dropAccount(a, items.length)} />
            </div>
          );
        })}
        <AddRow placeholder="Neues Konto" withAmount={false} onAdd={name => act(() => api.saveAccount({ id: 0, name }))} />
      </section>
    </>
  );
}

/** Prozentanteile je Person für einen Posten mit Aufteilung „individuell“. */
function Weights({ expense, members, act }: { expense: Expense; members: Member[]; act: Act }) {
  const sum = members.reduce((s, m) => s + (expense.weights[m.id] ?? 0), 0);

  const change = (next: (cur: Expense, s: Snapshot) => Record<number, number>) =>
    act(s => {
      const cur = need(s.expenses.find(x => x.id === expense.id), 'Der Posten');
      return api.saveExpense({ ...cur, weights: next(cur, s) });
    });

  // Bei genau zwei Personen ergänzt sich der zweite Anteil automatisch auf 100 %.
  const setOne = (memberId: number, bp: number) =>
    change((cur, s) => {
      const weights = { ...cur.weights, [memberId]: bp };
      if (s.members.length === 2) {
        const other = s.members.find(m => m.id !== memberId);
        if (other) weights[other.id] = 10000 - bp;
      }
      return weights;
    });

  const preset = (by: 'equal' | 'income') =>
    change((_, s) => byMember(s.members, toBasisPoints(s.members.map(m => (by === 'equal' ? 1 : m.income_cents)))));

  return (
    <div className="weights" role="group" aria-label={`Anteile für ${expense.name}`}>
      {members.map(m => (
        <div className="w-item" key={m.id}>
          <i className="dot" style={{ background: m.color }} />
          <span>{m.name}</span>
          <PercentField label={`Anteil von ${m.name} bei ${expense.name}`} bp={expense.weights[m.id] ?? 0}
            onCommit={bp => setOne(m.id, bp)} />
        </div>
      ))}
      <div className="w-foot">
        <span className={sum === 10000 ? 'muted small' : 'warn small'}>
          {sum === 10000 ? 'Summe 100 %' : `Summe ${bpToText(sum)} %, wird auf 100 % umgerechnet`}
        </span>
        <span className="w-presets">
          <button type="button" className="link" onClick={() => preset('equal')}>gleichmäßig</button>
          <button type="button" className="link" onClick={() => preset('income')}>nach Einkommen</button>
        </span>
      </div>
    </div>
  );
}
