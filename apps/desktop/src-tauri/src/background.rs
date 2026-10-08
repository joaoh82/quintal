//! Running without a window, and telling somebody who is not looking.
//!
//! The window used to be the app's lifetime: closing it quit, and quitting
//! stopped the fleet and the personal office. That made a habit — closing a
//! window — into the thing that ended every turn in flight. Now closing hides
//! the window and the tray is what is left, which is the moment the tray was
//! built for. Quitting is something you say, from the tray or the app menu.
//!
//! The second half follows from the first. An office nobody has a window on
//! needs another way to say an agent is waiting, so the page can ask this
//! process for a system notification and can tell the tray how many of its
//! owner's agents are waiting — see `tray.rs`.

use std::path::Path;

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::commands::HostState;
use crate::spawn::{self, SpawnError};

/// What closing the window does.
#[derive(Debug, PartialEq, Eq)]
pub enum OnClose {
    /// Keep everything running behind the tray.
    Hide,
    /// The old behaviour: the window going is the app going.
    Quit,
}

/// Decide it.
///
/// With no office chosen the window is the picker, and there is nothing
/// behind it to keep alive — hiding that would leave a process whose only
/// screen is one nobody can see. So the picker always quits.
pub fn on_close(keep_running: bool, has_office: bool) -> OnClose {
    if keep_running && has_office {
        OnClose::Hide
    } else {
        OnClose::Quit
    }
}

/// Whether this machine keeps Quintal running when the window is closed.
///
/// On unless somebody turns it off. The alternative default is the one that
/// loses work: an agent halfway through a turn is stopped by a click that
/// meant "get this out of my way".
pub fn keeps_running(app_dir: &Path) -> bool {
    spawn::read_settings(app_dir).keep_running.unwrap_or(true)
}

pub fn set_keeps_running(app_dir: &Path, enabled: bool) -> Result<(), SpawnError> {
    let mut settings = spawn::read_settings(app_dir);
    settings.keep_running = Some(enabled);
    spawn::write_settings(app_dir, &settings)
}

/// Where the tray lives, in the words this platform uses for it.
fn tray_place() -> &'static str {
    if cfg!(target_os = "macos") {
        "menu bar"
    } else {
        "system tray"
    }
}

/// Hide the window, and the first time, say that is what happened.
///
/// Once per machine. Without it the first close looks exactly like the quit
/// it used to be, and somebody finds out their agents were still running
/// from the bill.
pub fn hide(window: &tauri::Window) {
    let _ = window.hide();

    let app = window.app_handle();
    let Some(state) = app.try_state::<HostState>() else {
        return;
    };
    let mut settings = spawn::read_settings(&state.dir);
    if settings.told_still_running == Some(true) {
        return;
    }
    notify(
        app,
        "Quintal is still running",
        &format!(
            "Your office and your agents keep going. Open or quit Quintal from its icon in the {}.",
            tray_place()
        ),
    );
    settings.told_still_running = Some(true);
    if let Err(error) = spawn::write_settings(&state.dir, &settings) {
        eprintln!("[quintal] could not remember the still-running notice: {error}");
    }
}

/// Longest title and body a notification is given. The text comes from the
/// page, and the page is quoting an agent.
const TITLE_MAX: usize = 80;
const BODY_MAX: usize = 240;

/// Cut to a length, on a character boundary, and say that it was cut.
pub fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    clipped.push('…');
    clipped
}

/// Show a system notification. Best-effort: a machine with no notification
/// service is not a machine where the office should stop working.
pub fn notify(app: &AppHandle, title: &str, body: &str) {
    let shown = app
        .notification()
        .builder()
        .title(clip(title, TITLE_MAX))
        .body(clip(body, BODY_MAX))
        .show();
    if let Err(error) = shown {
        eprintln!("[quintal] notification: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_hides_only_when_asked_to_and_there_is_an_office() {
        assert_eq!(on_close(true, true), OnClose::Hide);
        assert_eq!(on_close(false, true), OnClose::Quit);
        // The picker has nothing behind it to keep running.
        assert_eq!(on_close(true, false), OnClose::Quit);
        assert_eq!(on_close(false, false), OnClose::Quit);
    }

    #[test]
    fn keeps_running_until_somebody_says_otherwise_and_remembers() {
        let dir = tempfile::tempdir().unwrap();
        assert!(keeps_running(dir.path()));
        set_keeps_running(dir.path(), false).unwrap();
        assert!(!keeps_running(dir.path()));
        set_keeps_running(dir.path(), true).unwrap();
        assert!(keeps_running(dir.path()));
    }

    #[test]
    fn changing_it_leaves_the_other_settings_alone() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = spawn::read_settings(dir.path());
        settings.push_to_talk = Some("Ctrl+Alt+T".into());
        spawn::write_settings(dir.path(), &settings).unwrap();

        set_keeps_running(dir.path(), false).unwrap();
        assert_eq!(
            spawn::read_settings(dir.path()).push_to_talk.as_deref(),
            Some("Ctrl+Alt+T")
        );
    }

    #[test]
    fn clips_on_a_character_boundary_and_marks_the_cut() {
        assert_eq!(clip("  short  ", 10), "short");
        assert_eq!(clip("abcdef", 4), "abc…");
        // Multi-byte: a byte slice here would panic or split a character.
        assert_eq!(clip("ááááá", 3), "áá…");
    }
}
