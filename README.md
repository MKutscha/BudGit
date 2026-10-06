# BudGit

Fixkosten fair teilen: Jede Person trägt ihren Anteil nach Netto-Einkommen, zu gleichen Teilen oder
allein (pro Posten einstellbar). Läuft als Desktop-App komplett lokal, ohne Konto und ohne Server.

## Für Nutzer

- Beim ersten Start führt ein kurzer Assistent durch die Einrichtung (Haushalt, Personen, Startvorlage).
- Beliebig viele **Haushalte** (Speicherstände) anlegen, z. B. für Freunde oder Familie. Sie bleiben auf diesem Rechner.
- Beliebig viele **Personen** pro Haushalt; eigene Abzüge (Fitness, Sparen …) pro Person.
- Einstellungen → Speicherstand exportieren (`.budgit`) sichert einen Haushalt; beim Start lässt er sich importieren.
- **Rückgängig / Wiederholen** (Seitenleiste, `Strg+Z` / `Strg+Y`): jeder Schritt (auch Löschen von Gruppen, Posten, Personen) lässt sich zurücknehmen, auch nach einem Neustart. Die letzten 200 Schritte bleiben erhalten.
- **Automatische Sicherungen:** höchstens eine pro Tag, die letzten 14 bleiben. Einstellungen → Automatische Sicherungen stellt eine davon wieder her (auch das ist rückgängig machbar).
- **Druckansicht:** Übersicht → „Druckansicht / PDF“ erzeugt ein A4-Blatt. Netto-Einkommen und Rest werden nur auf Wunsch mit ausgegeben. Als PDF speichern über den Druckdialog.
- Die App weitergeben: nur die `.exe` (bzw. den Installer) teilen. Daten liegen nie in der App, sondern im
  Datenordner des jeweiligen Rechners. Wer die App bekommt, startet leer im Assistenten.

## Entwickeln

Voraussetzungen: [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) und die
[Tauri-Voraussetzungen](https://tauri.app/start/prerequisites/) für dein System (Windows: WebView2 ist ab Win 10/11 dabei).

```bash
npm install
npm run tauri dev        # App mit Hot Reload starten
npm run tauri build      # Installer + exe bauen (src-tauri/target/release)
cargo test --manifest-path src-tauri/Cargo.toml   # Tests für Verteil-Logik und Datenbank
```

Icon ändern: neues Quellbild (PNG, quadratisch) nehmen und `npx tauri icon pfad/zum/bild.png` ausführen.

## Aufbau

```
src/                   React + TypeScript (nur Anzeige, keine Rechenlogik)
  api.ts               Typen + Aufrufe ans Backend
  Start / Onboarding   Speicherstand wählen bzw. Ersteinrichtung
  Overview / Costs / People / Settings
src-tauri/src/
  split.rs             Verteil-Engine (ganze Cent, Largest-Remainder, getestet)
  db.rs                SQLite: Migrationen, Haushalte anlegen/listen/importieren, CRUD (getestet)
  commands.rs          dünne Tauri-Commands
```

Weitere Dateien: `Tables.tsx` (Tabellen für Übersicht und Druckansicht), `Report.tsx` (Druckansicht).

- **Ein Haushalt = eine SQLite-Datei** im App-Datenordner (`…/de.budgit.app/haushalte/`). Kopieren = Backup.
- **Beträge sind ganze Cent.** Die Anteile ergeben immer exakt die Gesamtsumme.
- **Verlauf:** Tabelle `history` in derselben SQLite-Datei. Vor jeder Änderung wird der Gesamtzustand als JSON abgelegt (`db::logged`), Undo/Redo spielt ihn mit denselben IDs zurück. Änderungen, die nichts ändern, werden nicht aufgezeichnet; schnelle Änderungen am selben Eintrag (< 3 s) zählen als ein Schritt. Exporte (`.budgit`) enthalten den Verlauf nicht.
- **Sicherungen:** `VACUUM INTO` nach `…/haushalte/_backups/<id>/<unix-zeit>.db`; werden mit dem Haushalt gelöscht.
- **Schema-Änderungen** nur als neuer Eintrag in `MIGRATIONS` (db.rs) anhängen; ältere Speicherstände werden beim Öffnen migriert.
