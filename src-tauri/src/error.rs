use rusqlite::ErrorCode;
use serde::{ser::SerializeStruct, Serialize, Serializer};
use std::io::ErrorKind;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Msg(String),
    #[error("Datenbankfehler: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("Dateifehler: {0}")]
    Io(#[from] std::io::Error),
    #[error("Die Datei ist kein gültiger BudGit-Speicherstand ({0}).")]
    Json(#[from] serde_json::Error),
}

impl AppError {
    pub fn msg(text: impl Into<String>) -> Self {
        AppError::Msg(text.into())
    }

    /// "warning": Der Nutzer kann es selbst beheben (Eingabe, falsche Datei, Regelverstoß).
    /// "error":   Technisches Problem (Datenbank gesperrt, Dateisystem, Unerwartetes).
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Msg(_) | AppError::Json(_) => "warning",
            AppError::Db(rusqlite::Error::SqliteFailure(e, _))
                if e.code == ErrorCode::ConstraintViolation =>
            {
                "warning"
            }
            AppError::Db(_) | AppError::Io(_) => "error",
        }
    }

    /// Verständliche Meldung für die Oberfläche.
    pub fn user_message(&self) -> String {
        match self {
            AppError::Io(e) => match e.kind() {
                ErrorKind::NotFound => "Die Datei wurde nicht gefunden.".into(),
                ErrorKind::PermissionDenied => {
                    "Zugriff verweigert. Ist die Datei gesperrt oder schreibgeschützt?".into()
                }
                _ => format!("Dateifehler: {e}"),
            },
            AppError::Db(rusqlite::Error::SqliteFailure(e, _)) => match e.code {
                ErrorCode::ConstraintViolation => {
                    "Diese Änderung ist nicht zulässig, sie verletzt eine Datenregel.".into()
                }
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => {
                    "Die Datenbank ist gerade gesperrt. Läuft BudGit vielleicht ein zweites Mal?".into()
                }
                _ => format!("Die Datenbank meldet einen Fehler: {}", self),
            },
            other => other.to_string(),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.user_message())?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_mistakes_are_warnings_technical_problems_are_errors() {
        assert_eq!(AppError::msg("Name fehlt").kind(), "warning");
        let bad_json = serde_json::from_str::<u8>("x").unwrap_err();
        assert_eq!(AppError::from(bad_json).kind(), "warning");
        let io = std::io::Error::new(ErrorKind::Other, "kaputt");
        assert_eq!(AppError::from(io).kind(), "error");
    }

    #[test]
    fn serializes_as_kind_and_message() {
        let v = serde_json::to_value(AppError::msg("Name fehlt")).unwrap();
        assert_eq!(v["kind"], "warning");
        assert_eq!(v["message"], "Name fehlt");
        let denied = std::io::Error::from(ErrorKind::PermissionDenied);
        let v = serde_json::to_value(AppError::from(denied)).unwrap();
        assert_eq!(v["kind"], "error");
        assert!(v["message"].as_str().unwrap().contains("Zugriff verweigert"));
    }

    #[test]
    fn constraint_violations_are_friendly_warnings() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE t (x INTEGER CHECK (x >= 0));").unwrap();
        let err: AppError = c.execute("INSERT INTO t VALUES (-1)", []).unwrap_err().into();
        assert_eq!(err.kind(), "warning");
        assert!(err.user_message().contains("Datenregel"));
    }
}
