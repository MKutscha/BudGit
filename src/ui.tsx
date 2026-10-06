import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Snapshot } from './api';
import { confirmAction as confirm } from './platform';
import { bpToText, parseCents, parsePercent, toInput } from './money';

export type View = 'overview' | 'costs' | 'debts' | 'people' | 'settings' | 'report';
export type Level = 'info' | 'warning' | 'error';

/** Eine Änderung bekommt immer den neuesten Zustand und läuft in Reihenfolge. true = gespeichert. */
export type Act = (op: (current: Snapshot) => Promise<Snapshot>) => Promise<boolean>;

export const PALETTE = ['#2F6F8F', '#C2503F', '#6E8B2E', '#8E5BA6', '#D18B1F', '#2E8B6E', '#5B6ABF', '#B0507A'];

export const nextColor = (used: string[]) =>
  PALETTE.find(c => !used.includes(c)) ?? PALETTE[used.length % PALETTE.length];

export const confirmAction = confirm;

export const confirmDelete = (text: string) => confirmAction(text, 'Löschen');

// ---------- Icons ----------

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  );
}

const stroke = {
  viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
} as const;

export function UndoIcon() {
  return <svg {...stroke}><path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" /></svg>;
}

export function RedoIcon() {
  return <svg {...stroke}><path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" /></svg>;
}

/** Einheitlicher Lösch-Knopf für Zeilen, Gruppen und Personen. */
export function DeleteButton(props: { label: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`icon-btn${props.className ? ` ${props.className}` : ''}`}
      aria-label={props.label} title={props.label} onClick={props.onClick}>
      <TrashIcon />
    </button>
  );
}

// ---------- Auto-Save ----------

const DEBOUNCE_MS = 700;

interface Codec<T> {
  format: (v: T) => string;
  parse: (text: string) => T | null; // null = ungültig
}
type Commit<T> = (v: T) => Promise<boolean | void> | void;

const textCodec: Codec<string> = { format: v => v, parse: t => (t.trim() === '' ? null : t.trim()) };
const moneyCodec: Codec<number> = { format: toInput, parse: parseCents };
const percentCodec: Codec<number> = { format: bpToText, parse: parsePercent };

/**
 * Gemeinsame Logik aller Eingabefelder:
 * - speichert 700 ms nach dem letzten Tastendruck, beim Verlassen und beim Schließen sofort
 * - überschreibt den Text nie, solange das Feld Fokus hat
 * - Esc verwirft die Eingabe; ungültige oder abgelehnte Eingaben springen beim Verlassen zurück
 */
function useAutoField<T>(value: T, codec: Codec<T>, onCommit: Commit<T>) {
  const [text, setText] = useState(() => codec.format(value));
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef({ value, text, onCommit });
  live.current = { value, text, onCommit };

  useEffect(() => {
    if (!focused.current) setText(codec.format(value));
  }, [value, codec]);

  /** true = nichts zu tun oder gespeichert; false = ungültig oder abgelehnt */
  const commitNow = async (): Promise<boolean> => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const { value: current, text: typed, onCommit: commit } = live.current;
    const parsed = codec.parse(typed);
    if (parsed === null) return false;
    if (codec.format(parsed) === codec.format(current)) return true;
    return (await commit(parsed)) !== false;
  };

  const commitRef = useRef(commitNow);
  commitRef.current = commitNow;
  useEffect(() => () => { if (timer.current) void commitRef.current(); }, []); // beim Schließen nichts verlieren

  const invalid = text.trim() !== '' && codec.parse(text) === null;

  return {
    value: text,
    'aria-invalid': invalid || undefined,
    onFocus: () => { focused.current = true; },
    onChange: (e: { target: { value: string } }) => {
      setText(e.target.value);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { void commitRef.current(); }, DEBOUNCE_MS);
    },
    onBlur: async () => {
      focused.current = false;
      const ok = await commitNow();
      const parsed = codec.parse(live.current.text);
      setText(ok && parsed !== null ? codec.format(parsed) : codec.format(live.current.value));
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') e.currentTarget.blur();
      if (e.key === 'Escape') {
        clearTimeout(timer.current);
        timer.current = undefined;
        const original = codec.format(live.current.value);
        live.current.text = original;
        setText(original);
        e.currentTarget.blur();
      }
    },
  };
}

export function TextField(props: {
  value: string; onCommit: Commit<string>; label: string; className?: string; placeholder?: string;
}) {
  const { value, onCommit, label, className = 'cell-input', placeholder } = props;
  const field = useAutoField(value, textCodec, onCommit);
  return <input className={className} aria-label={label} placeholder={placeholder} {...field} />;
}

const optionalTextCodec: Codec<string> = { format: v => v, parse: t => t.trim() };

/** Wie TextField, darf aber leer sein (z. B. Verwendungszweck). */
export function OptionalTextField(props: {
  value: string; onCommit: Commit<string>; label: string; placeholder?: string;
}) {
  const field = useAutoField(props.value, optionalTextCodec, props.onCommit);
  return <input className="cell-input" aria-label={props.label} placeholder={props.placeholder} {...field} />;
}

/**
 * Datumsfeld („JJJJ-MM-TT“ oder null). Das Feld ist unkontrolliert, damit halb getippte Daten nicht
 * zurückspringen; gespeichert wird erst, wenn ein vollständiges Datum dasteht oder das Feld geleert wurde.
 */
export function DateField(props: { value: string | null; onCommit: Commit<string | null>; label: string; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const focused = useRef(false);
  const current = props.value ?? '';

  useEffect(() => {
    const el = ref.current;
    if (el && !focused.current && el.value !== current) el.value = current;
  }, [current]);

  const change = async (el: HTMLInputElement) => {
    const typed = el.value;
    if (typed === '' && el.validity.badInput) return; // halb ausgefüllt, noch nichts speichern
    if (typed !== '' && !/^(19|20|21)\d\d-\d\d-\d\d$/.test(typed)) return;
    if (typed === current) return;
    const ok = await props.onCommit(typed === '' ? null : typed);
    if (ok === false && ref.current) ref.current.value = current; // abgelehnt: alten Wert zurück
  };

  return (
    <input ref={ref} type="date" className={props.className ?? 'cell-input'} aria-label={props.label}
      min="1900-01-01" max="2200-12-31" defaultValue={current}
      onFocus={() => { focused.current = true; }}
      onChange={e => { void change(e.currentTarget); }}
      onBlur={e => {
        focused.current = false;
        if (e.currentTarget.validity.badInput) e.currentTarget.value = current; // Unvollständiges verwerfen
      }} />
  );
}

export function MoneyField(props: { cents: number; onCommit: Commit<number>; label: string }) {
  const field = useAutoField(props.cents, moneyCodec, props.onCommit);
  return (
    <span className="money">
      <input className="cell-input num" inputMode="decimal" aria-label={props.label} placeholder="0,00" {...field} />
      <em aria-hidden="true">€</em>
    </span>
  );
}

/** Prozentwert in Hundertstel-Prozent (6000 = 60 %). */
export function PercentField(props: { bp: number; onCommit: Commit<number>; label: string }) {
  const field = useAutoField(props.bp, percentCodec, props.onCommit);
  return (
    <span className="money">
      <input className="cell-input num" inputMode="decimal" aria-label={props.label} placeholder="0" {...field} />
      <em aria-hidden="true">%</em>
    </span>
  );
}

// ---------- Hinzufügen & Farben ----------

export function AddRow(props: {
  placeholder: string;
  onAdd: (name: string, cents: number) => Promise<boolean> | void;
  withAmount?: boolean;
  suggestions?: string[];
}) {
  const { placeholder, onAdd, withAmount = true, suggestions = [] } = props;
  const listId = useId();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = withAmount ? parseCents(amount) : 0;
    if (!name.trim() || cents === null) return;
    const ok = await onAdd(name.trim(), cents);
    if (ok !== false) { setName(''); setAmount(''); } // bei Fehlern bleibt die Eingabe zum Korrigieren stehen
  };
  return (
    <form className="addrow" onSubmit={submit}>
      <input aria-label={placeholder} placeholder={placeholder} value={name} onChange={e => setName(e.target.value)}
        list={suggestions.length > 0 ? listId : undefined} />
      {suggestions.length > 0 && <datalist id={listId}>{suggestions.map(n => <option key={n} value={n} />)}</datalist>}
      {withAmount && (
        <input
          className="num" aria-label="Betrag in Euro" inputMode="decimal" placeholder="0,00 €"
          value={amount} onChange={e => setAmount(e.target.value)}
        />
      )}
      <button className="btn" type="submit">Hinzufügen</button>
    </form>
  );
}

export function Swatches(props: { value: string; onPick: (c: string) => void; label: string }) {
  return (
    <div className="swatches" role="group" aria-label={props.label}>
      {PALETTE.map(c => (
        <button
          key={c} type="button" className="swatch" style={{ background: c }}
          aria-label={`Farbe ${c}`} aria-pressed={props.value === c} onClick={() => props.onPick(c)}
        />
      ))}
    </div>
  );
}
