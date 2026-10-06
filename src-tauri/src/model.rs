use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// id <= 0 bedeutet "neu anlegen".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub income_cents: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: i64,
    pub name: String,
}

/// Bankkonto, über das Posten abgerechnet werden (frei definierbar pro Haushalt).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: i64,
    pub name: String,
}

/// period: monthly | quarterly | yearly
/// split:  income  | equal     | only (nur split_member) | custom (Gewichte je Person)
/// weights: nur bei `custom`; Person-ID -> Anteil in Hundertstel Prozent (6000 = 60 %)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Expense {
    pub id: i64,
    pub group_id: i64,
    pub name: String,
    pub amount_cents: i64,
    pub period: String,
    pub split: String,
    pub split_member: Option<i64>,
    #[serde(default)]
    pub weights: BTreeMap<i64, i64>,
    /// Konto, über das der Posten läuft (None = keins zugeordnet)
    #[serde(default)]
    pub account_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deduction {
    pub id: i64,
    pub member_id: i64,
    pub name: String,
    pub amount_cents: i64,
}

/// Einmaliger Betrag mit Frist, unabhängig von den monatlichen Fixkosten.
/// kind: receivable (Forderung: jemand schuldet uns Geld) | payable (Schuld: wir schulden jemandem Geld)
/// Daten sind ISO-Tage („2026-10-31“). `paid_on` gesetzt = bezahlt, liegt im Archiv.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Debt {
    pub id: i64,
    pub kind: String,
    /// Schuldner (bei Forderung) bzw. Gläubiger (bei Schuld)
    pub counterparty: String,
    pub purpose: String,
    pub amount_cents: i64,
    pub due_on: Option<String>,
    pub paid_on: Option<String>,
}

/// Anteile sind in der Reihenfolge von `Snapshot.members` angeordnet.
#[derive(Debug, Clone, Serialize)]
pub struct Line {
    pub expense_id: i64,
    pub monthly_cents: i64,
    pub shares: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemberSum {
    pub member_id: i64,
    pub share_cents: i64,
    pub deductions_cents: i64,
    pub free_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub total_cents: i64,
    pub lines: Vec<Line>,
    pub members: Vec<MemberSum>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub id: String,
    pub name: String,
    pub members: Vec<Member>,
    pub groups: Vec<Group>,
    pub accounts: Vec<Account>,
    pub expenses: Vec<Expense>,
    pub deductions: Vec<Deduction>,
    pub debts: Vec<Debt>,
    pub summary: Summary,
    pub history: HistoryInfo,
}

/// Beschreibung des nächsten Schritts für Rückgängig bzw. Wiederholen (None = nicht möglich).
#[derive(Debug, Clone, Serialize)]
pub struct HistoryInfo {
    pub undo: Option<String>,
    pub redo: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HouseholdInfo {
    pub id: String,
    pub name: String,
    pub members: Vec<String>,
}

/// Dateiformat für Export/Import (.budgit)
#[derive(Debug, Serialize, Deserialize)]
pub struct Backup {
    pub format: u32,
    pub name: String,
    pub members: Vec<Member>,
    pub groups: Vec<Group>,
    /// Ältere .budgit-Dateien und Verlaufseinträge kennen keine Konten.
    #[serde(default)]
    pub accounts: Vec<Account>,
    pub expenses: Vec<Expense>,
    pub deductions: Vec<Deduction>,
    /// Ältere Dateien und Verlaufseinträge kennen keine Schulden.
    #[serde(default)]
    pub debts: Vec<Debt>,
}

#[derive(Debug, Serialize)]
pub struct TemplateGroup {
    pub name: String,
    pub items: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub groups: Vec<TemplateGroup>,
}
