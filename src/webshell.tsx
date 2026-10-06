// Nur Web: Speicher-Schutz (persist), Installations-Hinweis, Export-Erinnerung, Update-Hinweis.
import { useEffect, useState } from 'react';
import { webApi } from './backend/web';

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** Eingebettete Browser (WhatsApp, Instagram, …) haben einen eigenen Speicher. */
const inAppBrowser = () => /FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat|; wv\)/i.test(navigator.userAgent);

export interface StorageStatus { persisted: boolean; installed: boolean; usage: number | null }

/** Fragt dauerhaften Speicher an. Der Browser darf ablehnen – es ist eine Absicherung, keine Garantie. */
export async function requestPersist(): Promise<StorageStatus> {
  let persisted = false;
  try { persisted = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false; } catch { /* ignorieren */ }
  let usage: number | null = null;
  try { usage = (await navigator.storage?.estimate?.())?.usage ?? null; } catch { /* ignorieren */ }
  return { persisted, installed: isStandalone(), usage };
}

export function useStorageStatus(): StorageStatus | null {
  const [s, setS] = useState<StorageStatus | null>(null);
  useEffect(() => { void requestPersist().then(setS); }, []);
  return s;
}

let deferredInstall: (Event & { prompt: () => Promise<void> }) | null = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e as typeof deferredInstall; });

/** Laufende Eingaben retten, wenn jemand mitten im Tippen die App wechselt. */
export function installBlurOnHide() {
  const blur = () => (document.activeElement as HTMLElement | null)?.blur?.();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') blur(); });
  window.addEventListener('pagehide', blur);
}

let pendingUpdate: (() => void) | null = null;
window.addEventListener('budgit:update', e => { pendingUpdate = (e as CustomEvent<() => void>).detail; });

const DAY = 86_400_000;

export function WebNotices({ householdOpen }: { householdOpen: boolean }) {
  const [hidden, setHidden] = useState(false);
  const [update, setUpdate] = useState<(() => void) | null>(() => pendingUpdate);
useEffect(() => {
  const h = () => setUpdate(() => pendingUpdate);
  window.addEventListener('budgit:update', h);
  return () => window.removeEventListener('budgit:update', h);
}, []);

  const meta = householdOpen ? webApi.meta() : null;
  const notes: { key: string; text: string; action?: [string, () => void] }[] = [];

  if (inAppBrowser()) notes.push({ key: 'iab', text: 'Du bist in einem eingebetteten Browser (z. B. aus WhatsApp). Öffne den Link in Safari bzw. Chrome, sonst scheinen deine Daten später zu fehlen.' });
  else if (!isStandalone()) {
    notes.push(isIos()
      ? { key: 'ios', text: 'Tippe auf Teilen → „Zum Home-Bildschirm“ und starte BudGit von dort. Erst dann den Haushalt anlegen, die installierte App hat einen eigenen Speicher.' }
      : { key: 'and', text: 'Installiere BudGit (Menü ⋮ → „App installieren“), damit deine Daten geschützt bleiben.',
          action: deferredInstall ? ['Installieren', () => void deferredInstall?.prompt()] : undefined });
  }
  if (meta) {
    const since = meta.lastExportAt ? Date.now() - meta.lastExportAt : null;
    if ((since === null && meta.changes >= 10) || (since !== null && (since > 30 * DAY || meta.changes >= 50))) {
      notes.push({ key: 'exp', text: since === null
        ? 'Du hast noch nie exportiert. Der Export in den Einstellungen ist deine einzige echte Sicherung.'
        : `Letzter Export vor ${Math.floor(since / DAY)} Tagen. Bitte in den Einstellungen einen Speicherstand exportieren.` });
    }
  }
  if (update) notes.push({ key: 'upd', text: 'Neue Version verfügbar.', action: ['Neu laden', update] });

  if (hidden && !update) return null;
  if (notes.length === 0) return null;
  return (
    <div className={householdOpen ? 'web-notes' : 'web-notes standalone'} aria-live="polite">
      {notes.map(n => (
        <div key={n.key} className="web-note" role="note">
          <p>{n.text}</p>
          {n.action && <button className="btn" onClick={n.action[1]}>{n.action[0]}</button>}
          {n.key !== 'upd' && <button className="icon-btn" aria-label="Hinweis ausblenden" onClick={() => setHidden(true)}>×</button>}
        </div>
      ))}
    </div>
  );
}
