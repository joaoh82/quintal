//! The bridge, from the Rust side.
//!
//! Every command here is something a browser cannot do. Note what is *not*
//! here: nothing hands the secret key across. The web UI asks for a public key
//! or for a signature over a payload it supplies, so a bug in the page cannot
//! leak an identity the page never held.

use serde::Serialize;
use tauri::State;

use crate::identity::{self, IdentityError, IdentityState};
use crate::machine;
use crate::nip49::Nip49Error;
use crate::runtimes::{self, RuntimeStatus};
use crate::secrets::{SecretStore, SecretsError};
use crate::spawn::{self, Fleet, FleetState, LogLine, Repo, SpawnError};

pub struct HostState {
    pub store: SecretStore,
    /// The app data directory, for preferences that are not secrets.
    pub dir: std::path::PathBuf,
    /// The office this host is configured for.
    ///
    /// The page does not get to name it. IPC is already locked to one origin,
    /// so sending the machine credential somewhere else needs an XSS on the
    /// office — but the credential's destination deserves the same treatment as
    /// the command line: chosen here, not accepted from there.
    pub office: String,
    /// The harness this machine is running, if any.
    pub fleet: Fleet,
    /// Token handed out by the last `export_backup`, spent by `confirm_backup`.
    ///
    /// Confirming is what unlocks the wipe, so it must not be callable on its
    /// own: anything that can reach the bridge could otherwise confirm a backup
    /// nobody ever saw and then wipe the key. In memory only — a confirmation
    /// should not survive a restart the export did not.
    pub pending_export: std::sync::Mutex<Option<String>>,
}

/// An error the UI can branch on rather than only display.
///
/// `code` exists so "the keychain is locked" can be rendered as its own state
/// with its own way out, instead of a red string the user can do nothing about.
#[derive(Debug, Serialize)]
pub struct HostError {
    pub code: String,
    pub message: String,
}

impl From<SpawnError> for HostError {
    fn from(error: SpawnError) -> Self {
        let code = match &error {
            SpawnError::NotRegistered => "not_registered",
            SpawnError::NoHarness => "no_harness",
            SpawnError::AlreadyRunning => "already_running",
            SpawnError::NotRunning => "not_running",
            SpawnError::BadWorkspace(_) => "bad_workspace",
            SpawnError::Io(_) => "spawn_failed",
        };
        HostError {
            code: code.into(),
            message: error.to_string(),
        }
    }
}

impl From<IdentityError> for HostError {
    fn from(error: IdentityError) -> Self {
        let code = match &error {
            IdentityError::Secrets(SecretsError::Locked) => "locked",
            IdentityError::BadKey => "bad_key",
            IdentityError::NoBackupYet => "no_backup",
            IdentityError::EmptyLabel => "empty_label",
            IdentityError::WrongIdentity => "wrong_identity",
            IdentityError::Backup(Nip49Error::Undecryptable) => "bad_passphrase",
            IdentityError::Backup(Nip49Error::NotNcryptsec) => "not_a_backup",
            IdentityError::Backup(Nip49Error::CostTooHigh { .. }) => "cost_too_high",
            _ => "host_error",
        };
        HostError {
            code: code.into(),
            message: error.to_string(),
        }
    }
}

#[tauri::command]
pub fn has_identity(state: State<'_, HostState>) -> IdentityState {
    identity::state(&state.store)
}

/// The public key, creating one on a genuine first run.
///
/// Creation lives here rather than behind a separate "create" command because
/// there is no decision for the user to make: an app with no key cannot do
/// anything, and the one case where creating would be wrong — a locked
/// keychain — is refused further down rather than asked about.
#[tauri::command]
pub fn get_public_key(state: State<'_, HostState>) -> Result<String, HostError> {
    Ok(identity::load_or_create(&state.store)?.public_key_hex()?)
}

#[tauri::command]
pub fn sign_challenge(state: State<'_, HostState>, payload: String) -> Result<String, HostError> {
    Ok(identity::load_or_create(&state.store)?.sign(&payload)?)
}

#[tauri::command]
pub fn import_identity(
    state: State<'_, HostState>,
    secret: String,
    passphrase: Option<String>,
) -> Result<String, HostError> {
    let npub = identity::import(&state.store, &secret, passphrase.as_deref())?;

    // `identity::import` clears the confirmation on disk. This clears the other
    // half: a token from the *previous* identity's export is still outstanding
    // in memory, and would otherwise redeem straight back into a marker —
    // unlocking the wipe for a key nobody has ever written down. The disk half
    // alone does not close it, and the IPC check now proves that by failing
    // when this line is missing.
    *state.pending_export.lock().unwrap() = None;

    Ok(npub)
}

#[derive(Debug, Serialize)]
pub struct BackupPayload {
    pub blob: String,
    pub passphrase: String,
    /// Hand back to `confirm_backup`. Proves this export is the one being
    /// confirmed, rather than a confirmation conjured from nothing.
    pub token: String,
}

/// Produce a backup. Does **not** mark it stored — see `confirm_backup`.
#[tauri::command]
pub fn export_backup(
    state: State<'_, HostState>,
    passphrase: Option<String>,
) -> Result<BackupPayload, HostError> {
    let backup = identity::export(&state.store, passphrase.as_deref())?;

    let mut token_bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut token_bytes);
    let token = hex::encode(token_bytes);
    *state.pending_export.lock().unwrap() = Some(token.clone());

    Ok(BackupPayload {
        blob: backup.blob,
        passphrase: backup.passphrase,
        token,
    })
}

/// The person says they have stored the backup. This is what unlocks the wipe.
///
/// Separate from `export_backup` on purpose: a blob rendered on screen and
/// never written down is not a backup, and the wipe is the one action here that
/// cannot be taken back.
#[tauri::command]
pub fn confirm_backup(state: State<'_, HostState>, token: String) -> Result<(), HostError> {
    let mut pending = state.pending_export.lock().unwrap();
    match pending.as_deref() {
        Some(expected) if expected == token => {}
        _ => {
            return Err(HostError {
                code: "no_backup".into(),
                message: "Export a backup first; that confirmation does not match one.".into(),
            })
        }
    }
    // Spent, so one export confirms once.
    *pending = None;
    drop(pending);

    state.store.confirm_backup().map_err(IdentityError::from)?;
    Ok(())
}

#[tauri::command]
pub fn can_wipe(state: State<'_, HostState>) -> bool {
    state.store.backup_confirmed()
}

#[tauri::command]
pub fn wipe_identity(state: State<'_, HostState>) -> Result<(), HostError> {
    identity::wipe(&state.store)?;
    // Nothing left for a stale token to confirm.
    *state.pending_export.lock().unwrap() = None;
    Ok(())
}

/// What this machine could run.
///
/// Answered from the generated catalogue plus a PATH walk, so the office never
/// has to guess and never sees a runtime that would fail at spawn time. Not
/// cached here: the caller decides when to ask again, because "I just installed
/// it" is a thing that happens while the app is open.
#[tauri::command]
pub fn detect_runtimes() -> Vec<RuntimeStatus> {
    runtimes::detect()
}

/// What the office needs to know about this machine.
///
/// `registered` is the whole reason this exists: the office cannot see whether
/// this computer already holds a host token, and asking it to register a second
/// time would orphan the first — so the page checks here before it asks.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    /// What this machine should be called, matching the harness's name for it.
    pub label: String,
    /// Does this machine already hold a host token?
    pub registered: bool,
}

#[tauri::command]
pub fn host_status(state: State<'_, HostState>) -> Result<HostStatus, HostError> {
    // The registered name wins. Asking the OS again would let a change of
    // network rename this computer, and agents are pinned to a machine by
    // label — so the office would show a second machine and the fleet assigned
    // to the first would quietly stop booting.
    let registered = machine::registered_label(&state.store)?;
    Ok(HostStatus {
        label: registered.unwrap_or_else(machine::label),
        registered: machine::token(&state.store)?.is_some(),
    })
}

/// Keep a host token the office just issued to this machine.
///
/// The token arrives from the page rather than being fetched here: the office
/// is what holds the session cookie that authorises minting one, and teaching
/// this side to speak HTTP with the webview's cookie jar would be a second,
/// worse copy of a thing the page already does. The page cannot *read* the
/// token back afterwards — there is no command for that — so a later bug in the
/// office cannot exfiltrate the credential it once handed over.
#[tauri::command]
pub fn remember_host_token(
    state: State<'_, HostState>,
    token: String,
    label: String,
) -> Result<(), HostError> {
    machine::remember(&state.store, &token, &label)?;
    Ok(())
}

/// Drop this machine's host token, so the next launch registers again.
#[tauri::command]
pub fn forget_host_token(state: State<'_, HostState>) -> Result<(), HostError> {
    machine::forget(&state.store)?;
    Ok(())
}

/// Start the agents the office has assigned to this machine.
///
/// Takes no command and no runtime id. The harness asks the office what belongs
/// here and resolves each id through the shared catalogue itself, so there is no
/// argument on this call that could become something to execute.
#[tauri::command]
pub fn start_fleet(
    app: tauri::AppHandle,
    state: State<'_, HostState>,
) -> Result<FleetState, HostError> {
    let token = machine::token(&state.store)?.ok_or(SpawnError::NotRegistered)?;
    // Both the working directory and the office come from this side. The page
    // asks to start the fleet; it does not get to say where, or where the
    // credential is sent.
    let dir = spawn::repos_dir(&state.dir);
    let started = state.fleet.start(&dir, &state.office, &token)?;
    crate::tray::refresh(&app, &started);
    Ok(started)
}

#[tauri::command]
pub fn stop_fleet(app: tauri::AppHandle, state: State<'_, HostState>) -> Result<(), HostError> {
    state.fleet.stop()?;
    crate::tray::refresh(&app, &state.fleet.status());
    Ok(())
}

#[tauri::command]
pub fn fleet_status(state: State<'_, HostState>) -> FleetState {
    state.fleet.status()
}

/// Where this machine keeps its repositories.
#[tauri::command]
pub fn repos_dir(state: State<'_, HostState>) -> String {
    spawn::repos_dir(&state.dir).display().to_string()
}

/// What is in the repos directory.
///
/// The office cannot see anybody's filesystem, so without this a workspace has
/// to be typed exactly right from memory — and a typo becomes an agent rooted
/// somewhere that does not exist.
#[tauri::command]
pub fn list_repos(state: State<'_, HostState>) -> Vec<Repo> {
    // Deliberately takes no path. A directory argument from the page turns a
    // repo picker into a one-level filesystem walk of anywhere that exists.
    spawn::list_repos(&spawn::repos_dir(&state.dir))
}

/// Ask the person to choose a repos directory.
///
/// Wrapped rather than exposing the dialog plugin to the office: this way the
/// page can ask for a folder and nothing else. `None` means the dialog was
/// dismissed, which is an answer rather than an error.
#[tauri::command]
pub async fn pick_repos_dir(
    app: tauri::AppHandle,
    state: State<'_, HostState>,
) -> Result<Option<String>, HostError> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = tx.send(picked);
    });

    let Some(folder) = rx.recv().ok().flatten() else {
        // Dismissed. An answer, not a failure.
        return Ok(None);
    };

    // Persisted here, by the command that opened the dialog. An earlier version
    // returned the path and left storing it to the page, which quietly stored
    // it nowhere: the button changed a label and the harness kept rooting at the
    // old directory. Picking and remembering are one action or the feature is a
    // decoration.
    let chosen = folder.to_string();
    spawn::set_repos_dir(&state.dir, std::path::Path::new(&chosen))?;
    Ok(Some(chosen))
}

/// What the harness has said recently.
#[tauri::command]
pub fn fleet_logs(state: State<'_, HostState>) -> Vec<LogLine> {
    state.fleet.logs()
}

/// Whether Quintal opens when this computer starts.
///
/// Off until somebody asks for it. The office is where your agents live all
/// day, so wanting it there on login is reasonable — deciding that on somebody's
/// behalf is not.
#[tauri::command]
pub fn opens_at_login(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn set_opens_at_login(app: tauri::AppHandle, enabled: bool) -> Result<(), HostError> {
    use tauri_plugin_autostart::ManagerExt;

    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };

    result.map_err(|error| HostError {
        code: "autostart".into(),
        message: error.to_string(),
    })
}
