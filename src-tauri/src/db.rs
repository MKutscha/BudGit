//! Ein Haushalt = eine SQLite-Datei (`<id>.db`). Kein globaler Zustand,
//! dadurch sind Speicherstände unabhängig, kopier- und löschbar.

use crate::{
    error::{AppError, Result},
    model::*,
    split, templates,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Migrationen: nur anhängen, nie ändern. `PRAGMA user_version` = Anzahl angewendeter Einträge.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE members (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    income_cents INTEGER NOT NULL DEFAULT 0 CHECK (income_cents >= 0)
);
CREATE TABLE cost_groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE expenses (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES cost_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
    period TEXT NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly','quarterly','yearly')),
    split TEXT NOT NULL DEFAULT 'income' CHECK (split IN ('income','equal','only')),
    split_member INTEGER REFERENCES members(id) ON DELETE SET NULL
);
CREATE TABLE deductions (
    id INTEGER PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0)
);
"#, r#"
CREATE TABLE expenses_new (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES cost_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
    period TEXT NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly','quarterly','yearly')),
    split TEXT NOT NULL DEFAULT 'income' CHECK (split IN ('income','equal','only','custom')),
    split_member INTEGER REFERENCES members(id) ON DELETE SET NULL
);
INSERT INTO expenses_new SELECT id, group_id, name, amount_cents, period, split, split_member FROM expenses;
DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;
CREATE TABLE expense_weights (
    expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    weight INTEGER NOT NULL CHECK (weight >= 0),
    PRIMARY KEY (expense_id, member_id)
);
"#, r#"
CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('undo','redo')),
    label TEXT NOT NULL,
    key TEXT,
    state TEXT NOT NULL
);
"#, r#"
CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
ALTER TABLE expenses ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
"#, r#"
CREATE TABLE debts (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('receivable','payable')),
    counterparty TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    due_on TEXT,
    paid_on TEXT
);
"#];

// ---------- Dateien & Verbindung ----------

pub fn household_path(dir: &Path, id: &str) -> Result<PathBuf> {
    let ok = !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric());
    if !ok {
        return Err(AppError::msg("Ungültige Haushalts-ID."));
    }
    Ok(dir.join(format!("{id}.db")))
}

fn new_id() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("h{n:x}")
}

pub fn open_db(path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let current: usize = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current > MIGRATIONS.len() {
        return Err(AppError::msg(
            "Dieser Speicherstand stammt aus einer neueren BudGit-Version.",
        ));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute_batch(&format!("PRAGMA user_version = {};", i + 1))?;
        tx.commit()?;
    }
    Ok(())
}

// ---------- Validierung ----------

fn clean_name(s: &str) -> Result<String> {
    let t = s.trim();
    if t.is_empty() {
        return Err(AppError::msg("Der Name darf nicht leer sein."));
    }
    if t.chars().count() > 80 {
        return Err(AppError::msg("Der Name ist zu lang (max. 80 Zeichen)."));
    }
    Ok(t.to_string())
}

fn check_member(m: &Member) -> Result<String> {
    let name = clean_name(&m.name)?;
    let c = m.color.as_bytes();
    if c.len() != 7 || c[0] != b'#' || !c[1..].iter().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::msg("Ungültige Farbe."));
    }
    if m.income_cents < 0 {
        return Err(AppError::msg("Das Einkommen darf nicht negativ sein."));
    }
    Ok(name)
}

// ---------- Haushalte anlegen, auflisten, importieren ----------

pub fn create(dir: &Path, name: &str, members: &[Member], template: &str) -> Result<(String, Connection)> {
    let name = clean_name(name)?;
    let tpl = templates::find(template).ok_or_else(|| AppError::msg("Unbekannte Vorlage."))?;
    if members.is_empty() {
        return Err(AppError::msg("Mindestens eine Person wird benötigt."));
    }
    let id = new_id();
    let path = household_path(dir, &id)?;

    let built = (|| -> Result<Connection> {
        let mut conn = open_db(&path)?;
        let tx = conn.transaction()?;
        tx.execute("INSERT INTO meta (key, value) VALUES ('name', ?1)", [&name])?;
        for m in members {
            let n = check_member(m)?;
            tx.execute(
                "INSERT INTO members (name, color, income_cents) VALUES (?1, ?2, ?3)",
                params![n, m.color, m.income_cents],
            )?;
        }
        for (group, items) in &tpl.groups {
            tx.execute("INSERT INTO cost_groups (name) VALUES (?1)", [group])?;
            let gid = tx.last_insert_rowid();
            for item in items {
                tx.execute(
                    "INSERT INTO expenses (group_id, name, amount_cents, split) VALUES (?1, ?2, 0, ?3)",
                    params![gid, item, tpl.split],
                )?;
            }
        }
        tx.commit()?;
        Ok(conn)
    })();

    match built {
        Ok(conn) => Ok((id, conn)),
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            Err(e)
        }
    }
}

pub fn import(dir: &Path, b: &Backup) -> Result<(String, Connection)> {
    if b.format != 1 {
        return Err(AppError::msg("Unbekanntes Speicherstand-Format."));
    }
    let name = clean_name(&b.name)?;
    let id = new_id();
    let path = household_path(dir, &id)?;

    let built = (|| -> Result<Connection> {
        let mut conn = open_db(&path)?;
        let tx = conn.transaction()?;
        tx.execute("INSERT INTO meta (key, value) VALUES ('name', ?1)", [&name])?;
        fill(&tx, b)?;
        tx.commit()?;
        Ok(conn)
    })();

    match built {
        Ok(conn) => Ok((id, conn)),
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            Err(e)
        }
    }
}

/// Schreibt Personen, Gruppen, Posten, Gewichte und Abzüge mit ihren vorhandenen IDs.
/// Gemeinsame Grundlage für Import, Rückgängig und Sicherungs-Wiederherstellung.
fn fill(c: &Connection, b: &Backup) -> Result<()> {
    for m in &b.members {
        let n = check_member(m)?;
        c.execute(
            "INSERT INTO members (id, name, color, income_cents) VALUES (?1, ?2, ?3, ?4)",
            params![m.id, n, m.color, m.income_cents],
        )?;
    }
    for g in &b.groups {
        c.execute(
            "INSERT INTO cost_groups (id, name) VALUES (?1, ?2)",
            params![g.id, clean_name(&g.name)?],
        )?;
    }
    for a in &b.accounts {
        c.execute(
            "INSERT INTO accounts (id, name) VALUES (?1, ?2)",
            params![a.id, clean_name(&a.name)?],
        )?;
    }
    for e in &b.expenses {
        c.execute(
            "INSERT INTO expenses (id, group_id, name, amount_cents, period, split, split_member, account_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                e.id, e.group_id, clean_name(&e.name)?, e.amount_cents, e.period, e.split, e.split_member,
                e.account_id
            ],
        )?;
    }
    for e in b.expenses.iter().filter(|e| e.split == "custom") {
        for (member_id, weight) in &e.weights {
            c.execute(
                "INSERT INTO expense_weights (expense_id, member_id, weight) VALUES (?1, ?2, ?3)",
                params![e.id, member_id, weight],
            )?;
        }
    }
    for d in &b.deductions {
        c.execute(
            "INSERT INTO deductions (id, member_id, name, amount_cents) VALUES (?1, ?2, ?3, ?4)",
            params![d.id, d.member_id, clean_name(&d.name)?, d.amount_cents],
        )?;
    }
    for d in &b.debts {
        c.execute(
            "INSERT INTO debts (id, kind, counterparty, purpose, amount_cents, due_on, paid_on)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![d.id, d.kind, clean_name(&d.counterparty)?, d.purpose.trim(), d.amount_cents, d.due_on, d.paid_on],
        )?;
    }
    Ok(())
}

/// Ersetzt den gesamten Inhalt durch `b`. Der Aufrufer sorgt für die Transaktion.
fn restore(c: &Connection, b: &Backup) -> Result<()> {
    c.execute("UPDATE meta SET value = ?1 WHERE key = 'name'", [clean_name(&b.name)?])?;
    c.execute_batch(
        "DELETE FROM deductions; DELETE FROM expense_weights; DELETE FROM expenses;
         DELETE FROM cost_groups; DELETE FROM members; DELETE FROM accounts; DELETE FROM debts;",
    )?;
    fill(c, b)
}

pub fn list(dir: &Path) -> Result<Vec<HouseholdInfo>> {
    let mut found: Vec<(u64, HouseholdInfo)> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("db") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        if let Ok(info) = read_info(&path, id) {
            let modified = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            found.push((modified, info));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(found.into_iter().map(|x| x.1).collect())
}

fn read_info(path: &Path, id: String) -> Result<HouseholdInfo> {
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let name: String = c.query_row("SELECT value FROM meta WHERE key = 'name'", [], |r| r.get(0))?;
    let members = query(&c, "SELECT name FROM members ORDER BY id", |r| r.get::<_, String>(0))?;
    Ok(HouseholdInfo { id, name, members })
}

// ---------- Lesen ----------

fn query<T>(c: &Connection, sql: &str, f: impl Fn(&rusqlite::Row) -> rusqlite::Result<T>) -> Result<Vec<T>> {
    let mut st = c.prepare(sql)?;
    let rows = st.query_map([], |r| f(r))?;
    Ok(rows.collect::<rusqlite::Result<Vec<T>>>()?)
}

pub fn snapshot(c: &Connection, id: &str) -> Result<Snapshot> {
    let name: String = c.query_row("SELECT value FROM meta WHERE key = 'name'", [], |r| r.get(0))?;
    let members = query(c, "SELECT id, name, color, income_cents FROM members ORDER BY id", |r| {
        Ok(Member { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, income_cents: r.get(3)? })
    })?;
    let groups = query(c, "SELECT id, name FROM cost_groups ORDER BY id", |r| {
        Ok(Group { id: r.get(0)?, name: r.get(1)? })
    })?;
    let accounts = query(c, "SELECT id, name FROM accounts ORDER BY id", |r| {
        Ok(Account { id: r.get(0)?, name: r.get(1)? })
    })?;
    let mut expenses = query(
        c,
        "SELECT id, group_id, name, amount_cents, period, split, split_member, account_id
         FROM expenses ORDER BY id",
        |r| {
            Ok(Expense {
                id: r.get(0)?, group_id: r.get(1)?, name: r.get(2)?, amount_cents: r.get(3)?,
                period: r.get(4)?, split: r.get(5)?, split_member: r.get(6)?,
                weights: BTreeMap::new(), account_id: r.get(7)?,
            })
        },
    )?;
    let weight_rows = query(c, "SELECT expense_id, member_id, weight FROM expense_weights", |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
    })?;
    for (expense_id, member_id, weight) in weight_rows {
        if let Some(e) = expenses.iter_mut().find(|e| e.id == expense_id) {
            e.weights.insert(member_id, weight);
        }
    }
    let deductions = query(c, "SELECT id, member_id, name, amount_cents FROM deductions ORDER BY id", |r| {
        Ok(Deduction { id: r.get(0)?, member_id: r.get(1)?, name: r.get(2)?, amount_cents: r.get(3)? })
    })?;
    let debts = query(
        c,
        "SELECT id, kind, counterparty, purpose, amount_cents, due_on, paid_on FROM debts ORDER BY id",
        |r| {
            Ok(Debt {
                id: r.get(0)?, kind: r.get(1)?, counterparty: r.get(2)?, purpose: r.get(3)?,
                amount_cents: r.get(4)?, due_on: r.get(5)?, paid_on: r.get(6)?,
            })
        },
    )?;
    let summary = split::compute(&members, &expenses, &deductions);
    let history = history_info(c)?;
    Ok(Snapshot { id: id.to_string(), name, members, groups, accounts, expenses, deductions, debts, summary, history })
}

pub fn backup(s: &Snapshot) -> Backup {
    Backup {
        format: 1,
        name: s.name.clone(),
        members: s.members.clone(),
        groups: s.groups.clone(),
        accounts: s.accounts.clone(),
        expenses: s.expenses.clone(),
        deductions: s.deductions.clone(),
        debts: s.debts.clone(),
    }
}

// ---------- Schreiben ----------

fn touched(n: usize) -> Result<()> {
    if n == 0 { Err(AppError::msg("Eintrag nicht gefunden.")) } else { Ok(()) }
}

pub fn rename(c: &Connection, name: &str) -> Result<()> {
    c.execute("UPDATE meta SET value = ?1 WHERE key = 'name'", [clean_name(name)?])?;
    Ok(())
}

pub fn save_member(c: &Connection, m: &Member) -> Result<()> {
    let name = check_member(m)?;
    if m.id > 0 {
        touched(c.execute(
            "UPDATE members SET name = ?1, color = ?2, income_cents = ?3 WHERE id = ?4",
            params![name, m.color, m.income_cents, m.id],
        )?)
    } else {
        c.execute(
            "INSERT INTO members (name, color, income_cents) VALUES (?1, ?2, ?3)",
            params![name, m.color, m.income_cents],
        )?;
        Ok(())
    }
}

pub fn delete_member(c: &Connection, id: i64) -> Result<()> {
    let count: i64 = c.query_row("SELECT COUNT(*) FROM members", [], |r| r.get(0))?;
    if count <= 1 {
        return Err(AppError::msg("Die letzte Person kann nicht entfernt werden."));
    }
    c.execute(
        "UPDATE expenses SET split = 'income', split_member = NULL WHERE split_member = ?1",
        [id],
    )?;
    touched(c.execute("DELETE FROM members WHERE id = ?1", [id])?)
}

pub fn save_group(c: &Connection, g: &Group) -> Result<()> {
    let name = clean_name(&g.name)?;
    if g.id > 0 {
        touched(c.execute("UPDATE cost_groups SET name = ?1 WHERE id = ?2", params![name, g.id])?)
    } else {
        c.execute("INSERT INTO cost_groups (name) VALUES (?1)", [name])?;
        Ok(())
    }
}

pub fn delete_group(c: &Connection, id: i64) -> Result<()> {
    touched(c.execute("DELETE FROM cost_groups WHERE id = ?1", [id])?)
}

pub fn save_account(c: &Connection, a: &Account) -> Result<()> {
    let name = clean_name(&a.name)?;
    let same: i64 = c.query_row(
        "SELECT COUNT(*) FROM accounts WHERE lower(name) = lower(?1) AND id != ?2",
        params![name, a.id],
        |r| r.get(0),
    )?;
    if same > 0 {
        return Err(AppError::msg("Ein Konto mit diesem Namen gibt es schon."));
    }
    if a.id > 0 {
        touched(c.execute("UPDATE accounts SET name = ?1 WHERE id = ?2", params![name, a.id])?)
    } else {
        c.execute("INSERT INTO accounts (name) VALUES (?1)", [name])?;
        Ok(())
    }
}

/// Zugeordnete Posten bleiben erhalten und haben danach kein Konto (`ON DELETE SET NULL`).
pub fn delete_account(c: &Connection, id: i64) -> Result<()> {
    touched(c.execute("DELETE FROM accounts WHERE id = ?1", [id])?)
}

pub fn save_expense(c: &Connection, e: &Expense) -> Result<()> {
    let name = clean_name(&e.name)?;
    if let Some(a) = e.account_id {
        let known: i64 = c.query_row("SELECT COUNT(*) FROM accounts WHERE id = ?1", [a], |r| r.get(0))?;
        if known == 0 {
            return Err(AppError::msg("Dieses Konto existiert nicht mehr."));
        }
    }
    if e.amount_cents < 0 {
        return Err(AppError::msg("Der Betrag darf nicht negativ sein."));
    }
    if !["monthly", "quarterly", "yearly"].contains(&e.period.as_str()) {
        return Err(AppError::msg("Ungültiger Rhythmus."));
    }
    let only = match e.split.as_str() {
        "income" | "equal" | "custom" => None,
        "only" => Some(e.split_member.ok_or_else(|| AppError::msg("Bitte eine Person wählen."))?),
        _ => return Err(AppError::msg("Ungültige Aufteilung.")),
    };
    let weights: Vec<(i64, i64)> = if e.split == "custom" {
        if e.weights.values().any(|w| !(0..=10_000).contains(w)) {
            return Err(AppError::msg("Prozentwerte müssen zwischen 0 und 100 liegen."));
        }
        if e.weights.values().sum::<i64>() <= 0 {
            return Err(AppError::msg("Mindestens ein Anteil muss größer als 0 sein."));
        }
        e.weights.iter().map(|(m, w)| (*m, *w)).collect()
    } else {
        Vec::new()
    };

    let tx = c.unchecked_transaction()?;
    let id = if e.id > 0 {
        touched(tx.execute(
            "UPDATE expenses SET group_id = ?1, name = ?2, amount_cents = ?3, period = ?4,
             split = ?5, split_member = ?6, account_id = ?7 WHERE id = ?8",
            params![e.group_id, name, e.amount_cents, e.period, e.split, only, e.account_id, e.id],
        )?)?;
        e.id
    } else {
        tx.execute(
            "INSERT INTO expenses (group_id, name, amount_cents, period, split, split_member, account_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![e.group_id, name, e.amount_cents, e.period, e.split, only, e.account_id],
        )?;
        tx.last_insert_rowid()
    };
    tx.execute("DELETE FROM expense_weights WHERE expense_id = ?1", [id])?;
    for (member_id, weight) in weights {
        tx.execute(
            "INSERT INTO expense_weights (expense_id, member_id, weight) VALUES (?1, ?2, ?3)",
            params![id, member_id, weight],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_expense(c: &Connection, id: i64) -> Result<()> {
    touched(c.execute("DELETE FROM expenses WHERE id = ?1", [id])?)
}

pub fn save_deduction(c: &Connection, d: &Deduction) -> Result<()> {
    let name = clean_name(&d.name)?;
    if d.amount_cents < 0 {
        return Err(AppError::msg("Der Betrag darf nicht negativ sein."));
    }
    if d.id > 0 {
        touched(c.execute(
            "UPDATE deductions SET name = ?1, amount_cents = ?2 WHERE id = ?3",
            params![name, d.amount_cents, d.id],
        )?)
    } else {
        c.execute(
            "INSERT INTO deductions (member_id, name, amount_cents) VALUES (?1, ?2, ?3)",
            params![d.member_id, name, d.amount_cents],
        )?;
        Ok(())
    }
}

pub fn delete_deduction(c: &Connection, id: i64) -> Result<()> {
    touched(c.execute("DELETE FROM deductions WHERE id = ?1", [id])?)
}

// ---------- Schulden & Forderungen ----------

/// Prüft „JJJJ-MM-TT“ (Jahr 1900–2200, echte Kalendertage inkl. Schaltjahr).
fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| {
        s.get(r)
            .filter(|t| t.bytes().all(|c| c.is_ascii_digit()))
            .and_then(|t| t.parse::<i64>().ok())
    };
    let (Some(y), Some(m), Some(d)) = (num(0..4), num(5..7), num(8..10)) else {
        return false;
    };
    if !(1900..=2200).contains(&y) || !(1..=12).contains(&m) {
        return false;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => if leap { 29 } else { 28 },
    };
    (1..=days).contains(&d)
}

fn check_date(d: &Option<String>, what: &str) -> Result<()> {
    match d {
        Some(s) if !valid_date(s) => Err(AppError::msg(format!("{what}: Bitte ein gültiges Datum angeben."))),
        _ => Ok(()),
    }
}

pub fn save_debt(c: &Connection, d: &Debt) -> Result<()> {
    if !["receivable", "payable"].contains(&d.kind.as_str()) {
        return Err(AppError::msg("Ungültige Art (Forderung oder Schuld)."));
    }
    let who = d.counterparty.trim();
    if who.is_empty() {
        let role = if d.kind == "receivable" { "den Schuldner" } else { "den Gläubiger" };
        return Err(AppError::msg(format!("Bitte {role} angeben.")));
    }
    if who.chars().count() > 80 {
        return Err(AppError::msg("Der Name ist zu lang (max. 80 Zeichen)."));
    }
    let purpose = d.purpose.trim();
    if purpose.chars().count() > 200 {
        return Err(AppError::msg("Der Verwendungszweck ist zu lang (max. 200 Zeichen)."));
    }
    if d.amount_cents <= 0 {
        return Err(AppError::msg("Der Betrag muss größer als 0 sein."));
    }
    check_date(&d.due_on, "Fälligkeitsdatum")?;
    check_date(&d.paid_on, "Bezahlt am")?;
    if d.id > 0 {
        touched(c.execute(
            "UPDATE debts SET kind = ?1, counterparty = ?2, purpose = ?3, amount_cents = ?4,
             due_on = ?5, paid_on = ?6 WHERE id = ?7",
            params![d.kind, who, purpose, d.amount_cents, d.due_on, d.paid_on, d.id],
        )?)
    } else {
        c.execute(
            "INSERT INTO debts (kind, counterparty, purpose, amount_cents, due_on, paid_on)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![d.kind, who, purpose, d.amount_cents, d.due_on, d.paid_on],
        )?;
        Ok(())
    }
}

pub fn delete_debt(c: &Connection, id: i64) -> Result<()> {
    touched(c.execute("DELETE FROM debts WHERE id = ?1", [id])?)
}

/// Für Verlaufs-Beschreibungen: Ist der Eintrag bezahlt? None = gibt es nicht.
pub fn debt_paid(c: &Connection, id: i64) -> Option<bool> {
    c.query_row("SELECT paid_on IS NOT NULL FROM debts WHERE id = ?1", [id], |r| r.get::<_, bool>(0))
        .optional()
        .ok()
        .flatten()
}

/// Für Verlaufs-Beschreibungen beim Löschen: Name des Schuldners bzw. Gläubigers.
pub fn debt_who(c: &Connection, id: i64) -> String {
    c.query_row("SELECT counterparty FROM debts WHERE id = ?1", [id], |r| r.get(0))
        .unwrap_or_else(|_| "?".into())
}

// ---------- Verlauf (Rückgängig / Wiederholen) ----------

/// Wie viele Schritte maximal zurückgegangen werden kann.
const HISTORY_MAX: i64 = 200;
/// Schnelle Änderungen am selben Eintrag (z. B. Tippen) zählen als ein Schritt.
const COALESCE_SECS: i64 = 3;

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Kompletter Inhalt als JSON (ohne Verlauf), zum Vergleichen und Zurückspielen.
fn state_json(c: &Connection) -> Result<String> {
    Ok(serde_json::to_string(&backup(&snapshot(c, "")?))?)
}

fn top_label(c: &Connection, kind: &str) -> Result<Option<String>> {
    Ok(c.query_row(
        "SELECT label FROM history WHERE kind = ?1 ORDER BY id DESC LIMIT 1",
        [kind],
        |r| r.get(0),
    )
    .optional()?)
}

pub fn history_info(c: &Connection) -> Result<HistoryInfo> {
    Ok(HistoryInfo { undo: top_label(c, "undo")?, redo: top_label(c, "redo")? })
}

/// Führt eine Änderung aus und merkt sich den Zustand davor, falls sich wirklich etwas geändert hat.
/// `f` liefert die Beschreibung des Schritts („Posten „Miete“ gelöscht“).
/// `key` fasst schnelle Änderungen am selben Eintrag zu einem Schritt zusammen.
pub fn logged(
    c: &Connection,
    key: Option<&str>,
    now: i64,
    f: impl FnOnce(&Connection) -> Result<String>,
) -> Result<()> {
    let before = state_json(c)?;
    let label = f(c)?;
    if state_json(c)? != before {
        record(c, &label, key, &before, now)?;
    }
    Ok(())
}

fn record(c: &Connection, label: &str, key: Option<&str>, before: &str, now: i64) -> Result<()> {
    let tx = c.unchecked_transaction()?;
    tx.execute("DELETE FROM history WHERE kind = 'redo'", [])?; // neue Änderung: Wiederholen verfällt
    if let Some(k) = key {
        let last: Option<(i64, Option<String>, i64)> = tx
            .query_row(
                "SELECT id, key, at FROM history WHERE kind = 'undo' ORDER BY id DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((id, Some(last_key), at)) = last {
            if last_key == k && now - at <= COALESCE_SECS {
                // Der ältere Zustand bleibt erhalten; nur Zeit und Beschreibung werden erneuert.
                tx.execute("UPDATE history SET at = ?1, label = ?2 WHERE id = ?3", params![now, label, id])?;
                return Ok(tx.commit()?);
            }
        }
    }
    tx.execute(
        "INSERT INTO history (at, kind, label, key, state) VALUES (?1, 'undo', ?2, ?3, ?4)",
        params![now, label, key, before],
    )?;
    tx.execute(
        "DELETE FROM history WHERE kind = 'undo'
         AND id NOT IN (SELECT id FROM history WHERE kind = 'undo' ORDER BY id DESC LIMIT ?1)",
        [HISTORY_MAX],
    )?;
    Ok(tx.commit()?)
}

/// Springt einen Schritt von `from` nach `to` ("undo" -> "redo" oder umgekehrt). Liefert die Beschreibung.
fn step(c: &Connection, from: &str, to: &str, now: i64, empty: &str) -> Result<String> {
    let row: Option<(i64, String, String)> = c
        .query_row(
            "SELECT id, label, state FROM history WHERE kind = ?1 ORDER BY id DESC LIMIT 1",
            [from],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((id, label, state)) = row else {
        return Err(AppError::msg(empty));
    };
    let target: Backup = match serde_json::from_str(&state) {
        Ok(b) => b,
        Err(_) => {
            c.execute("DELETE FROM history WHERE id = ?1", [id])?;
            return Err(AppError::msg("Dieser Verlaufseintrag war beschädigt und wurde verworfen."));
        }
    };
    let current = state_json(c)?;
    let tx = c.unchecked_transaction()?;
    restore(&tx, &target)?;
    tx.execute("DELETE FROM history WHERE id = ?1", [id])?;
    tx.execute(
        "INSERT INTO history (at, kind, label, key, state) VALUES (?1, ?2, ?3, NULL, ?4)",
        params![now, to, label, current],
    )?;
    tx.commit()?;
    Ok(label)
}

pub fn undo(c: &Connection, now: i64) -> Result<String> {
    step(c, "undo", "redo", now, "Es gibt nichts zum Rückgängigmachen.")
}

pub fn redo(c: &Connection, now: i64) -> Result<String> {
    step(c, "redo", "undo", now, "Es gibt nichts zum Wiederholen.")
}

/// Eingabehilfe für Beschreibungen: Name eines Eintrags (für Löschungen vor dem Löschen aufrufen).
pub fn name_of(c: &Connection, table: &'static str, id: i64) -> String {
    c.query_row(&format!("SELECT name FROM {table} WHERE id = ?1"), [id], |r| r.get(0))
        .unwrap_or_else(|_| "?".into())
}

// ---------- Automatische Sicherungen ----------

/// Höchstens alle 24 Stunden entsteht eine Sicherung; die letzten 14 bleiben erhalten.
pub const BACKUP_EVERY_SECS: i64 = 24 * 60 * 60;
const BACKUP_KEEP: usize = 14;

pub fn backup_dir(dir: &Path, id: &str) -> PathBuf {
    dir.join("_backups").join(id)
}

pub fn backup_file(dir: &Path, id: &str, at: i64) -> PathBuf {
    backup_dir(dir, id).join(format!("{at}.db"))
}

/// Zeitpunkte (Unix-Sekunden) der vorhandenen Sicherungen, neueste zuerst.
pub fn list_backups(dir: &Path, id: &str) -> Result<Vec<i64>> {
    let folder = backup_dir(dir, id);
    if !folder.exists() {
        return Ok(Vec::new());
    }
    let mut found: Vec<i64> = Vec::new();
    for entry in std::fs::read_dir(folder)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("db") {
            continue;
        }
        if let Some(at) = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<i64>().ok()) {
            found.push(at);
        }
    }
    found.sort_unstable_by(|a, b| b.cmp(a));
    Ok(found)
}

/// Konsistente Kopie der laufenden Datenbank (`VACUUM INTO`), danach alte Sicherungen aufräumen.
pub fn auto_backup(c: &Connection, dir: &Path, id: &str, now: i64) -> Result<()> {
    std::fs::create_dir_all(backup_dir(dir, id))?;
    let target = backup_file(dir, id, now);
    if !target.exists() {
        let target_str = target.to_string_lossy().into_owned();
        c.execute("VACUUM INTO ?1", [target_str])?;
    }
    for old in list_backups(dir, id)?.into_iter().skip(BACKUP_KEEP) {
        let _ = std::fs::remove_file(backup_file(dir, id, old));
    }
    Ok(())
}

/// Spielt eine Sicherung in den geöffneten Haushalt zurück. Das ist selbst ein Schritt im Verlauf
/// und lässt sich deshalb rückgängig machen.
pub fn restore_from_file(c: &Connection, id: &str, path: &Path, now: i64) -> Result<()> {
    let other = open_db(path)?;
    let content = backup(&snapshot(&other, id)?);
    drop(other);
    logged(c, None, now, |c| {
        let tx = c.unchecked_transaction()?;
        restore(&tx, &content)?;
        tx.commit()?;
        Ok("Sicherung wiederhergestellt".to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("budgit-test-{}", new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn people() -> Vec<Member> {
        vec![
            Member { id: 0, name: "Anna".into(), color: "#2F6F8F".into(), income_cents: 300_000 },
            Member { id: 0, name: "Ben".into(), color: "#C2503F".into(), income_cents: 100_000 },
        ]
    }

    #[test]
    fn create_list_snapshot_roundtrip() {
        let dir = tmp();
        assert!(list(&dir).unwrap().is_empty());
        let (id, conn) = create(&dir, "Wohnung", &people(), "paar").unwrap();
        let snap = snapshot(&conn, &id).unwrap();
        assert_eq!(snap.members.len(), 2);
        let tpl = templates::find("paar").unwrap();
        assert_eq!(snap.groups.len(), tpl.groups.len());
        assert_eq!(snap.expenses.len(), tpl.groups.iter().map(|(_, i)| i.len()).sum::<usize>());
        assert!(snap.expenses.iter().all(|e| e.amount_cents == 0));
        let l = list(&dir).unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].members, vec!["Anna", "Ben"]);
    }

    #[test]
    fn crud_and_split_through_db() {
        let dir = tmp();
        let (id, conn) = create(&dir, "Test", &people(), "leer").unwrap();
        save_group(&conn, &Group { id: 0, name: "Wohnen".into() }).unwrap();
        let s = snapshot(&conn, &id).unwrap();
        let gid = s.groups[0].id;
        save_expense(&conn, &Expense {
            id: 0, group_id: gid, name: "Miete".into(), amount_cents: 80_000,
            period: "monthly".into(), split: "income".into(), split_member: None, weights: BTreeMap::new(),
            account_id: None,
        }).unwrap();
        let s = snapshot(&conn, &id).unwrap();
        assert_eq!(s.summary.lines[0].shares, vec![60_000, 20_000]);

        // Person entfernen setzt "nur diese Person" zurück
        save_expense(&conn, &Expense { split: "only".into(), split_member: Some(s.members[1].id), ..s.expenses[0].clone() }).unwrap();
        delete_member(&conn, s.members[1].id).unwrap();
        let s = snapshot(&conn, &id).unwrap();
        assert_eq!(s.expenses[0].split, "income");
        assert!(delete_member(&conn, s.members[0].id).is_err());
    }

    #[test]
    fn export_import_keeps_everything() {
        let dir = tmp();
        let (id, conn) = create(&dir, "Alt", &people(), "paar").unwrap();
        let snap = snapshot(&conn, &id).unwrap();
        let json = serde_json::to_string(&backup(&snap)).unwrap();
        let parsed: Backup = serde_json::from_str(&json).unwrap();
        let (id2, conn2) = import(&dir, &parsed).unwrap();
        let snap2 = snapshot(&conn2, &id2).unwrap();
        assert_ne!(id, id2);
        assert_eq!(snap2.expenses.len(), snap.expenses.len());
        assert_eq!(snap2.members[0].name, "Anna");
    }

    #[test]
    fn rejects_bad_ids_and_input() {
        let dir = tmp();
        assert!(household_path(&dir, "../evil").is_err());
        assert!(create(&dir, "  ", &people(), "leer").is_err());
        let mut bad = people();
        bad[0].color = "rot".into();
        assert!(create(&dir, "X", &bad, "leer").is_err());
        assert!(list(&dir).unwrap().is_empty(), "fehlgeschlagene Anlage hinterlässt keine Datei");
    }

    #[test]
    fn custom_weights_roundtrip_validation_and_export() {
        let dir = tmp();
        let (id, conn) = create(&dir, "Custom", &people(), "leer").unwrap();
        save_group(&conn, &Group { id: 0, name: "Wohnen".into() }).unwrap();
        let s = snapshot(&conn, &id).unwrap();
        let (a, b) = (s.members[0].id, s.members[1].id);
        let mut e = Expense {
            id: 0, group_id: s.groups[0].id, name: "Miete".into(), amount_cents: 100_000,
            period: "monthly".into(), split: "custom".into(), split_member: None,
            weights: [(a, 6000), (b, 4000)].into_iter().collect(), account_id: None,
        };
        save_expense(&conn, &e).unwrap();
        let s = snapshot(&conn, &id).unwrap();
        assert_eq!(s.expenses[0].weights.get(&a), Some(&6000));
        assert_eq!(s.summary.lines[0].shares, vec![60_000, 40_000]);

        // Ungültige Gewichte werden abgelehnt und ändern nichts
        e.id = s.expenses[0].id;
        e.weights = [(a, 0), (b, 0)].into_iter().collect();
        assert!(save_expense(&conn, &e).is_err());
        e.weights = [(a, 10_001), (b, 0)].into_iter().collect();
        assert!(save_expense(&conn, &e).is_err());
        e.weights = [(a, 5000), (9999, 5000)].into_iter().collect(); // unbekannte Person
        assert!(save_expense(&conn, &e).is_err());
        assert_eq!(snapshot(&conn, &id).unwrap().expenses[0].weights.get(&a), Some(&6000));

        // Export/Import behält die Gewichte
        let json = serde_json::to_string(&backup(&snapshot(&conn, &id).unwrap())).unwrap();
        let (id2, conn2) = import(&dir, &serde_json::from_str(&json).unwrap()).unwrap();
        assert_eq!(snapshot(&conn2, &id2).unwrap().summary.lines[0].shares, vec![60_000, 40_000]);

        // Wechsel zurück auf "nach Einkommen" räumt die Gewichte auf; Person löschen entfernt ihren Anteil
        e.weights = [(a, 6000), (b, 4000)].into_iter().collect();
        save_expense(&conn, &e).unwrap();
        delete_member(&conn, b).unwrap();
        assert_eq!(snapshot(&conn, &id).unwrap().expenses[0].weights.len(), 1);
        e.split = "income".into();
        save_expense(&conn, &e).unwrap();
        assert!(snapshot(&conn, &id).unwrap().expenses[0].weights.is_empty());
    }

    #[test]
    fn migration_v1_to_v2_keeps_existing_data() {
        let dir = tmp();
        let path = dir.join("alt.db");
        {
            // so sah ein Haushalt vor Version 2 aus
            let c = Connection::open(&path).unwrap();
            c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            c.execute_batch(MIGRATIONS[0]).unwrap();
            c.execute_batch(
                "PRAGMA user_version = 1;
                 INSERT INTO meta VALUES ('name', 'Alt');
                 INSERT INTO members (id, name, color, income_cents) VALUES (1, 'Anna', '#2F6F8F', 300000), (2, 'Ben', '#C2503F', 100000);
                 INSERT INTO cost_groups (id, name) VALUES (1, 'Wohnen');
                 INSERT INTO expenses (id, group_id, name, amount_cents, split, split_member) VALUES
                   (1, 1, 'Miete', 80000, 'income', NULL), (2, 1, 'Strom', 5000, 'only', 2);
                 INSERT INTO deductions (member_id, name, amount_cents) VALUES (1, 'Gym', 3000);",
            ).unwrap();
        }
        let conn = open_db(&path).unwrap();
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
        let s = snapshot(&conn, "alt").unwrap();
        assert_eq!(s.expenses.len(), 2);
        assert_eq!(s.expenses[1].split, "only");
        assert_eq!(s.expenses[1].split_member, Some(2));
        assert_eq!(s.deductions.len(), 1);
        assert_eq!(s.summary.lines[0].shares, vec![60_000, 20_000]);
        // und der neue Modus funktioniert auf migrierten Daten
        let mut e = s.expenses[0].clone();
        e.split = "custom".into();
        e.weights = [(1, 5000), (2, 5000)].into_iter().collect();
        save_expense(&conn, &e).unwrap();
        assert_eq!(snapshot(&conn, "alt").unwrap().summary.lines[0].shares, vec![40_000, 40_000]);
        // Foreign Keys sind nach der Migration intakt
        let bad: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(bad, 0);
    }

    #[test]
    fn every_template_can_be_created_and_unknown_is_rejected() {
        let dir = tmp();
        for t in templates::all() {
            let (id, conn) = create(&dir, t.id, &people(), t.id).unwrap();
            let s = snapshot(&conn, &id).unwrap();
            assert_eq!(s.groups.len(), t.groups.len());
            assert!(s.expenses.iter().all(|e| e.amount_cents == 0 && e.split == t.split));
        }
        assert!(create(&dir, "X", &people(), "gibt-es-nicht").is_err());
    }

    fn rename_logged(c: &Connection, name: &str, now: i64) {
        logged(c, None, now, |c| {
            rename(c, name)?;
            Ok(format!("Umbenannt in {name}"))
        })
        .unwrap();
    }

    #[test]
    fn undo_redo_restores_deleted_group_with_same_ids() {
        let dir = tmp();
        let (id, conn) = create(&dir, "U", &people(), "paar").unwrap();
        let before = snapshot(&conn, &id).unwrap();
        assert!(before.history.undo.is_none() && before.history.redo.is_none());
        let gid = before.groups[0].id;

        logged(&conn, None, 100, |c| {
            delete_group(c, gid)?;
            Ok("Gruppe gelöscht".to_string())
        })
        .unwrap();
        let after = snapshot(&conn, &id).unwrap();
        assert!(after.groups.len() < before.groups.len());
        assert!(after.expenses.len() < before.expenses.len());
        assert_eq!(after.history.undo.as_deref(), Some("Gruppe gelöscht"));

        assert_eq!(undo(&conn, 101).unwrap(), "Gruppe gelöscht");
        let restored = snapshot(&conn, &id).unwrap();
        let ids = |s: &Snapshot| s.expenses.iter().map(|e| e.id).collect::<Vec<_>>();
        assert_eq!(restored.groups.len(), before.groups.len());
        assert_eq!(ids(&restored), ids(&before));
        assert!(restored.history.undo.is_none());
        assert_eq!(restored.history.redo.as_deref(), Some("Gruppe gelöscht"));

        redo(&conn, 102).unwrap();
        let again = snapshot(&conn, &id).unwrap();
        assert_eq!(again.groups.len(), after.groups.len());
        assert!(again.history.redo.is_none());
        assert!(undo(&conn, 103).is_ok());
    }

    #[test]
    fn undo_restores_custom_weights_deductions_and_removed_person() {
        let dir = tmp();
        let (id, conn) = create(&dir, "W", &people(), "leer").unwrap();
        save_group(&conn, &Group { id: 0, name: "Wohnen".into() }).unwrap();
        let s = snapshot(&conn, &id).unwrap();
        let (a, b) = (s.members[0].id, s.members[1].id);
        save_expense(&conn, &Expense {
            id: 0, group_id: s.groups[0].id, name: "Miete".into(), amount_cents: 100_000,
            period: "monthly".into(), split: "custom".into(), split_member: None,
            weights: [(a, 7000), (b, 3000)].into_iter().collect(), account_id: None,
        }).unwrap();
        save_deduction(&conn, &Deduction { id: 0, member_id: b, name: "Gym".into(), amount_cents: 3000 }).unwrap();
        let full = snapshot(&conn, &id).unwrap();

        logged(&conn, None, 10, |c| {
            delete_member(c, b)?;
            Ok("Person entfernt".to_string())
        })
        .unwrap();
        let gone = snapshot(&conn, &id).unwrap();
        assert_eq!(gone.members.len(), 1);
        assert!(gone.deductions.is_empty());

        undo(&conn, 11).unwrap();
        let back = snapshot(&conn, &id).unwrap();
        assert_eq!(back.members.len(), 2);
        assert_eq!(back.deductions.len(), 1);
        assert_eq!(back.expenses[0].weights, full.expenses[0].weights);
        assert_eq!(back.summary.lines[0].shares, full.summary.lines[0].shares);
    }

    #[test]
    fn no_op_changes_are_not_recorded_and_new_changes_clear_redo() {
        let dir = tmp();
        let (id, conn) = create(&dir, "Alt", &people(), "leer").unwrap();
        rename_logged(&conn, "Alt", 10); // gleicher Name: nichts geändert
        assert!(snapshot(&conn, &id).unwrap().history.undo.is_none());

        rename_logged(&conn, "Neu", 100);
        undo(&conn, 200).unwrap();
        assert_eq!(snapshot(&conn, &id).unwrap().name, "Alt");
        assert!(snapshot(&conn, &id).unwrap().history.redo.is_some());
        rename_logged(&conn, "Anders", 300);
        assert!(snapshot(&conn, &id).unwrap().history.redo.is_none());
        assert!(redo(&conn, 400).is_err());
    }

    #[test]
    fn failed_changes_leave_no_history_and_empty_stack_is_a_warning() {
        let dir = tmp();
        let (id, conn) = create(&dir, "F", &people(), "leer").unwrap();
        let r = logged(&conn, None, 5, |c| {
            rename(c, "  ")?;
            Ok("x".to_string())
        });
        assert!(r.is_err());
        assert!(snapshot(&conn, &id).unwrap().history.undo.is_none());
        assert_eq!(undo(&conn, 6).unwrap_err().kind(), "warning");
        assert_eq!(redo(&conn, 6).unwrap_err().kind(), "warning");
    }

    #[test]
    fn quick_edits_of_the_same_entry_become_one_step() {
        let dir = tmp();
        let (id, conn) = create(&dir, "A", &people(), "leer").unwrap();
        let go = |name: &str, key: Option<&str>, now: i64| {
            logged(&conn, key, now, |c| {
                rename(c, name)?;
                Ok(format!("Name {name}"))
            })
            .unwrap();
        };
        go("B", Some("rename"), 100);
        go("C", Some("rename"), 101);
        go("D", Some("rename"), 103); // Fenster wird mit jeder Änderung verlängert
        go("E", Some("rename"), 120); // zu spät: eigener Schritt
        undo(&conn, 130).unwrap();
        assert_eq!(snapshot(&conn, &id).unwrap().name, "D");
        undo(&conn, 131).unwrap();
        assert_eq!(snapshot(&conn, &id).unwrap().name, "A");
        assert!(undo(&conn, 132).is_err());
    }

    #[test]
    fn history_is_capped_and_survives_reopening() {
        let dir = tmp();
        let (id, conn) = create(&dir, "N0", &people(), "leer").unwrap();
        for i in 1..=(HISTORY_MAX + 5) {
            rename_logged(&conn, &format!("N{i}"), i * 10);
        }
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM history WHERE kind = 'undo'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, HISTORY_MAX);
        drop(conn);
        let conn = open_db(&household_path(&dir, &id).unwrap()).unwrap();
        assert_eq!(snapshot(&conn, &id).unwrap().history.undo.as_deref(), Some(format!("Umbenannt in N{}", HISTORY_MAX + 5).as_str()));
    }

    #[test]
    fn history_and_backups_do_not_leak_into_exports() {
        let dir = tmp();
        let (id, conn) = create(&dir, "E", &people(), "paar").unwrap();
        rename_logged(&conn, "E2", 1);
        let json = serde_json::to_string(&backup(&snapshot(&conn, &id).unwrap())).unwrap();
        assert!(!json.contains("history"));
        let (id2, conn2) = import(&dir, &serde_json::from_str(&json).unwrap()).unwrap();
        assert!(snapshot(&conn2, &id2).unwrap().history.undo.is_none());
    }

    #[test]
    fn auto_backup_copies_prunes_and_can_be_restored_with_undo() {
        let dir = tmp();
        let (id, conn) = create(&dir, "Tag1", &people(), "paar").unwrap();
        assert!(list_backups(&dir, &id).unwrap().is_empty());
        auto_backup(&conn, &dir, &id, 1_000).unwrap();
        auto_backup(&conn, &dir, &id, 1_000).unwrap(); // gleicher Zeitpunkt: kein Fehler, keine Doppelung
        assert_eq!(list_backups(&dir, &id).unwrap(), vec![1_000]);

        // Haushalt ändern, Sicherung zurückspielen, Rückgängig stellt die Änderung wieder her
        rename_logged(&conn, "Tag2", 2_000);
        let changed = snapshot(&conn, &id).unwrap();
        restore_from_file(&conn, &id, &backup_file(&dir, &id, 1_000), 3_000).unwrap();
        let s = snapshot(&conn, &id).unwrap();
        assert_eq!(s.name, "Tag1");
        assert_eq!(s.history.undo.as_deref(), Some("Sicherung wiederhergestellt"));
        undo(&conn, 3_001).unwrap();
        assert_eq!(snapshot(&conn, &id).unwrap().name, changed.name);

        // Aufräumen: nur die neuesten BACKUP_KEEP bleiben
        for i in 1..=(BACKUP_KEEP as i64 + 3) {
            auto_backup(&conn, &dir, &id, 10_000 + i).unwrap();
        }
        let left = list_backups(&dir, &id).unwrap();
        assert_eq!(left.len(), BACKUP_KEEP);
        assert_eq!(left[0], 10_000 + BACKUP_KEEP as i64 + 3);
    }

    fn plain_expense(group_id: i64, name: &str, amount: i64, account_id: Option<i64>) -> Expense {
        Expense {
            id: 0, group_id, name: name.into(), amount_cents: amount,
            period: "monthly".into(), split: "income".into(), split_member: None,
            weights: BTreeMap::new(), account_id,
        }
    }

    #[test]
    fn accounts_can_be_assigned_renamed_and_deleted() {
        let dir = tmp();
        let (id, conn) = create(&dir, "K", &people(), "leer").unwrap();
        save_group(&conn, &Group { id: 0, name: "Wohnen".into() }).unwrap();
        save_account(&conn, &Account { id: 0, name: "Gemeinschaftskonto".into() }).unwrap();
        let s = snapshot(&conn, &id).unwrap();
        let (gid, kid) = (s.groups[0].id, s.accounts[0].id);

        save_expense(&conn, &plain_expense(gid, "Miete", 80_000, Some(kid))).unwrap();
        assert_eq!(snapshot(&conn, &id).unwrap().expenses[0].account_id, Some(kid));

        // Umbenennen; doppelte oder leere Namen werden abgelehnt
        save_account(&conn, &Account { id: kid, name: "Girokonto Marc".into() }).unwrap();
        save_account(&conn, &Account { id: 0, name: "Sparkonto".into() }).unwrap();
        assert!(save_account(&conn, &Account { id: 0, name: "girokonto marc".into() }).is_err());
        assert!(save_account(&conn, &Account { id: 0, name: "  ".into() }).is_err());
        let s = snapshot(&conn, &id).unwrap();
        assert_eq!(s.accounts.len(), 2);
        assert_eq!(s.accounts[0].name, "Girokonto Marc");

        // Unbekanntes Konto wird abgelehnt und ändert nichts
        let mut e = s.expenses[0].clone();
        e.account_id = Some(9999);
        assert!(save_expense(&conn, &e).is_err());
        assert_eq!(snapshot(&conn, &id).unwrap().expenses[0].account_id, Some(kid));

        // Konto löschen: der Posten bleibt, nur die Zuordnung entfällt
        delete_account(&conn, kid).unwrap();
        let s = snapshot(&conn, &id).unwrap();
        assert_eq!(s.accounts.len(), 1);
        assert_eq!(s.expenses.len(), 1);
        assert_eq!(s.expenses[0].account_id, None);
        assert!(delete_account(&conn, kid).is_err());
    }

    #[test]
    fn accounts_survive_undo_export_and_old_files() {
        let dir = tmp();
        let (id, conn) = create(&dir, "K2", &people(), "leer").unwrap();
        save_group(&conn, &Group { id: 0, name: "Wohnen".into() }).unwrap();
        save_account(&conn, &Account { id: 0, name: "Gemeinschaftskonto".into() }).unwrap();
        let s = snapshot(&conn, &id).unwrap();
        let (gid, kid) = (s.groups[0].id, s.accounts[0].id);
        save_expense(&conn, &plain_expense(gid, "Miete", 80_000, Some(kid))).unwrap();

        // Konto löschen und Rückgängig: Konto und Zuordnung sind mit denselben IDs wieder da
        logged(&conn, None, 100, |c| {
            delete_account(c, kid)?;
            Ok("Konto gelöscht".to_string())
        })
        .unwrap();
        assert!(snapshot(&conn, &id).unwrap().accounts.is_empty());
        undo(&conn, 101).unwrap();
        let back = snapshot(&conn, &id).unwrap();
        assert_eq!(back.accounts.len(), 1);
        assert_eq!(back.accounts[0].id, kid);
        assert_eq!(back.expenses[0].account_id, Some(kid));

        // Export und Import behalten Konten und Zuordnung
        let json = serde_json::to_string(&backup(&back)).unwrap();
        let (id2, conn2) = import(&dir, &serde_json::from_str(&json).unwrap()).unwrap();
        let s2 = snapshot(&conn2, &id2).unwrap();
        assert_eq!(s2.accounts[0].name, "Gemeinschaftskonto");
        assert_eq!(s2.expenses[0].account_id, Some(kid));

        // Eine .budgit-Datei aus einer älteren Version (ohne Konten) lässt sich weiter importieren
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v.as_object_mut().unwrap().remove("accounts");
        for e in v["expenses"].as_array_mut().unwrap() {
            e.as_object_mut().unwrap().remove("account_id");
        }
        let old: Backup = serde_json::from_value(v).unwrap();
        let (id3, conn3) = import(&dir, &old).unwrap();
        let s3 = snapshot(&conn3, &id3).unwrap();
        assert!(s3.accounts.is_empty());
        assert_eq!(s3.expenses[0].account_id, None);
    }

    #[test]
    fn migration_v3_to_v4_adds_accounts_without_losing_expenses() {
        let dir = tmp();
        let path = dir.join("v3.db");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            for sql in &MIGRATIONS[..3] {
                c.execute_batch(sql).unwrap();
            }
            c.execute_batch(
                "PRAGMA user_version = 3;
                 INSERT INTO meta VALUES ('name', 'V3');
                 INSERT INTO members (id, name, color, income_cents) VALUES (1, 'Anna', '#2F6F8F', 300000);
                 INSERT INTO cost_groups (id, name) VALUES (1, 'Wohnen');
                 INSERT INTO expenses (id, group_id, name, amount_cents) VALUES (1, 1, 'Miete', 80000);",
            )
            .unwrap();
        }
        let conn = open_db(&path).unwrap();
        let s = snapshot(&conn, "v3").unwrap();
        assert_eq!(s.expenses.len(), 1);
        assert_eq!(s.expenses[0].account_id, None);
        assert!(s.accounts.is_empty());
    }

    fn debt(kind: &str, who: &str, cents: i64, due: Option<&str>) -> Debt {
        Debt {
            id: 0, kind: kind.into(), counterparty: who.into(), purpose: "Verkauf Fahrrad".into(),
            amount_cents: cents, due_on: due.map(String::from), paid_on: None,
        }
    }

    #[test]
    fn date_validation_knows_the_calendar() {
        for ok in ["2026-10-31", "2024-02-29", "2000-02-29", "1900-01-01", "2200-12-31"] {
            assert!(valid_date(ok), "{ok}");
        }
        for bad in [
            "", "2026-10-5", "26-10-05", "2026/10/05", "2026-13-01", "2026-00-10", "2026-04-31",
            "2023-02-29", "1900-02-29", "1899-12-31", "2201-01-01", "2026-1a-05", "20261005xx", "ääää-10-05",
        ] {
            assert!(!valid_date(bad), "{bad}");
        }
    }

    #[test]
    fn debts_validate_roundtrip_and_archive() {
        let dir = tmp();
        let (id, conn) = create(&dir, "S", &people(), "leer").unwrap();
        save_debt(&conn, &debt("receivable", "  Tom ", 12_000, Some("2026-11-15"))).unwrap();
        save_debt(&conn, &debt("payable", "Vermieter", 5_050, None)).unwrap();
        let s = snapshot(&conn, &id).unwrap();
        assert_eq!(s.debts.len(), 2);
        assert_eq!(s.debts[0].counterparty, "Tom");
        assert_eq!(s.debts[0].due_on.as_deref(), Some("2026-11-15"));
        assert!(s.debts[1].due_on.is_none() && s.debts[1].paid_on.is_none());

        // Ungültiges wird abgelehnt und ändert nichts
        assert!(save_debt(&conn, &debt("receivable", "  ", 100, None)).is_err());
        assert!(save_debt(&conn, &debt("receivable", "X", 0, None)).is_err());
        assert!(save_debt(&conn, &debt("receivable", "X", -5, None)).is_err());
        assert!(save_debt(&conn, &debt("geschenk", "X", 100, None)).is_err());
        assert!(save_debt(&conn, &debt("receivable", "X", 100, Some("2026-02-30"))).is_err());
        let mut long = debt("receivable", "X", 100, None);
        long.purpose = "a".repeat(201);
        assert!(save_debt(&conn, &long).is_err());
        assert_eq!(snapshot(&conn, &id).unwrap().debts.len(), 2);

        // Als bezahlt markieren (Archiv) und wieder öffnen
        let mut d = s.debts[0].clone();
        d.paid_on = Some("2026-11-02".into());
        save_debt(&conn, &d).unwrap();
        assert_eq!(debt_paid(&conn, d.id), Some(true));
        assert_eq!(snapshot(&conn, &id).unwrap().debts[0].paid_on.as_deref(), Some("2026-11-02"));
        d.paid_on = None;
        save_debt(&conn, &d).unwrap();
        assert_eq!(debt_paid(&conn, d.id), Some(false));
        assert_eq!(debt_paid(&conn, 9999), None);

        // Unbekannter Eintrag
        let mut ghost = d.clone();
        ghost.id = 9999;
        assert!(save_debt(&conn, &ghost).is_err());
        assert_eq!(debt_who(&conn, d.id), "Tom");
        delete_debt(&conn, d.id).unwrap();
        assert!(delete_debt(&conn, d.id).is_err());
        assert_eq!(snapshot(&conn, &id).unwrap().debts.len(), 1);
    }

    #[test]
    fn debts_survive_undo_export_and_old_files() {
        let dir = tmp();
        let (id, conn) = create(&dir, "S2", &people(), "leer").unwrap();
        save_debt(&conn, &debt("receivable", "Tom", 12_000, Some("2026-11-15"))).unwrap();
        let did = snapshot(&conn, &id).unwrap().debts[0].id;

        // Löschen und Rückgängig: derselbe Eintrag mit derselben ID
        logged(&conn, None, 100, |c| {
            delete_debt(c, did)?;
            Ok("Eintrag gelöscht".to_string())
        })
        .unwrap();
        assert!(snapshot(&conn, &id).unwrap().debts.is_empty());
        undo(&conn, 101).unwrap();
        let back = snapshot(&conn, &id).unwrap();
        assert_eq!(back.debts.len(), 1);
        assert_eq!(back.debts[0].id, did);
        assert_eq!(back.debts[0].due_on.as_deref(), Some("2026-11-15"));

        // Export/Import behält alles
        let json = serde_json::to_string(&backup(&back)).unwrap();
        let (id2, conn2) = import(&dir, &serde_json::from_str(&json).unwrap()).unwrap();
        let s2 = snapshot(&conn2, &id2).unwrap();
        assert_eq!(s2.debts[0].counterparty, "Tom");
        assert_eq!(s2.debts[0].amount_cents, 12_000);

        // Datei aus einer älteren Version (ohne Schulden) lässt sich weiter importieren
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v.as_object_mut().unwrap().remove("debts");
        let old: Backup = serde_json::from_value(v).unwrap();
        let (id3, conn3) = import(&dir, &old).unwrap();
        assert!(snapshot(&conn3, &id3).unwrap().debts.is_empty());
    }

    #[test]
    fn migration_v4_to_v5_adds_debts_and_keeps_data() {
        let dir = tmp();
        let path = dir.join("v4.db");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            for sql in &MIGRATIONS[..4] {
                c.execute_batch(sql).unwrap();
            }
            c.execute_batch(
                "PRAGMA user_version = 4;
                 INSERT INTO meta VALUES ('name', 'V4');
                 INSERT INTO members (id, name, color, income_cents) VALUES (1, 'Anna', '#2F6F8F', 300000);
                 INSERT INTO accounts (id, name) VALUES (1, 'Giro');
                 INSERT INTO cost_groups (id, name) VALUES (1, 'Wohnen');
                 INSERT INTO expenses (id, group_id, name, amount_cents, account_id) VALUES (1, 1, 'Miete', 80000, 1);",
            )
            .unwrap();
        }
        let conn = open_db(&path).unwrap();
        let s = snapshot(&conn, "v4").unwrap();
        assert_eq!(s.expenses[0].account_id, Some(1));
        assert!(s.debts.is_empty());
        save_debt(&conn, &debt("payable", "Oma", 2_000, None)).unwrap();
        assert_eq!(snapshot(&conn, "v4").unwrap().debts.len(), 1);
    }
}
