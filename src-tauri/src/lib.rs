mod commands;
mod db;
mod error;
mod model;
mod split;
mod templates;

use commands::AppState;
use std::sync::Mutex;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_local_data_dir()?.join("haushalte");
            std::fs::create_dir_all(&dir)?;
            app.manage(AppState { dir, open: Mutex::new(None) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_templates,
            commands::list_households,
            commands::data_dir,
            commands::create_household,
            commands::open_household,
            commands::close_household,
            commands::delete_household,
            commands::export_household,
            commands::import_household,
            commands::rename_household,
            commands::save_member,
            commands::delete_member,
            commands::save_group,
            commands::delete_group,
            commands::save_debt,
            commands::delete_debt,
            commands::save_account,
            commands::delete_account,
            commands::save_expense,
            commands::delete_expense,
            commands::save_deduction,
            commands::delete_deduction,
            commands::undo,
            commands::redo,
            commands::list_backups,
            commands::restore_backup,
        ])
        .run(tauri::generate_context!())
        .expect("BudGit konnte nicht gestartet werden");
}
