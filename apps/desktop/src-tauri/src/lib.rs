//! The Quintal desktop host.
//!
//! This is emphatically *not* a second client. The window loads `apps/web` —
//! the same UI a browser gets — and everything native is offered to it through
//! one narrow bridge. Anything added here that the web UI cannot reach, or that
//! duplicates a screen the web app already has, is a mistake.

pub mod commands;
pub mod identity;
pub mod nip49;
pub mod office;
pub mod secrets;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::has_identity,
            commands::get_public_key,
            commands::sign_challenge,
            commands::import_identity,
            commands::export_backup,
            commands::confirm_backup,
            commands::can_wipe,
            commands::wipe_identity,
        ])
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;

            let office = office::office_url(&dir);

            // Granted before the window goes anywhere: the office is the only
            // origin allowed to call this process, and it has to be in place
            // before the page it applies to has loaded.
            app.handle()
                .add_capability(office::capability_for(&office))?;

            app.manage(commands::HostState {
                store: secrets::SecretStore::new(&dir)?,
            });

            if let Some(window) = app.get_webview_window("main") {
                match office.parse() {
                    Ok(url) => {
                        window.navigate(url)?;
                    }
                    Err(_) => {
                        // Leave the bootstrap page up rather than navigating
                        // somewhere unintended; it is the one screen that can
                        // say the office URL is wrong.
                        eprintln!("[quintal] not a usable office URL: {office}");
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Quintal desktop host");
}
