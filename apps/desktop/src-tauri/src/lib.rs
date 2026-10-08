//! The Quintal desktop host.
//!
//! This is emphatically *not* a second client. The window loads `apps/web` —
//! the same UI a browser gets — and everything native is offered to it through
//! one narrow bridge. Anything added here that the web UI cannot reach, or that
//! duplicates a screen the web app already has, is a mistake.
//!
//! Two ways to have an office. **Connect to a server**: the app is a window
//! onto a Quintal deployment somebody is running — Docker on this machine, a
//! host somewhere. **A personal office**: the app runs the same server itself,
//! privately, on this computer, and is a window onto that — see `personal.rs`.
//! Everything past the first screen is identical in both.

pub mod agent_keys;
pub mod background;
pub mod commands;
pub mod identity;
pub mod links;
pub mod machine;
pub mod nip49;
pub mod personal;
pub mod ptt;
pub mod runtimes;
pub mod secrets;
pub mod server;
pub mod spawn;
pub mod tray;
pub mod update;

use std::sync::Arc;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // First, before any other plugin: a second launch of the app hands
        // its arguments to the one already running and exits. Two copies of
        // this process would be two personal-office servers racing over one
        // SQLite file, and two fleets in one office.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // Off unless somebody turns it on: an app that adds itself to login
        // items uninvited is a thing people uninstall.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // One chord, registered at setup, for push-to-talk while some other
        // window has the keyboard. Registered from here, not from the page:
        // the page cannot register a global key on its own.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Self-update. Carries no policy of its own: what it will accept is
        // fixed by the endpoint and public key in the config, and when it is
        // asked is decided by the page — see `update.rs`.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Used from this process only — no notification permission is granted
        // to the page, which asks through `commands::notify` instead.
        .plugin(tauri_plugin_notification::init())
        // Closing the window is not quitting: the office and the fleet keep
        // running behind the tray unless this machine was told otherwise.
        // Quit — from the tray or the app menu — never comes through here,
        // so it still reaches the teardown in `run` below.
        .on_window_event(|window, event| {
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let Some(state) = window.app_handle().try_state::<commands::HostState>() else {
                return;
            };
            let keep = background::keeps_running(&state.dir);
            if background::on_close(keep, state.server.is_some()) == background::OnClose::Hide {
                api.prevent_close();
                background::hide(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            update::check_for_update,
            update::install_update,
            update::update_state,
            update::dismiss_update,
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
            commands::keeps_running,
            commands::set_keeps_running,
            commands::notify,
            commands::set_attention,
            commands::list_servers,
            commands::add_server,
            commands::switch_server,
            commands::remove_server,
            commands::open_server_picker,
            commands::push_to_talk_chord,
            commands::set_push_to_talk_chord,
            commands::choose_personal_office,
            commands::personal_status,
            commands::personal_logs,
            commands::retry_personal_office,
            commands::restore_personal_backup,
        ])
        .setup(|app| {
            // Before anything looks for a binary. An app launched from Finder
            // inherits launchd's PATH, which contains none of the places agent
            // CLIs actually live — see `runtimes::adopt_login_path`.
            runtimes::adopt_login_path();

            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = secrets::SecretStore::new(&dir)?;

            // What this launch opens: a server, the personal office, or
            // nothing yet — which is not an error, it is the picker's reason
            // to exist.
            let choice = server::active_choice(&dir);

            // The personal office is *prepared* here — port chosen, payload
            // found, owner named — so its origin is known before the grant
            // and the window exist. It is *started* further down, once there
            // is a window to tell about it. Anything that stops it being
            // prepared becomes a status the bootstrap page shows, never a
            // reason the app fails to open: the page is where the explanation
            // and the way out both live.
            let personal: Option<Arc<personal::Office>> = match &choice {
                server::Choice::Personal => Some(Arc::new(prepare_personal(app, &dir, &store))),
                _ => None,
            };
            let server: Option<String> = match &choice {
                server::Choice::Personal => personal.as_ref().map(|office| office.origin()),
                server::Choice::Server(url) => Some(url.clone()),
                server::Choice::Nothing => None,
            };

            // Granted before the window goes anywhere: the server is the only
            // origin allowed to call this process, and it has to be in place
            // before the page it applies to has loaded.
            app.handle()
                .add_capability(server::capability(server.as_deref(), personal.is_some()))?;

            // A pre-servers registration belongs to whatever server was set
            // then, which is the one that is active now.
            if let server::Choice::Server(url) = &choice {
                if let Err(error) = machine::migrate_to(&store, url) {
                    eprintln!("[quintal] could not carry the machine registration over: {error}");
                }
            }

            app.manage(update::Checked::default());
            app.manage(commands::HostState {
                store,
                dir: dir.clone(),
                server: server.clone(),
                personal: personal.clone(),
                pending_export: std::sync::Mutex::new(None),
                fleet: spawn::Fleet::new(),
                attention: std::sync::atomic::AtomicU32::new(0),
            });

            tray::build(app.handle())?;
            tray::watch(app.handle());

            // A chord that fails to register is a line in the log, not a
            // reason the app cannot start: the page's own Space key still
            // works with the window focused.
            if let Err(error) = ptt::register(app.handle(), &ptt::chord(&dir)) {
                eprintln!("[quintal] push-to-talk: {error}");
            }

            // The window is built here rather than declared in the config so
            // it can carry two rules the config cannot express: it never
            // navigates off the server, and a link that wants a new window
            // gets the system browser unless it is the office's own page.
            // A link to the docs opened *inside* a webview holding the
            // keychain bridge would be a page with a grant it was never
            // meant to have.
            let home = server.clone();
            let navigation_home = home.clone();
            let window =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                    .title("Quintal")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(960.0, 640.0)
                    .resizable(true)
                    .on_navigation(move |url| {
                        match links::verdict(navigation_home.as_deref(), url) {
                            links::Verdict::Stay => true,
                            links::Verdict::OpenOutside => {
                                links::open_externally(url);
                                false
                            }
                            links::Verdict::Block => false,
                        }
                    })
                    .on_new_window(move |url, _features| {
                        match links::verdict(home.as_deref(), &url) {
                            links::Verdict::Stay => tauri::webview::NewWindowResponse::Allow,
                            links::Verdict::OpenOutside => {
                                links::open_externally(&url);
                                tauri::webview::NewWindowResponse::Deny
                            }
                            links::Verdict::Block => tauri::webview::NewWindowResponse::Deny,
                        }
                    })
                    .build()?;

            match (&choice, personal) {
                (server::Choice::Personal, Some(office)) => {
                    // The office's server, started now that there is a window
                    // to point at it. The bootstrap page shows progress from
                    // `personal_status` meanwhile; a failure before this point
                    // was recorded on the office and shows there too.
                    if office.status().phase != "failed" {
                        start_personal(office, window);
                    }
                }
                (server::Choice::Server(url), _) => match url.parse::<tauri::Url>() {
                    Ok(url) => wait_for_server(window, url),
                    Err(_) => {
                        // Leave the bootstrap page up rather than navigating
                        // somewhere unintended; it is the one screen that can
                        // say the server URL is wrong.
                        eprintln!("[quintal] not a usable server URL: {url}");
                        say(&window, &format!("{url} is not a usable server URL."));
                    }
                },
                // No server chosen yet. The bootstrap page is the picker,
                // and it is already showing.
                _ => {}
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running the Quintal desktop host")
        .run(|app, event| {
            // Closing the window must not leave a harness — or a server —
            // behind. Both are children of this process, and an orphan keeps
            // agents in the office that nobody can see or stop from here.
            match event {
                tauri::RunEvent::ExitRequested { .. } => {
                    if let Some(state) = app.try_state::<commands::HostState>() {
                        state.stop_everything();
                    }
                }
                // A click on the dock icon with the window hidden. Without
                // this the app is running, visibly, and cannot be opened from
                // the one place macOS teaches people to open things.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => tray::show_window(app),
                _ => {}
            }
        });
}

/// Everything the personal office needs decided before it can start.
///
/// Never fails the launch. Each thing that can go wrong — no payload in this
/// build, no runtime beside the executable, a keychain that will not open,
/// a data directory that cannot be written — is recorded as the office's
/// status, which the bootstrap page reads and explains, with a way to retry
/// and a way to the server picker. An app that refuses to open cannot say any
/// of that.
fn prepare_personal(
    app: &tauri::App,
    dir: &std::path::Path,
    store: &secrets::SecretStore,
) -> personal::Office {
    let version = app.package_info().version.to_string();
    let resource_dir = app.path().resource_dir().ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::PathBuf::from));

    // A stand-in payload, so an office that cannot start still has a status
    // to report through. Nothing is ever spawned from it.
    let placeholder = || personal::Payload {
        node: std::path::PathBuf::new(),
        entry: std::path::PathBuf::new(),
        web_dir: std::path::PathBuf::new(),
        manifest: personal::Manifest::default(),
    };
    let (payload, problem) =
        match personal::locate_payload(resource_dir.as_deref(), exe_dir.as_deref()) {
            Ok(payload) => (payload, None),
            Err(error) => (placeholder(), Some(error.to_string())),
        };

    // The owner, before the server exists: the server is told whose office
    // this is and refuses everybody else. A first run creates the key here —
    // there is no decision for the person to make, and the one case where
    // creating would be wrong, a locked keychain, is refused by the store.
    let (owner, problem) = match problem {
        Some(problem) => (String::new(), Some(problem)),
        None => match identity::load_or_create(store).and_then(|id| id.public_key_hex()) {
            Ok(pubkey) => (pubkey, None),
            Err(identity::IdentityError::Secrets(secrets::SecretsError::Locked)) => (
                String::new(),
                Some(
                    "Your keychain would not open, and the office cannot start without \
                     knowing whose it is. Unlock it and try again."
                        .to_string(),
                ),
            ),
            Err(error) => (
                String::new(),
                Some(format!("could not read your identity: {error}")),
            ),
        },
    };

    match personal::Office::prepare(dir, payload, &owner, &version) {
        Ok(office) => {
            if let Some(problem) = problem {
                office.fail(problem);
            }
            office
        }
        Err(error) => {
            // The data directory itself is the problem. Build an office over
            // a throwaway layout purely to carry the message.
            let office =
                personal::Office::prepare(&std::env::temp_dir(), placeholder(), "", &version)
                    .expect("a temporary directory is writable");
            office.fail(format!(
                "{error}. The office keeps its data under {}.",
                dir.display()
            ));
            office
        }
    }
}

/// Start the personal office and go to it when it answers.
///
/// Called again by the supervisor after a restart, in which case the window
/// is already on the office and is reloaded rather than navigated — the
/// page's sockets died with the old server and the fresh one has no memory
/// of them.
fn start_personal(office: Arc<personal::Office>, window: tauri::WebviewWindow) {
    say(&window, "Starting your personal office…");
    let arrived = std::sync::atomic::AtomicBool::new(false);
    office.start(move |origin| {
        if arrived.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let _ = window.eval("location.reload()");
            return;
        }
        if let Ok(url) = origin.parse::<tauri::Url>() {
            let _ = window.navigate(url);
        }
    });
}

/// Go to the server as soon as there is one, and say so meanwhile.
///
/// Navigating unconditionally is what made a stopped server look like a broken
/// app: the webview left the bootstrap page, failed to load, and showed a blank
/// window with nothing to read. The page already exists to say what is
/// happening — it just needed to be given the chance.
///
/// It keeps looking rather than giving up once, because starting the app before
/// the server is an ordinary order to do things in, and an app that fixes itself
/// beats one that needs relaunching.
fn wait_for_server(window: tauri::WebviewWindow, url: tauri::Url) {
    std::thread::spawn(move || {
        let mut explained = false;
        loop {
            if server::reachable(url.as_str()) {
                let _ = window.navigate(url);
                return;
            }
            if !explained {
                say(
                    &window,
                    &format!(
                        "Waiting for your server at {url} — nothing is answering there yet. \
                         Start it with `pnpm dev`, or open Quintal with `pnpm desktop`, \
                         which starts both.",
                    ),
                );
                explained = true;
            }
            std::thread::sleep(std::time::Duration::from_millis(1000));
        }
    });
}

/// Put a line on the bootstrap page.
///
/// Only lands in a bundled app, where the bootstrap page is what the webview
/// loads first. Under `tauri dev` the webview goes straight to `devUrl`, and
/// `tauri` itself waits for that server before launching — so there is no
/// blank-window moment in development for this to fill, and the eval quietly
/// finds nothing.
///
/// Serialised rather than interpolated: the server URL comes from a file on
/// disk, and a URL with a quote in it should be unreadable, not executable.
fn say(window: &tauri::WebviewWindow, message: &str) {
    let Ok(text) = serde_json::to_string(message) else {
        return;
    };
    let _ = window.eval(format!(
        "document.getElementById('status').textContent = {text};"
    ));
}
