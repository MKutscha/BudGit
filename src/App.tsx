import { useCallback, useEffect, useRef, useState } from 'react';
import { api, toProblem, type HouseholdInfo, type Snapshot } from './api';
import { caps, importHousehold, IS_WEB } from './platform';
import { WebNotices } from './webshell';
import { RedoIcon, UndoIcon, type Act, type Level, type View } from './ui';
import { Start } from './Start';
import { Onboarding } from './Onboarding';
import { Overview } from './Overview';
import { Report } from './Report';
import { Costs } from './Costs';
import { Debts } from './Debts';
import { countOverdue, useToday } from './dates';
import { People } from './People';
import { Settings } from './Settings';

const NAV: [View, string][] = [
  ['overview', 'Übersicht'],
  ['costs', 'Kosten'],
  ['debts', 'Schulden'],
  ['people', 'Personen'],
  ['settings', 'Einstellungen'],
];
const MOD = /Mac/i.test(navigator.platform) ? '⌘' : 'Strg+';
const LAST = 'budgit:last';
const THEME = 'budgit:theme';
const TOAST_MS: Record<Level, number> = { info: 4000, warning: 8000, error: 0 }; // 0 = bleibt bis zum Schließen

interface ToastState { level: Level; text: string }

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [list, setList] = useState<HouseholdInfo[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<View>('overview');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME) ?? 'system');
  const [pending, setPending] = useState(0);
  const today = useToday();

  const snapRef = useRef<Snapshot | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const notify = useCallback((text: string, level: Level = 'info') => setToast({ level, text }), []);
  const report = useCallback((e: unknown) => {
    const p = toProblem(e);
    setToast({ level: p.level, text: p.message });
  }, []);

  useEffect(() => {
    if (!toast || TOAST_MS[toast.level] === 0) return;
    const t = setTimeout(() => setToast(null), TOAST_MS[toast.level]);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.dataset.theme = theme;
    localStorage.setItem(THEME, theme);
  }, [theme]);

  const commit = useCallback((s: Snapshot | null) => {
    snapRef.current = s;
    setSnap(s);
  }, []);

  /**
   * Führt Änderungen nacheinander aus. Jede bekommt den neuesten Zustand,
   * damit schnelle Auto-Saves (z. B. Name, dann Betrag) sich nicht überschreiben.
   */
  const act = useCallback<Act>(op => {
    setPending(n => n + 1);
    const run = async (): Promise<boolean> => {
      try {
        const current = snapRef.current;
        if (!current) return false;
        commit(await op(current));
        return true;
      } catch (e) {
        report(e);
        return false;
      } finally {
        setPending(n => n - 1);
      }
    };
    const result = queue.current.then(run);
    queue.current = result;
    return result;
  }, [commit, report]);

  /** Rückgängig / Wiederholen laufen in derselben Warteschlange wie alle Änderungen. */
  const travel = useCallback(async (dir: 'undo' | 'redo') => {
    let label = '';
    const ok = await act(s => {
      label = s.history[dir] ?? '';
      return dir === 'undo' ? api.undo() : api.redo();
    });
    if (ok) notify(`${dir === 'undo' ? 'Rückgängig' : 'Wiederholt'}: ${label}`);
  }, [act, notify]);

  const overdue = snap ? countOverdue(snap.debts, today) : 0;
  const inHousehold = snap !== null;
  useEffect(() => {
    if (!inHousehold || !caps.history) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const dir = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' ? 'redo' : null;
      if (!dir) return;
      // In Eingabefeldern bleibt das normale Rückgängig für den Text erhalten.
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      void travel(dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inHousehold, travel]);

  const enter = useCallback(async (p: Promise<Snapshot>, first = false) => {
    try {
      const s = await p;
      commit(s);
      setCreating(false);
      setView(first ? 'costs' : 'overview');
      localStorage.setItem(LAST, s.id);
    } catch (e) { report(e); }
  }, [commit, report]);

  const refreshList = useCallback(async () => {
    try { setList(await api.list()); } catch (e) { report(e); setList([]); }
  }, [report]);

  useEffect(() => {
    (async () => {
      try {
        const l = await api.list();
        setList(l);
        const last = localStorage.getItem(LAST);
        if (last && l.some(h => h.id === last)) await enter(api.open(last));
      } catch (e) { report(e); setList([]); }
    })();
  }, [enter, report]);

  const leave = async () => {
    await queue.current; // offene Speichervorgänge zuerst abschließen
    try { await api.close(); } catch (e) { report(e); }
    localStorage.removeItem(LAST);
    commit(null);
    await refreshList();
  };

  const importFile = async () => {
    try {
      const imported = await importHousehold();
      if (imported) await enter(Promise.resolve(imported));
    } catch (e) { report(e); }
  };

  const removed = async (id: string) => {
    try {
      await api.remove(id);
      notify('Haushalt gelöscht.');
    } catch (e) { report(e); }
    await refreshList();
  };

  if (list === null) return null;

  const notices = IS_WEB ? <WebNotices householdOpen={snap !== null} /> : null;

  let body;
  if (snap) {
    body = (
      <div className="shell">
        <aside className="side">
          <div className="brand">BudGit</div>
          <div className="who">
            <strong>{snap.name}</strong>
            <button className="link" onClick={leave}>Haushalt wechseln</button>
          </div>
          <nav className="nav" aria-label="Bereiche">
            {NAV.map(([v, label]) => (
              <button key={v} aria-current={view === v || (v === 'overview' && view === 'report') ? 'page' : undefined}
                onClick={() => setView(v)}>
                {label}
                {v === 'debts' && overdue > 0 && (
                  <span className="pill" title={`${overdue} überfällig`} aria-label={`${overdue} überfällig`}>{overdue}</span>
                )}
              </button>
            ))}
          </nav>
          {caps.history && <div className="history" role="group" aria-label="Verlauf">
            <button type="button" className="tool-btn" disabled={!snap.history.undo} onClick={() => void travel('undo')}
              title={snap.history.undo ? `Rückgängig: ${snap.history.undo} (${MOD}Z)` : 'Nichts zum Rückgängigmachen'}>
              <UndoIcon />Rückgängig
            </button>
            <button type="button" className="tool-btn" disabled={!snap.history.redo} onClick={() => void travel('redo')}
              title={snap.history.redo ? `Wiederholen: ${snap.history.redo} (${MOD}Y)` : 'Nichts zum Wiederholen'}>
              <RedoIcon />Wiederholen
            </button>
          </div>}
          <p className="save-state" aria-live="polite">{pending > 0 ? 'Speichert …' : 'Alles gespeichert'}</p>
        </aside>
        <main className="main">
          {notices}
          {view === 'overview' && <Overview snap={snap} go={setView} />}
          {view === 'report' && <Report snap={snap} onBack={() => setView('overview')} />}
          {view === 'costs' && <Costs snap={snap} act={act} />}
          {view === 'debts' && <Debts snap={snap} act={act} />}
          {view === 'people' && <People snap={snap} act={act} />}
          {view === 'settings' && (
            <Settings snap={snap} act={act} notify={notify} report={report} theme={theme} setTheme={setTheme}
              onLeave={leave} onDeleted={leave} />
          )}
        </main>
      </div>
    );
  } else if (creating || list.length === 0) {
    body = (
      <Onboarding
        onCreate={(name, members, template) => enter(api.create(name, members, template), true)}
        onImport={importFile}
        onCancel={list.length > 0 ? () => setCreating(false) : undefined}
      />
    );
  } else {
    body = (
      <Start list={list} onOpen={id => enter(api.open(id))} onNew={() => setCreating(true)}
        onImport={importFile} onDelete={removed} />
    );
  }

  return (
    <>
      {!snap && notices}
      {body}
      {toast && (
        <div className={`toast ${toast.level}`} role={toast.level === 'info' ? 'status' : 'alert'}>
          <p>
            {toast.level !== 'info' && <strong>{toast.level === 'warning' ? 'Hinweis' : 'Fehler'}</strong>}
            {toast.text}
          </p>
          <button className="icon-btn" aria-label="Meldung schließen" onClick={() => setToast(null)}>×</button>
        </div>
      )}
    </>
  );
}
