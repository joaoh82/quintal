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

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{include_image, AppHandle, Manager, Wry};

use crate::commands::HostState;
use crate::spawn::FleetState;

/// The tray's own artwork, baked in at compile time.
///
/// Not `default_window_icon()`, which is the full-colour app tile. macOS reads
/// a *template* icon as an alpha mask and tints it to match the menu bar, so
/// the tile would arrive there as a solid dark blob with the mark's courtyard
/// punched out of it. What the menu bar wants is the mark's alpha and nothing
/// else, which is exactly what `tray@2x.png` is.
///
/// The 44px asset rather than the 22px one beside it because `tray-icon` sets
/// the NSImage to 18 *points* and has no @2x representation logic: whatever it
/// is handed is what gets scaled, so 44 physical pixels is what stays sharp on
/// a Retina menu bar. `tray.png` is the 1x master, kept next to it.
#[cfg(target_os = "macos")]
const TRAY_ICON: Image<'static> = include_image!("icons/tray@2x.png");

/// Everywhere else, the icon is drawn exactly as given — `icon_as_template` is
/// a macOS-only affordance — and a black-on-transparent mark disappears into
/// the dark taskbar Windows 11 ships by default. So those platforms get the
/// tile, which brings its own paper background and reads against either.
#[cfg(not(target_os = "macos"))]
const TRAY_ICON: Image<'static> = include_image!("icons/tray-color.png");

/// Menu item ids. Matched on the way back in, so they live in one place.
const OPEN: &str = "open";
const TOGGLE: &str = "toggle-fleet";
const SERVERS: &str = "servers";
const QUIT: &str = "quit";

pub fn build(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let menu = menu_for(app, &FleetState::Stopped)?;

    TrayIconBuilder::with_id("quintal")
        .icon(TRAY_ICON)
        // macOS only. Elsewhere `TRAY_ICON` is already the coloured tile and
        // this call does nothing.
        .icon_as_template(true)
        .tooltip(tooltip(&FleetState::Stopped, 0))
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN => show_window(app),
            TOGGLE => toggle_fleet(app),
            SERVERS => switch_server(app),
            QUIT => {
                // Through `exit`, which reaches `ExitRequested` and the one
                // teardown — closing the window no longer does, it hides (see
                // `background.rs`), so this and the app menu's Quit are the
                // ways out. Killing the process here would leave the harness
                // running with nothing to stop it.
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
    let waiting = waiting(app);
    let _ = tray.set_tooltip(Some(tooltip(state, waiting)));
    // Text beside the icon where the platform draws it (the macOS menu bar,
    // a Linux indicator's label). A tooltip only answers somebody who is
    // already hovering; this is for the glance.
    let _ = tray.set_title(if waiting > 0 { Some("●") } else { None });
    if let Ok(menu) = menu_for(app, state) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn menu_for(app: &AppHandle, state: &FleetState) -> tauri::Result<Menu<Wry>> {
    let running = matches!(state, FleetState::Running { .. });
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, OPEN, open_label(waiting(app)), true, None::<&str>)?,
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
            &MenuItem::with_id(app, SERVERS, "Switch server…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT, "Quit Quintal", true, None::<&str>)?,
        ],
    )
}

/// How many of this person's agents the office says are waiting on them.
fn waiting(app: &AppHandle) -> u32 {
    app.try_state::<HostState>()
        .map(|state| {
            state
                .attention
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .waiting(crate::background::now_ms())
        })
        .unwrap_or(0)
}

fn open_label(waiting: u32) -> String {
    match waiting {
        0 => "Open Quintal".into(),
        1 => "Open Quintal — an agent is waiting for you".into(),
        n => format!("Open Quintal — {n} agents are waiting for you"),
    }
}

fn tooltip(state: &FleetState, waiting: u32) -> String {
    // Somebody waiting outranks how the fleet is: it is the one state here
    // that wants a person to do something.
    if waiting > 0 {
        return if waiting == 1 {
            "Quintal — an agent is waiting for you".into()
        } else {
            format!("Quintal — {waiting} agents are waiting for you")
        };
    }
    match state {
        FleetState::Running { .. } => "Quintal — agents running".into(),
        FleetState::Stopped => "Quintal — agents not running".into(),
        // Worth saying in the one place somebody looks when the server has gone
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
/// The same poll keeps the waiting count honest: a deadline passing sends no
/// event either, and the page that reported the count may be gone.
///
/// Cheap: `status()` is a `try_wait` on a child this process owns, the count
/// is a lock and a comparison, and the menu is only rebuilt when the answer
/// changes.
pub fn watch(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<(FleetState, u32)> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let Some(state) = app.try_state::<HostState>() else {
                return;
            };
            let now = (state.fleet.status(), waiting(&app));
            if last.as_ref() != Some(&now) {
                refresh(&app, &now.0);
                last = Some(now);
            }
        }
    });
}

/// Back to the picker. Restarts, like every server change does.
fn switch_server(app: &AppHandle) {
    let Some(state) = app.try_state::<HostState>() else {
        return;
    };
    if let Err(error) = crate::server::clear_active(&state.dir) {
        eprintln!("[quintal] tray: {error}");
        return;
    }
    state.stop_everything();
    app.restart();
}

pub(crate) fn show_window(app: &AppHandle) {
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
        // The same sequence the page runs — keys provisioned, then the
        // harness — so the tray cannot start a fleet the page would not.
        // Nothing useful the tray can do about a failure: an unregistered
        // machine needs the office, a locked keychain needs the OS.
        crate::commands::start_fleet_here(&state)
            .err()
            .map(|error| error.message)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn somebody_waiting_outranks_how_the_fleet_is() {
        let running = FleetState::Running { pid: 1 };
        assert_eq!(tooltip(&running, 0), "Quintal — agents running");
        assert_eq!(
            tooltip(&running, 1),
            "Quintal — an agent is waiting for you"
        );
        assert_eq!(
            tooltip(&FleetState::Stopped, 3),
            "Quintal — 3 agents are waiting for you"
        );
    }

    #[test]
    fn the_open_item_says_why_to_open() {
        assert_eq!(open_label(0), "Open Quintal");
        assert_eq!(open_label(1), "Open Quintal — an agent is waiting for you");
        assert_eq!(open_label(2), "Open Quintal — 2 agents are waiting for you");
    }
}
