// Alles, was vom Gerät abhängt: Dialoge, Export/Import, Druck. Desktop = Tauri, Web = Browser.
import { api, type Snapshot } from './api';
import { webApi } from './backend/web';

export const IS_WEB = import.meta.env.VITE_TARGET === 'web' || !('__TAURI_INTERNALS__' in window);

/** Funktionen, die es nur am Desktop gibt. Die UI blendet sie im Web aus. */
export const caps = { history: !IS_WEB, backups: !IS_WEB, dataDir: !IS_WEB };

// ---------- Bestätigen ----------

export async function confirmAction(text: string, okLabel: string): Promise<boolean> {
  if (!IS_WEB) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(text, { title: 'BudGit', kind: 'warning', okLabel, cancelLabel: 'Abbrechen' });
  }
  return showConfirmSheet(text, okLabel);
}

/** Bottom-Sheet auf Basis von <dialog>; Stil in styles.css (.sheet). */
function showConfirmSheet(text: string, okLabel: string): Promise<boolean> {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet';
    dlg.setAttribute('aria-label', 'Bestätigen');
    const p = document.createElement('p');
    p.textContent = text;
    const row = document.createElement('div');
    row.className = 'sheet-actions';
    const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Abbrechen' });
    const ok = Object.assign(document.createElement('button'), { type: 'button', className: 'btn danger', textContent: okLabel });
    row.append(cancel, ok);
    dlg.append(p, row);
    let answer = false;
    cancel.onclick = () => dlg.close();
    ok.onclick = () => { answer = true; dlg.close(); };
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }); // Tippen neben das Sheet
    dlg.addEventListener('close', () => { dlg.remove(); resolve(answer); });
    document.body.append(dlg);
    dlg.showModal();
    cancel.focus();
  });
}

// ---------- Export ----------

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '_');

/** Gibt true zurück, wenn tatsächlich exportiert wurde (false = abgebrochen). */
export async function exportHousehold(snap: Snapshot): Promise<boolean> {
  if (!IS_WEB) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      defaultPath: `${snap.name}.budgit`,
      filters: [{ name: 'BudGit-Speicherstand', extensions: ['budgit'] }],
    });
    if (!path) return false;
    await api.exportTo(path);
    return true;
  }
  // navigator.share braucht eine frische Nutzer-Geste: JSON synchron aus dem Speicher bauen, nichts vorher awaiten.
  const { name, json } = webApi.exportJson();
  const fileName = `${safeName(name)}.budgit`;
  const file = new File([json], fileName, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      await webApi.markExported();
      return true;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return false;
      // sonst: Fallback Download
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  await webApi.markExported();
  return true;
}

// ---------- Import ----------

/** Öffnet die Dateiauswahl und liefert den neuen Haushalt; null = abgebrochen. Fehler werden geworfen. */
export async function importHousehold(): Promise<Snapshot | null> {
  if (!IS_WEB) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ filters: [{ name: 'BudGit-Speicherstand', extensions: ['budgit'] }] });
    return typeof path === 'string' ? api.importFrom(path) : null;
  }
  const file = await pickFile();
  if (!file) return null;
  return webApi.importText(await file.text());
}

/** Bewusst ohne accept: „.budgit“ ist auf iOS/Android unbekannt, die Datei wäre sonst nicht auswählbar. */
function pickFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', hidden: true });
    input.addEventListener('change', () => { resolve(input.files?.[0] ?? null); input.remove(); }, { once: true });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); }, { once: true });
    document.body.append(input);
    input.click();
  });
}

// ---------- Druck ----------

export const printHint = IS_WEB
  ? 'iPhone: Teilen → Drucken → Vorschau mit zwei Fingern aufziehen → Teilen → In Dateien sichern. Android: „Als PDF speichern“ wählen.'
  : 'Für eine PDF-Datei im Druckdialog „Als PDF speichern“ bzw. „Microsoft Print to PDF“ wählen.';
