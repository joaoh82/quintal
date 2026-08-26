//! The Quintal desktop host.
//!
//! This is emphatically *not* a second client. The window loads `apps/web` —
//! the same UI a browser gets — and everything native is offered to it through
//! one narrow bridge. Anything added here that the web UI cannot reach, or that
//! duplicates a screen the web app already has, is a mistake.

pub mod commands;
pub mod identity;
pub mod machine;
pub mod nip49;
pub mod office;
pub mod runtimes;
pub mod secrets;
pub mod spawn;
pub mod tray;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Off unless somebody turns it on: an app that adds itself to login
        // items uninvited is a thing people uninstall.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            commands::has_identity,
            commands::detect_runtimes,
            commands::get_public_key,
            commands::sign_challenge,
            commands::import_identity,
            commands::export_backup,
            commands::confirm_backup,
            commands::can_wipe,
            commands::wipe_identity,
            commands::host_status,
            commands::remember_host_token,
            commands::forget_host_token,
            commands::start_fleet,
            commands::stop_fleet,
            commands::fleet_status,
            commands::fleet_logs,
            commands::repos_dir,
            commands::list_repos,
            commands::pick_repos_dir,
            commands::opens_at_login,
            commands::set_opens_at_login,
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
                dir: dir.clone(),
                office: office.clone(),
                pending_export: std::sync::Mutex::new(None),
                fleet: spawn::Fleet::new(),
            });

            tray::build(app.handle())?;

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
        .build(tauri::generate_context!())
        .expect("error while running the Quintal desktop host")
        .run(|app, event| {
            // Closing the window must not leave a harness behind. The fleet is a
            // child process of this one, and an orphan keeps agents in the office
            // that nobody can see or stop from here.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<commands::HostState>() {
                    let _ = state.fleet.stop();
                }
            }
        });
}
