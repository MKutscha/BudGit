import { useEffect, useState } from 'react';
import { api, type Member, type TemplateInfo } from './api';
import { parseCents } from './money';
import { DeleteButton, PALETTE, Swatches, nextColor } from './ui';

interface Row { name: string; income: string; color: string }
interface Props {
  onCreate: (name: string, members: Member[], template: string) => void;
  onImport: () => void;
  onCancel?: () => void;
}

export function Onboarding({ onCreate, onImport, onCancel }: Props) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [rows, setRows] = useState<Row[]>([
    { name: '', income: '', color: PALETTE[0] },
    { name: '', income: '', color: PALETTE[1] },
  ]);
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [template, setTemplate] = useState('paar');

  useEffect(() => {
    api.templates().then(setTemplates).catch(() => { setTemplates([]); setTemplate('leer'); });
  }, []);

  const patch = (i: number, p: Partial<Row>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const incomes = rows.map(r => parseCents(r.income));
  const peopleOk = rows.every(r => r.name.trim()) && incomes.every(c => c !== null);
  const canNext = step === 0 ? name.trim().length > 0 : step === 1 ? peopleOk : true;

  const finish = () =>
    onCreate(
      name.trim(),
      rows.map((r, i) => ({ id: 0, name: r.name.trim(), color: r.color, income_cents: incomes[i] ?? 0 })),
      template,
    );

  return (
    <main className="start onboarding">
      <div className="progress" aria-hidden="true"><span style={{ width: `${((step + 1) / 3) * 100}%` }} /></div>

      {step === 0 && (
        <section>
          <h1>Wie soll euer Haushalt heißen?</h1>
          <p className="muted">
            Jeder Haushalt ist ein eigener Speicherstand. Du kannst später weitere anlegen, zum Beispiel für Freunde oder Familie.
          </p>
          <input className="big-input" aria-label="Name des Haushalts" placeholder="z. B. Wohnung Nordstraße"
            value={name} autoFocus onChange={e => setName(e.target.value)} />
        </section>
      )}

      {step === 1 && (
        <section>
          <h1>Wer teilt sich die Kosten?</h1>
          <p className="muted">Das Netto-Einkommen bestimmt, wer wie viel der geteilten Kosten trägt. Du kannst es später ändern.</p>
          {rows.map((r, i) => (
            <div className="person-row" key={i}>
              <input aria-label={`Name der Person ${i + 1}`} placeholder="Name" value={r.name}
                onChange={e => patch(i, { name: e.target.value })} />
              <span className="money">
                <input className="num" aria-label={`Netto-Einkommen von Person ${i + 1}`} inputMode="decimal"
                  placeholder="Netto pro Monat" value={r.income} onChange={e => patch(i, { income: e.target.value })} />
                <em aria-hidden="true">€</em>
              </span>
              <Swatches value={r.color} label={`Farbe von Person ${i + 1}`} onPick={color => patch(i, { color })} />
              {rows.length > 2 && (
                <DeleteButton label={`Person ${i + 1} entfernen`} onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} />
              )}
            </div>
          ))}
          <button className="link" onClick={() => setRows(rs => [...rs, { name: '', income: '', color: nextColor(rs.map(r => r.color)) }])}>
            Person hinzufügen
          </button>
        </section>
      )}

      {step === 2 && (
        <section>
          <h1>Womit möchtest du starten?</h1>
          <p className="muted">Eine Vorlage legt typische Gruppen und Posten an. Alle Beträge trägst du selbst ein, nichts ist vorausgefüllt.</p>
          {templates !== null && templates.length === 0 && (
            <p className="muted">Die Vorlagen konnten nicht geladen werden. Du startest mit einem leeren Haushalt.</p>
          )}
          {(templates ?? []).map(t => (
            <div className="tpl" key={t.id}>
              <label className="choice">
                <input type="radio" name="tpl" checked={template === t.id} onChange={() => setTemplate(t.id)} />
                <span><strong>{t.name}</strong><br /><span className="muted">{t.description}</span></span>
              </label>
              {t.groups.length > 0 && (
                <details>
                  <summary>Enthaltene Posten ansehen</summary>
                  <ul>{t.groups.map(g => <li key={g.name}><strong>{g.name}:</strong> {g.items.join(', ')}</li>)}</ul>
                </details>
              )}
            </div>
          ))}
        </section>
      )}

      <div className="row">
        {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Zurück</button>}
        {step < 2
          ? <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Weiter</button>
          : <button className="btn primary" onClick={finish}>Haushalt anlegen</button>}
        {step === 0 && onCancel && <button className="btn" onClick={onCancel}>Abbrechen</button>}
      </div>
      {step === 0 && (
        <p className="muted small">Du hast schon einen Speicherstand? <button className="link" onClick={onImport}>Importieren</button></p>
      )}
    </main>
  );
}
