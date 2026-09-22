//! Updating the app, from the app.
//!
//! Quintal ships as an installer you downloaded once. Without this, the only
//! way to learn a newer one exists is to visit the download page and compare a
//! number nothing on screen was showing you — so in practice people run
//! whatever they installed the day they installed it, and bug reports arrive
//! against versions that were fixed months ago.
//!
//! Three rules shape what is here.
//!
//! **Silence on failure.** Offline, a DNS failure, an endpoint that 404s
//! because no release has published a manifest yet, a manifest that does not
//! parse — all of them mean "nothing to offer", not an error the person has to
//! dismiss before signing in. They are logged, because a permanently broken
//! updater that says nothing is its own bug, but they never reach the page.
//!
//! **Asked once per version.** Declining is an answer, not a snooze. The
//! declined version is remembered beside the other device preferences, and the
//! offer then lives on quietly in the UI rather than interrupting again.
//!
//! **Not everywhere can install.** A `.deb` under `/usr` belongs to apt, and a
//! copy still running from its mounted DMG cannot write over itself. Those are
//! not errors either: they are the case where the honest offer is a download
//! link and an instruction, which is why `Available` carries `can_install` and
//! a reason rather than letting the UI find out by failing.
//!
//! What is deliberately *not* here: choosing what gets installed. The endpoint
//! is compiled into `tauri.conf.json` and every payload is verified against the
//! public key baked into this binary before a single file is replaced. So the
//! worst a hostile office page can do by calling `install_update` is move this
//! machine onto a genuine, signed Quintal release — see `server::capability_for`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use crate::commands::{HostError, HostState};
use crate::spawn;

/// How long to wait on the manifest before deciding there is nothing to say.
///
/// Short on purpose. This runs while somebody is trying to use the app, and a
/// slow network must not become a slow launch — the answer "no update" and the
/// answer "could not ask" lead to exactly the same screen.
const CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// What the page defines to watch a download. Called with the fraction done,
/// or with `null` when the total size is unknown.
///
/// A page hook rather than a Tauri event channel, because that is how this app
/// already talks to its page — see `ptt.rs`. A screen with no progress bar
/// simply does not define it, which is the right thing for it to do.
const PROGRESS_HOOK: &str = "window.__quintalUpdateProgress";

/// An update worth telling somebody about.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    /// The version being offered.
    pub version: String,
    /// What is running now, so the UI can say "0.2.0 → 0.3.0" without guessing.
    pub current: String,
    /// Release notes, when the manifest carries them.
    pub notes: Option<String>,
    /// Publication date, as the manifest spelled it.
    pub date: Option<String>,
    /// Whether this copy can replace itself where it is installed.
    pub can_install: bool,
    /// Why it cannot, when it cannot. Shown instead of a button that would fail.
    pub blocked: Option<String>,
}

/// What the page needs to decide between asking and merely offering.
#[derive(Debug, Serialize)]
pub struct UpdateState {
    /// The version that was declined, if one was.
    pub dismissed: Option<String>,
}

/// The result of the one check this process makes, once it has been made.
///
/// `None` means "not asked yet". The inner `Option` is the answer: `None`
/// there means asked, and there is nothing newer.
#[derive(Default)]
pub struct Checked(pub Mutex<Option<Option<Available>>>);

/// Ask the endpoint, at most once per run of the app.
///
/// Two callers arriving together may both ask, which costs one extra request
/// and no correctness — worth it to avoid holding a lock across the network.
pub async fn ensure_checked(app: &AppHandle) -> Option<Available> {
    if let Some(answer) = app.state::<Checked>().0.lock().unwrap().clone() {
        return answer;
    }
    let answer = look(app).await;
    *app.state::<Checked>().0.lock().unwrap() = Some(answer.clone());
    answer
}

/// One request to the configured endpoint. Every failure is `None`.
async fn look(app: &AppHandle) -> Option<Available> {
    let updater = match app.updater_builder().timeout(CHECK_TIMEOUT).build() {
        Ok(updater) => updater,
        Err(error) => {
            // Configuration, not weather: no endpoint or no public key. Worth
            // saying loudly in the log because it can never come right on its
            // own, unlike a network that is merely down.
            eprintln!("[quintal] the updater is not configured: {error}");
            return None;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let (can_install, blocked) = installability();
            Some(Available {
                version: update.version.clone(),
                current: update.current_version.clone(),
                notes: update.body.clone(),
                date: update.date.map(|date| date.to_string()),
                can_install,
                blocked,
            })
        }
        Ok(None) => None,
        Err(error) => {
            eprintln!("[quintal] could not check for an update: {error}");
            None
        }
    }
}

/// Whether this copy can replace itself, and why not when it cannot.
fn installability() -> (bool, Option<String>) {
    #[cfg(target_os = "linux")]
    {
        // The updater can replace an AppImage and nothing else on Linux. A
        // `.deb` was installed under `/usr` by apt, which owns those files and
        // will overwrite them again on the next upgrade; replacing them behind
        // its back leaves the package database describing a version that is no
        // longer on disk.
        if std::env::var_os("APPIMAGE").is_none() {
            return (
                false,
                Some("This copy was installed by your package manager, so update it the way you installed it.".into()),
            );
        }
    }

    match install_root() {
        Some(root) if !writable(&root) => (
            false,
            Some(format!(
                "Quintal cannot write to {}. Copy it somewhere you own — Applications, usually — and open it from there.",
                root.display()
            )),
        ),
        _ => (true, None),
    }
}

/// The directory a replacement has to write into, when that is knowable.
fn install_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;

    #[cfg(target_os = "macos")]
    {
        // …/Quintal.app/Contents/MacOS/quintal-desktop. Replacing the app means
        // writing the bundle, so the directory that has to be writable is the
        // one *holding* it — /Applications for an installed copy, and a
        // read-only mount for one still being run out of its DMG.
        return exe.ancestors().nth(4).map(Path::to_path_buf);
    }

    #[cfg(target_os = "linux")]
    {
        // The AppImage replaces itself in place, so it is its own file's
        // directory that must be writable.
        if let Some(image) = std::env::var_os("APPIMAGE") {
            return PathBuf::from(image).parent().map(Path::to_path_buf);
        }
    }

    // Windows hands the NSIS installer the job and it elevates if it has to,
    // so a directory this process cannot write is not the answer there.
    #[cfg(target_os = "windows")]
    {
        let _ = exe;
        return None;
    }

    #[allow(unreachable_code)]
    exe.parent().map(Path::to_path_buf)
}

/// Can this process create a file in that directory?
///
/// Asked by trying, rather than by reading permission bits. The bits are a poor
/// predictor — a read-only mount, an immutable flag and an ACL all say "yes"
/// through `mode` and refuse the write anyway.
fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".quintal-write-probe-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

// --- commands ---------------------------------------------------------------

/// Is there a newer Quintal? Never fails; "could not ask" is `null`.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Option<Available> {
    ensure_checked(&app).await
}

/// What the page needs to know beyond the offer itself.
#[tauri::command]
pub fn update_state(state: State<'_, HostState>) -> UpdateState {
    UpdateState {
        dismissed: spawn::read_settings(&state.dir).dismissed_update,
    }
}

/// Remember that this version was declined, so it is not asked about again.
#[tauri::command]
pub fn dismiss_update(state: State<'_, HostState>, version: String) -> Result<(), HostError> {
    let mut settings = spawn::read_settings(&state.dir);
    settings.dismissed_update = Some(version);
    spawn::write_settings(&state.dir, &settings)?;
    Ok(())
}

/// Download the update, install it, and come back up on the new version.
///
/// The check is made again here rather than installing something decided
/// earlier: it costs one small request, and it means the bytes being installed
/// are the ones the endpoint is serving now. Either way the signature is what
/// makes this safe — an unsigned or wrongly signed payload is refused by the
/// plugin before anything on disk is touched.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), HostError> {
    let (can_install, blocked) = installability();
    if !can_install {
        return Err(HostError {
            code: "cannot_install".into(),
            message: blocked.unwrap_or_else(|| "This copy cannot update itself.".into()),
        });
    }

    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|error| HostError {
            code: "update_failed".into(),
            message: error.to_string(),
        })?;

    let update = updater
        .check()
        .await
        .map_err(|error| HostError {
            code: "update_failed".into(),
            message: error.to_string(),
        })?
        .ok_or_else(|| HostError {
            code: "no_update".into(),
            message: "There is nothing newer to install.".into(),
        })?;

    // Progress is reported as a fraction rather than a byte count: the page is
    // drawing a bar, and a manifest that omits the length would otherwise have
    // it drawing one against an unknown total.
    let window = app.get_webview_window("main");
    let mut downloaded: u64 = 0;
    let report = |window: &Option<tauri::WebviewWindow>, fraction: String| {
        if let Some(window) = window {
            let _ = window.eval(format!("{PROGRESS_HOOK} && {PROGRESS_HOOK}({fraction});"));
        }
    };

    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let fraction = match total {
                    Some(total) if total > 0 => {
                        format!("{:.4}", downloaded as f64 / total as f64)
                    }
                    _ => "null".to_string(),
                };
                report(&window, fraction);
            },
            || report(&window, "1".to_string()),
        )
        .await
        .map_err(|error| HostError {
            code: "update_failed".into(),
            message: error.to_string(),
        })?;

    // On Windows the installer has already taken the app down by this point and
    // this is never reached. Everywhere else the new version is on disk and
    // this process is still the old one, so it has to go.
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_directory_this_process_owns_is_writable() {
        let dir = tempfile::tempdir().unwrap();
        assert!(writable(dir.path()));
        assert!(
            std::fs::read_dir(dir.path()).unwrap().next().is_none(),
            "the probe cleans up after itself"
        );
    }

    #[test]
    fn a_directory_that_does_not_exist_is_not_writable() {
        // Stands in for the read-only mount: the probe fails, and the UI is
        // told to offer a download rather than a button that cannot work.
        let dir = tempfile::tempdir().unwrap();
        assert!(!writable(&dir.path().join("no-such-directory")));
    }

    #[test]
    fn a_declined_version_is_remembered_beside_the_other_preferences() {
        let dir = tempfile::tempdir().unwrap();
        let repos = tempfile::tempdir().unwrap();
        spawn::set_repos_dir(dir.path(), repos.path()).unwrap();

        assert_eq!(
            spawn::read_settings(dir.path()).dismissed_update,
            None,
            "nothing is declined until somebody declines it"
        );

        let mut settings = spawn::read_settings(dir.path());
        settings.dismissed_update = Some("0.3.0".into());
        spawn::write_settings(dir.path(), &settings).unwrap();

        assert_eq!(
            spawn::read_settings(dir.path()).dismissed_update.as_deref(),
            Some("0.3.0")
        );
        assert_eq!(
            spawn::repos_dir(dir.path()),
            repos.path(),
            "and declining did not erase the other settings"
        );
    }
}
