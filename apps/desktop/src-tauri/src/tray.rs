//! The menu-bar presence.
//!
//! The app's whole claim is that your teammates are *there*. A window you have
//! to keep open to know whether anything is running undercuts that, so the tray
//! answers the two questions worth asking without one: is the fleet up, and can
//! I stop it.
//!
//! It reports **state, not size**. The plan asks for fleet size, and the honest
//! position is that this process does not know it: the harness is one child, and
//! how many agents it is supervising is a fact the *office* holds. The only
//! host-side source is a line the harness prints at startup, which goes stale
//! the moment an agent is enabled or disabled — a number that silently drifts
//! is worse than no number.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::HostState;
use crate::spawn::FleetState;

/// Menu item ids. Matched on the way back in, so they live in one place.
const OPEN: &str = "open";
const TOGGLE: &str = "toggle-fleet";
const OFFICES: &str = "offices";
const QUIT: &str = "quit";

pub fn build(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let menu = menu_for(app, &FleetState::Stopped)?;

    TrayIconBuilder::with_id("quintal")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("no default window icon to use in the tray".into())
        })?)
        .icon_as_template(true)
        .tooltip(tooltip(&FleetState::Stopped))
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN => show_window(app),
            TOGGLE => toggle_fleet(app),
            OFFICES => switch_office(app),
            QUIT => {
                // Through `exit`, so the fleet is stopped by the same teardown
                // that closing the window uses. Killing the process here would
                // leave the harness running with nothing to stop it.
                app.exit(0);
            }
            _ => {}
        })
        .build(app)
}

/// Bring the tray up to date with what the fleet is doing.
pub fn refresh(app: &AppHandle, state: &FleetState) {
    let Some(tray) = app.tray_by_id("quintal") else {
        return;
    };
    let _ = tray.set_tooltip(Some(tooltip(state)));
    if let Ok(menu) = menu_for(app, state) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn menu_for(app: &AppHandle, state: &FleetState) -> tauri::Result<Menu<Wry>> {
    let running = matches!(state, FleetState::Running { .. });
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, OPEN, "Open Quintal", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                TOGGLE,
                if running {
                    "Stop agents"
                } else {
                    "Start agents"
                },
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, OFFICES, "Switch office…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT, "Quit Quintal", true, None::<&str>)?,
        ],
    )
}

fn tooltip(state: &FleetState) -> String {
    match state {
        FleetState::Running { .. } => "Quintal — agents running".into(),
        FleetState::Stopped => "Quintal — agents not running".into(),
        // Worth saying in the one place somebody looks when the office has gone
        // quiet, rather than showing the same word as a deliberate stop.
        FleetState::Crashed { .. } => "Quintal — agents stopped on their own".into(),
    }
}

/// Keep the tray honest about a fleet that stopped on its own.
///
/// Everything else that changes the fleet also refreshes the tray, but a crash
/// has no caller — the harness simply goes away. Without a poll the icon would
/// keep claiming "running" until somebody clicked it, and the one tooltip that
/// exists to report a crash would never be seen.
///
/// Cheap: `status()` is a `try_wait` on a child this process owns, and the
/// menu is only rebuilt when the answer changes.
pub fn watch(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<FleetState> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let Some(state) = app.try_state::<HostState>() else {
                return;
            };
            let now = state.fleet.status();
            if last.as_ref() != Some(&now) {
                refresh(&app, &now);
                last = Some(now);
            }
        }
    });
}

/// Back to the picker. Restarts, like every office change does.
fn switch_office(app: &AppHandle) {
    let Some(state) = app.try_state::<HostState>() else {
        return;
    };
    if let Err(error) = crate::office::clear_active(&state.dir) {
        eprintln!("[quintal] tray: {error}");
        return;
    }
    let _ = state.fleet.stop();
    app.restart();
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_fleet(app: &AppHandle) {
    let Some(state) = app.try_state::<HostState>() else {
        return;
    };

    let next = if matches!(state.fleet.status(), FleetState::Running { .. }) {
        state.fleet.stop().err().map(|error| error.to_string())
    } else {
        match state.office.as_deref().map_or(Ok(None), |office| {
            crate::machine::token(&state.store, office)
        }) {
            Ok(Some(token)) => match state.office.as_deref() {
                Some(office) => {
                    let dir = crate::spawn::repos_dir(&state.dir);
                    state
                        .fleet
                        .start(&dir, office, &token)
                        .err()
                        .map(|error| error.to_string())
                }
                None => Some("no office is selected".into()),
            },
            // Nothing useful the tray can do about either: an unregistered
            // machine needs the office, and a locked keychain needs the OS.
            Ok(None) => Some("this machine has not registered with an office yet".into()),
            Err(error) => Some(error.to_string()),
        }
    };

    if let Some(message) = next {
        eprintln!("[quintal] tray: {message}");
        // An unregistered machine or a locked keychain cannot be fixed from a
        // menu. The window can at least say what is wrong, which beats a click
        // that appears to do nothing.
        show_window(app);
    }
    refresh(app, &state.fleet.status());
}
