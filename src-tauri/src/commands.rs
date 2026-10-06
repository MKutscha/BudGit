use crate::{
    db,
    error::{AppError, Result},
    model::*,
};
use rusqlite::Connection;
use std::{
    cell::Cell,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::State;

pub struct Open {
    pub id: String,
    pub conn: Connection,
    /// Zeitpunkt der letzten automatischen Sicherung (Unix-Sekunden, 0 = noch keine).
    pub last_backup: Cell<i64>,
}

pub struct AppState {
    pub dir: PathBuf,
    pub open: Mutex<Option<Open>>,
}

fn with_open<T>(state: &State<AppState>, f: impl FnOnce(&Open) -> Result<T>) -> Result<T> {
    let guard = state.open.lock().unwrap_or_else(|e| e.into_inner());
    let open = guard
        .as_ref()
        .ok_or_else(|| AppError::msg("Kein Haushalt geöffnet."))?;
    f(open)
}

/// Legt höchstens einmal pro Tag eine Sicherung an, bevor sich etwas ändert.
/// Ein Fehler dabei darf die eigentliche Arbeit nie blockieren.
fn backup_if_due(dir: &Path, o: &Open) {
    let now = db::now_secs();
    if now - o.last_backup.get() >= db::BACKUP_EVERY_SECS {
        match db::auto_backup(&o.conn, dir, &o.id, now) {
            Ok(()) => o.last_backup.set(now),
            Err(e) => eprintln!("Automatische Sicherung fehlgeschlagen: {e}"),
        }
    }
}

/// Schreibt, merkt sich den Schritt im Verlauf und liefert danach den frischen Gesamtzustand.
/// `f` liefert die Beschreibung des Schritts; `key` fasst schnelle Änderungen am selben Eintrag zusammen.
fn mutate(
    state: &State<AppState>,
    key: Option<String>,
    f: impl FnOnce(&Connection) -> Result<String>,
) -> Result<Snapshot> {
    with_open(state, |o| {
        backup_if_due(&state.dir, o);
        db::logged(&o.conn, key.as_deref(), db::now_secs(), f)?;
        db::snapshot(&o.conn, &o.id)
    })
}

fn set_open(state: &State<AppState>, id: String, conn: Connection, last_backup: i64) -> Result<Snapshot> {
    let snap = db::snapshot(&conn, &id)?;
    *state.open.lock().unwrap_or_else(|e| e.into_inner()) = Some(Open { id, conn, last_backup: Cell::new(last_backup) });
    Ok(snap)
}

// ---------- Speicherstände ----------

#[tauri::command]
pub fn list_templates() -> Vec<TemplateInfo> {
    crate::templates::infos()
}

#[tauri::command]
pub fn list_households(state: State<AppState>) -> Result<Vec<HouseholdInfo>> {
    db::list(&state.dir)
}

#[tauri::command]
pub fn data_dir(state: State<AppState>) -> String {
    state.dir.display().to_string()
}

#[tauri::command]
pub fn create_household(
    state: State<AppState>,
    name: String,
    members: Vec<Member>,
    template: String,
) -> Result<Snapshot> {
    let (id, conn) = db::create(&state.dir, &name, &members, &template)?;
    set_open(&state, id, conn, db::now_secs())
}

#[tauri::command]
pub fn open_household(state: State<AppState>, id: String) -> Result<Snapshot> {
    let path = db::household_path(&state.dir, &id)?;
    if !path.exists() {
        return Err(AppError::msg("Dieser Speicherstand existiert nicht mehr."));
    }
    let conn = db::open_db(&path)?;
    let last = db::list_backups(&state.dir, &id)?.first().copied().unwrap_or(0);
    let snap = set_open(&state, id, conn, last)?;
    let _ = with_open(&state, |o| {
        backup_if_due(&state.dir, o);
        Ok(())
    });
    Ok(snap)
}

#[tauri::command]
pub fn close_household(state: State<AppState>) {
    *state.open.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[tauri::command]
pub fn delete_household(state: State<AppState>, id: String) -> Result<()> {
    let path = db::household_path(&state.dir, &id)?;
    {
        let mut guard = state.open.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().map(|o| o.id == id).unwrap_or(false) {
            *guard = None; // Verbindung schließen, bevor die Datei gelöscht wird
        }
    }
    std::fs::remove_file(&path)?;
    let _ = std::fs::remove_file(path.with_extension("db-journal"));
    // „Unwiderruflich löschen“ gilt auch für die automatischen Sicherungen.
    let _ = std::fs::remove_dir_all(db::backup_dir(&state.dir, &id));
    Ok(())
}

#[tauri::command]
pub fn export_household(state: State<AppState>, path: String) -> Result<()> {
    let snap = with_open(&state, |o| db::snapshot(&o.conn, &o.id))?;
    let json = serde_json::to_string_pretty(&db::backup(&snap))?;
    std::fs::write(path, json)?;
    Ok(())
}

#[tauri::command]
pub fn import_household(state: State<AppState>, path: String) -> Result<Snapshot> {
    let text = std::fs::read_to_string(path)?;
    let backup: Backup = serde_json::from_str(&text)?;
    let (id, conn) = db::import(&state.dir, &backup)?;
    set_open(&state, id, conn, db::now_secs())
}

// ---------- Inhalte ----------

#[tauri::command]
pub fn rename_household(state: State<AppState>, name: String) -> Result<Snapshot> {
    mutate(&state, Some("rename".into()), |c| {
        db::rename(c, &name)?;
        Ok("Haushalt umbenannt".into())
    })
}

#[tauri::command]
pub fn save_member(state: State<AppState>, member: Member) -> Result<Snapshot> {
    let key = (member.id > 0).then(|| format!("member:{}", member.id));
    mutate(&state, key, |c| {
        db::save_member(c, &member)?;
        let verb = if member.id > 0 { "geändert" } else { "hinzugefügt" };
        Ok(format!("Person „{}“ {verb}", member.name.trim()))
    })
}

#[tauri::command]
pub fn delete_member(state: State<AppState>, id: i64) -> Result<Snapshot> {
    mutate(&state, None, |c| {
        let name = db::name_of(c, "members", id);
        db::delete_member(c, id)?;
        Ok(format!("Person „{name}“ entfernt"))
    })
}

#[tauri::command]
pub fn save_group(state: State<AppState>, group: Group) -> Result<Snapshot> {
    let key = (group.id > 0).then(|| format!("group:{}", group.id));
    mutate(&state, key, |c| {
        db::save_group(c, &group)?;
        let verb = if group.id > 0 { "umbenannt" } else { "angelegt" };
        Ok(format!("Gruppe „{}“ {verb}", group.name.trim()))
    })
}

#[tauri::command]
pub fn delete_group(state: State<AppState>, id: i64) -> Result<Snapshot> {
    mutate(&state, None, |c| {
        let name = db::name_of(c, "cost_groups", id);
        db::delete_group(c, id)?;
        Ok(format!("Gruppe „{name}“ gelöscht"))
    })
}

#[tauri::command]
pub fn save_account(state: State<AppState>, account: Account) -> Result<Snapshot> {
    let key = (account.id > 0).then(|| format!("account:{}", account.id));
    mutate(&state, key, |c| {
        db::save_account(c, &account)?;
        let verb = if account.id > 0 { "umbenannt" } else { "angelegt" };
        Ok(format!("Konto „{}“ {verb}", account.name.trim()))
    })
}

#[tauri::command]
pub fn delete_account(state: State<AppState>, id: i64) -> Result<Snapshot> {
    mutate(&state, None, |c| {
        let name = db::name_of(c, "accounts", id);
        db::delete_account(c, id)?;
        Ok(format!("Konto „{name}“ gelöscht"))
    })
}

fn debt_word(kind: &str) -> &'static str {
    if kind == "receivable" { "Forderung" } else { "Schuld" }
}

#[tauri::command]
pub fn save_debt(state: State<AppState>, debt: Debt) -> Result<Snapshot> {
    let key = (debt.id > 0).then(|| format!("debt:{}", debt.id));
    mutate(&state, key, |c| {
        let was_paid = if debt.id > 0 { db::debt_paid(c, debt.id) } else { None };
        db::save_debt(c, &debt)?;
        let verb = match (debt.id > 0, was_paid, debt.paid_on.is_some()) {
            (false, _, _) => "hinzugefügt",
            (true, Some(false), true) => "als bezahlt markiert",
            (true, Some(true), false) => "wieder geöffnet",
            _ => "geändert",
        };
        Ok(format!("{} „{}“ {verb}", debt_word(&debt.kind), debt.counterparty.trim()))
    })
}

#[tauri::command]
pub fn delete_debt(state: State<AppState>, id: i64) -> Result<Snapshot> {
    mutate(&state, None, |c| {
        let who = db::debt_who(c, id);
        db::delete_debt(c, id)?;
        Ok(format!("Eintrag „{who}“ gelöscht"))
    })
}

#[tauri::command]
pub fn save_expense(state: State<AppState>, expense: Expense) -> Result<Snapshot> {
    let key = (expense.id > 0).then(|| format!("expense:{}", expense.id));
    mutate(&state, key, |c| {
        db::save_expense(c, &expense)?;
        let verb = if expense.id > 0 { "geändert" } else { "hinzugefügt" };
        Ok(format!("Posten „{}“ {verb}", expense.name.trim()))
    })
}

#[tauri::command]
pub fn delete_expense(state: State<AppState>, id: i64) -> Result<Snapshot> {
    mutate(&state, None, |c| {
        let name = db::name_of(c, "expenses", id);
        db::delete_expense(c, id)?;
        Ok(format!("Posten „{name}“ gelöscht"))
    })
}

#[tauri::command]
pub fn save_deduction(state: State<AppState>, deduction: Deduction) -> Result<Snapshot> {
    let key = (deduction.id > 0).then(|| format!("deduction:{}", deduction.id));
    mutate(&state, key, |c| {
        db::save_deduction(c, &deduction)?;
        let verb = if deduction.id > 0 { "geändert" } else { "hinzugefügt" };
        Ok(format!("Abzug „{}“ {verb}", deduction.name.trim()))
    })
}

#[tauri::command]
pub fn delete_deduction(state: State<AppState>, id: i64) -> Result<Snapshot> {
    mutate(&state, None, |c| {
        let name = db::name_of(c, "deductions", id);
        db::delete_deduction(c, id)?;
        Ok(format!("Abzug „{name}“ entfernt"))
    })
}

// ---------- Verlauf & Sicherungen ----------

#[tauri::command]
pub fn undo(state: State<AppState>) -> Result<Snapshot> {
    with_open(&state, |o| {
        db::undo(&o.conn, db::now_secs())?;
        db::snapshot(&o.conn, &o.id)
    })
}

#[tauri::command]
pub fn redo(state: State<AppState>) -> Result<Snapshot> {
    with_open(&state, |o| {
        db::redo(&o.conn, db::now_secs())?;
        db::snapshot(&o.conn, &o.id)
    })
}

/// Zeitpunkte der automatischen Sicherungen des geöffneten Haushalts (Unix-Sekunden, neueste zuerst).
#[tauri::command]
pub fn list_backups(state: State<AppState>) -> Result<Vec<i64>> {
    with_open(&state, |o| db::list_backups(&state.dir, &o.id))
}

#[tauri::command]
pub fn restore_backup(state: State<AppState>, at: i64) -> Result<Snapshot> {
    with_open(&state, |o| {
        let path = db::backup_file(&state.dir, &o.id, at);
        if !path.exists() {
            return Err(AppError::msg("Diese Sicherung existiert nicht mehr."));
        }
        db::restore_from_file(&o.conn, &o.id, &path, db::now_secs())?;
        db::snapshot(&o.conn, &o.id)
    })
}
