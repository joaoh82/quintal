//! Push-to-talk from anywhere: a chord that works while Quintal is not the
//! front window.
//!
//! The web page already does push-to-talk with Space while it has the
//! keyboard. What only the app can do is hear the key when some other window
//! has it — which is when you most want to answer somebody without switching
//! away from your editor. A registered hotkey is enough for that: it needs
//! no Accessibility grant, because the system delivers the chord to us
//! rather than us watching every key.
//!
//! Press and release are both delivered, and both are forwarded to the page,
//! which drives the same `setTalking` the Space key does. Nothing about the
//! audio lives here: this file turns a chord into two booleans.

use std::path::Path;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::spawn::{self, SpawnError};

/// Unbound on macOS, Windows and most Linux desktops; ⌘⇧Space / Ctrl+Shift+Space.
pub const DEFAULT_CHORD: &str = "CommandOrControl+Shift+Space";

/// What the page defines to receive the key. Called with `true` on press and
/// `false` on release; a page without it (the settings screen, the login) is
/// simply not talking, which is right.
const PAGE_HOOK: &str = "window.__quintalPushToTalk";

#[derive(Debug, thiserror::Error)]
pub enum PttError {
    #[error("\"{0}\" is not a key chord the system understands")]
    BadChord(String),
    #[error("could not register the push-to-talk key: {0}")]
    Register(String),
    #[error(transparent)]
    Settings(#[from] SpawnError),
}

/// The chord in force on this machine.
pub fn chord(app_dir: &Path) -> String {
    spawn::read_settings(app_dir)
        .push_to_talk
        .filter(|chord| !chord.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CHORD.to_string())
}

/// Parse a chord the way the plugin will, so a typo is refused when it is
/// typed rather than discovered as a key that never fires.
pub fn parse(chord: &str) -> Result<Shortcut, PttError> {
    chord
        .trim()
        .parse::<Shortcut>()
        .map_err(|_| PttError::BadChord(chord.trim().to_string()))
}

/// Remember a chord. Empty means "back to the default".
pub fn set_chord(app_dir: &Path, chord: &str) -> Result<String, PttError> {
    let trimmed = chord.trim();
    let stored = if trimmed.is_empty() {
        None
    } else {
        parse(trimmed)?;
        Some(trimmed.to_string())
    };
    let mut settings = spawn::read_settings(app_dir);
    settings.push_to_talk = stored;
    spawn::write_settings(app_dir, &settings)?;
    Ok(self::chord(app_dir))
}

/// Register the chord with the system, replacing whatever was registered.
///
/// Press and release each become one call into the page. The page's hook is
/// looked up at call time, so a screen that has no voice — settings, the
/// login — just ignores the key.
pub fn register(app: &AppHandle, chord: &str) -> Result<(), PttError> {
    let shortcut = parse(chord)?;
    let shortcuts = app.global_shortcut();
    // Unregister everything we own first: this app registers exactly one.
    shortcuts
        .unregister_all()
        .map_err(|error| PttError::Register(error.to_string()))?;
    shortcuts
        .on_shortcut(shortcut, |app, _shortcut, event| {
            let down = matches!(event.state(), ShortcutState::Pressed);
            if let Some(window) = app.get_webview_window("main") {
                // A missing hook is `undefined && …`, which is nothing, which
                // is what a page with no voice should do with the key.
                let _ = window.eval(format!(
                    "{PAGE_HOOK} && {PAGE_HOOK}({});",
                    if down { "true" } else { "false" }
                ));
            }
        })
        .map_err(|error| PttError::Register(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_chord_parses() {
        parse(DEFAULT_CHORD).expect("the default must be a real chord");
    }

    #[test]
    fn a_chord_is_refused_when_typed_wrong() {
        assert!(matches!(parse("Cmd+Shift+"), Err(PttError::BadChord(_))));
        assert!(matches!(parse("not a chord"), Err(PttError::BadChord(_))));
        assert!(parse("Alt+Space").is_ok());
    }

    #[test]
    fn a_chord_is_remembered_beside_the_repos_directory_and_not_over_it() {
        let dir = tempfile::tempdir().unwrap();
        let repos = tempfile::tempdir().unwrap();
        spawn::set_repos_dir(dir.path(), repos.path()).unwrap();

        assert_eq!(chord(dir.path()), DEFAULT_CHORD, "unset means the default");
        assert_eq!(set_chord(dir.path(), "Alt+Space").unwrap(), "Alt+Space");
        assert_eq!(chord(dir.path()), "Alt+Space");
        assert_eq!(
            spawn::repos_dir(dir.path()),
            repos.path(),
            "saving the chord did not erase the other setting",
        );

        assert!(set_chord(dir.path(), "nope+").is_err());
        assert_eq!(
            chord(dir.path()),
            "Alt+Space",
            "a refused chord changes nothing"
        );
        assert_eq!(
            set_chord(dir.path(), "  ").unwrap(),
            DEFAULT_CHORD,
            "empty is the default again"
        );
    }
}
