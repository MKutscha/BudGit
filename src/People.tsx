import { api, need, type Deduction, type Member, type Snapshot } from './api';
import { eur } from './money';
import { AddRow, DeleteButton, MoneyField, Swatches, TextField, confirmDelete, nextColor, type Act } from './ui';

interface Props { snap: Snapshot; act: Act }

export function People({ snap, act }: Props) {
  const patchMember = (id: number, p: Partial<Member>) =>
    act(s => api.saveMember({ ...need(s.members.find(m => m.id === id), 'Die Person'), ...p }));
  const patchDeduction = (id: number, p: Partial<Deduction>) =>
    act(s => api.saveDeduction({ ...need(s.deductions.find(d => d.id === id), 'Der Abzug'), ...p }));

  const drop = async (m: Member) => {
    if (await confirmDelete(`${m.name} mit allen eigenen Abzügen entfernen?`)) act(() => api.deleteMember(m.id));
  };

  const add = () =>
    act(s => api.saveMember({
      id: 0, name: `Person ${s.members.length + 1}`, income_cents: 0,
      color: nextColor(s.members.map(m => m.color)),
    }));

  return (
    <>
      <header className="page-head">
        <h1>Personen</h1>
        <p className="muted">Wer sich die Kosten teilt. Das Netto-Einkommen bestimmt den Anteil bei „nach Einkommen“.</p>
      </header>

      {snap.members.map(m => {
        const mine = snap.deductions.filter(d => d.member_id === m.id);
        return (
          <section className="block" key={m.id}>
            <div className="block-head">
              <i className="dot big" style={{ background: m.color }} />
              <TextField className="title-input" label="Name" value={m.name} onCommit={name => patchMember(m.id, { name })} />
              {snap.members.length > 1 && (
                <DeleteButton className="push" label={`${m.name} entfernen`} onClick={() => drop(m)} />
              )}
            </div>

            <div className="field-row">
              <label>Netto pro Monat</label>
              <MoneyField label={`Netto-Einkommen von ${m.name}`} cents={m.income_cents}
                onCommit={income_cents => patchMember(m.id, { income_cents })} />
              <Swatches value={m.color} label={`Farbe von ${m.name}`} onPick={color => patchMember(m.id, { color })} />
            </div>

            <h3>Eigene Abzüge</h3>
            <p className="muted small">
              Regelmäßige persönliche Ausgaben, zum Beispiel Fitnessstudio oder Sparen. Sie werden vom Netto abgezogen und nicht geteilt.
            </p>
            {mine.map(d => (
              <div className="drow" key={d.id}>
                <TextField label="Bezeichnung" value={d.name} onCommit={name => patchDeduction(d.id, { name })} />
                <MoneyField label={`Betrag für ${d.name}`} cents={d.amount_cents}
                  onCommit={amount_cents => patchDeduction(d.id, { amount_cents })} />
                <DeleteButton label={`${d.name} entfernen`} onClick={() => act(() => api.deleteDeduction(d.id))} />
              </div>
            ))}
            {mine.length > 0 && <p className="muted small right">Zusammen {eur(mine.reduce((s, d) => s + d.amount_cents, 0))} pro Monat</p>}
            <AddRow placeholder="Neuer Abzug"
              onAdd={(name, amount_cents) => act(() => api.saveDeduction({ id: 0, member_id: m.id, name, amount_cents }))} />
          </section>
        );
      })}

      <button className="btn" onClick={add}>Person hinzufügen</button>
    </>
  );
}
