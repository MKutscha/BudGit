const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

export const eur = (cents: number) => fmt.format(cents / 100);

/** 12345 -> "123,45"; 0 -> "" (leeres Feld zeigt den Platzhalter) */
export const toInput = (cents: number) => (cents === 0 ? '' : (cents / 100).toFixed(2).replace('.', ','));

/** Punkte als Tausendertrenner: "1.500", "12.500", "1.234.567" (nicht "0.500", nicht "1.50") */
const THOUSANDS = /^[1-9]\d{0,2}(\.\d{3})+$/;

/**
 * "1.234,50" | "1.500" | "12,5" | "12.5" | "" -> Cent; ungültig -> null
 * Ohne Komma gilt ein Punkt mit genau drei Ziffern danach als Tausendertrenner ("1.500" = 1500 €),
 * sonst als Dezimalpunkt ("12.5" = 12,50 €).
 */
export function parseCents(text: string): number | null {
  const t = text.replace(/[€\s]/g, '');
  if (t === '') return 0;
  const norm = t.includes(',')
    ? t.replace(/\./g, '').replace(',', '.')
    : THOUSANDS.test(t) ? t.replace(/\./g, '') : t;
  if (!/^\d*\.?\d*$/.test(norm) || norm === '.') return null;
  const v = Number(`${norm}e2`); // exakt in Dezimalschreibweise: 1.005 -> 100,5 -> 101 (statt 100)
  return Number.isFinite(v) ? Math.round(v) : null;
}

/** 5000 -> "50"; 3333 -> "33,33" (Hundertstel-Prozent) */
export const bpToText = (bp: number) => (bp / 100).toLocaleString('de-DE', { maximumFractionDigits: 2 });

/** "33,3" | "50 %" | "" -> Hundertstel-Prozent (0 bis 10000); ungültig -> null */
export function parsePercent(text: string): number | null {
  const t = text.replace(/[%\s]/g, '');
  if (t === '') return 0;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^\d*\.?\d*$/.test(norm)) return null;
  const v = Number(norm);
  return Number.isFinite(v) && v <= 100 ? Math.round(v * 100) : null;
}

/** Verteilt 100 % nach Gewichten (größter Rest, Summe exakt 10000). Alles 0 -> gleichmäßig. */
export function toBasisPoints(weights: number[]): number[] {
  if (weights.length === 0) return [];
  const w = weights.every(x => x <= 0) ? weights.map(() => 1) : weights.map(x => Math.max(0, x));
  const sum = w.reduce((a, b) => a + b, 0);
  const exact = w.map(x => (x * 10000) / sum);
  const out = exact.map(Math.floor);
  let left = 10000 - out.reduce((a, b) => a + b, 0);
  exact
    .map((x, i) => [i, x - Math.floor(x)] as const)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .forEach(([i]) => { if (left > 0) { out[i]++; left--; } });
  return out;
}
