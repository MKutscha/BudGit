import { useEffect, useState } from 'react';
import { api, type Snapshot } from './api';
import { caps, exportHousehold, IS_WEB } from './platform';
import { useStorageStatus } from './webshell';
import { webApi } from './backend/web';
import { TextField, confirmAction, confirmDelete, type Act, type Level } from './ui';

interface Props {
  snap: Snapshot;
  act: Act;
  notify: (text: string, level?: Level) => void;
  report: (e: unknown) => void;
  theme: string;
  setTheme: (t: string) => void;
  onLeave: () => void;
  onDeleted: () => void;
}

export function Settings({ snap, act, notify, report, theme, setTheme, onLeave, onDeleted }: Props) {
  const [dir, setDir] = useState('');
  const storage = useStorageStatus();
  const meta = IS_WEB ? webApi.meta() : null;
  useEffect(() => { if (caps.dataDir) api.dataDir().then(setDir).catch(() => {}); }, []);

  const [backups, setBackups] = useState<number[]>([]);
  useEffect(() => { if (caps.backups) api.backups().then(setBackups).catch(() => {}); }, []);

  const when = (at: number) =>
    new Date(at * 1000).toLocaleString('de-DE', { dateStyle: 'long', timeStyle: 'short' });

  const restore = async (at: number) => {
    const ok = await confirmAction(
      `Den Stand vom ${when(at)} wiederherstellen? Der aktuelle Stand lässt sich mit „Rückgängig“ zurückholen.`,
      'Wiederherstellen',
    );
    if (ok && await act(() => api.restoreBackup(at))) notify('Sicherung wiederhergestellt.');
  };

  const exportFile = async () => {
    try {
      if (await exportHousehold(snap)) notify('Speicherstand exportiert.');
    } catch (e) { report(e); }
  };

  const remove = async () => {
    if (!(await confirmDelete(`Haushalt „${snap.name}“ mit allen Daten unwiderruflich löschen?`))) return;
    try { await api.remove(snap.id); onDeleted(); } catch (e) { report(e); }
  };

  return (
    <>
      <header className="page-head">
        <h1>Einstellungen</h1>
      </header>

      <section className="block">
        <h2>Dieser Haushalt</h2>
        <div className="field-row">
          <label>Name</label>
          <TextField className="wide-input" label="Name des Haushalts" value={snap.name}
            onCommit={name => act(() => api.rename(name))} />
        </div>
        <div className="row">
          <button className="btn" onClick={exportFile}>Speicherstand exportieren</button>
          <button className="btn" onClick={onLeave}>Haushalt wechseln</button>
        </div>
        <p className="muted small">
          Ein exportierter Speicherstand (.budgit) ist eine Sicherung. Freunde können ihn beim Start importieren.
        </p>
      </section>

      <section className="block">
        <h2>Erscheinungsbild</h2>
        <div className="field-row">
          <label htmlFor="theme">Farbschema</label>
          <select id="theme" value={theme} onChange={e => setTheme(e.target.value)}>
            <option value="system">wie das System</option>
            <option value="light">hell</option>
            <option value="dark">dunkel</option>
          </select>
        </div>
      </section>

      {IS_WEB && (
        <section className="block">
          <h2>Speicher</h2>
          <p className="muted small">Alle Daten liegen nur in diesem Browser auf deinem Gerät. Der Export ist die einzige echte Sicherung.</p>
          <ul className="backups">
            <li><span>Speicher</span><span>{storage?.persisted ? 'geschützt ✓' : 'nicht geschützt ⚠ (bitte installieren und exportieren)'}</span></li>
            <li><span>Als App installiert</span><span>{storage?.installed ? 'ja ✓' : 'nein ⚠'}</span></li>
            <li><span>Letzter Export</span><span>{meta?.lastExportAt ? new Date(meta.lastExportAt).toLocaleDateString('de-DE') : 'noch nie'}</span></li>
            {storage?.usage != null && <li><span>Datengröße</span><span>{Math.max(1, Math.round(storage.usage / 1024))} KB</span></li>}
          </ul>
        </section>
      )}

      {caps.dataDir && <section className="block">
        <h2>Daten</h2>
        <p className="muted small">Alle Daten liegen nur auf diesem Rechner, jeder Haushalt in einer eigenen Datei:</p>
        <p><code>{dir}</code></p>
      </section>}

      {caps.backups && <section className="block">
        <h2>Automatische Sicherungen</h2>
        <p className="muted small">
          Beim Arbeiten legt BudGit höchstens einmal am Tag eine Sicherung an und behält die letzten 14.
          Sie liegen im Ordner <code>_backups</code> im Datenordner. Eine Wiederherstellung lässt sich mit „Rückgängig“ zurücknehmen.
        </p>
        {backups.length === 0 ? (
          <p className="muted small">Noch keine Sicherung. Die erste entsteht automatisch, sobald der Haushalt einen Tag alt ist.</p>
        ) : (
          <ul className="backups">
            {backups.map(at => (
              <li key={at}>
                <span>{when(at)}</span>
                <button className="link" onClick={() => restore(at)}>Wiederherstellen</button>
              </li>
            ))}
          </ul>
        )}
      </section>}

      <section className="block danger-zone">
        <h2>Haushalt löschen</h2>
        <p className="muted small">
          Löscht „{snap.name}“ mit allen Personen, Kosten und Abzügen von diesem Rechner. Das lässt sich nicht rückgängig machen.
          Exportiere vorher einen Speicherstand, falls du die Daten noch brauchst.
        </p>
        <button className="btn danger" onClick={remove}>Haushalt löschen</button>
      </section>
    </>
  );
}
