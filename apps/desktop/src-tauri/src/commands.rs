//! The bridge, from the Rust side.
//!
//! Every command here is something a browser cannot do. Note what is *not*
//! here: nothing hands the secret key across. The web UI asks for a public key
//! or for a signature over a payload it supplies, so a bug in the page cannot
//! leak an identity the page never held.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::agent_keys;
use crate::identity::{self, IdentityError, IdentityState};
use crate::machine;
use crate::nip49::Nip49Error;
use crate::personal;
use crate::runtimes::{self, RuntimeStatus};
use crate::secrets::{SecretStore, SecretsError};
use crate::spawn::{self, Fleet, FleetState, LogLine, Repo, SpawnError};

pub struct HostState {
    pub store: SecretStore,
    /// The app data directory, for preferences that are not secrets.
    pub dir: std::path::PathBuf,
    /// The server this host is configured for, or none before one is chosen.
    ///
    /// The page does not get to name it. IPC is already locked to one origin,
    /// so sending the machine credential somewhere else needs an XSS on the
    /// office — but the credential's destination deserves the same treatment as
    /// the command line: chosen here, not accepted from there.
    pub server: Option<String>,
    /// The office this app is running itself, when this launch is the
    /// personal office. `server` is then its loopback origin.
    pub personal: Option<Arc<personal::Office>>,
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

impl HostState {
    /// The name every per-server secret is filed under.
    ///
    /// A server's URL, for a server. For the personal office, the word
    /// `personal`: its URL is whichever loopback port was free, and a machine
    /// registration or an agent key filed under a port would be lost the day
    /// the port moved. The office is the same office; the key says so.
    pub fn slot(&self) -> Option<&str> {
        if self.personal.is_some() {
            Some(personal::PERSONAL)
        } else {
            self.server.as_deref()
        }
    }

    /// Stop every child this app started: the fleet, and the personal
    /// office's server if this launch is one. The one teardown, called from
    /// every exit path.
    pub fn stop_everything(&self) {
        let _ = self.fleet.stop();
        if let Some(office) = &self.personal {
            office.stop();
        }
    }
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
            SpawnError::NoServer => "no_server",
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

impl From<personal::PersonalError> for HostError {
    fn from(error: personal::PersonalError) -> Self {
        let code = match &error {
            personal::PersonalError::NoPayload(_) => "no_payload",
            personal::PersonalError::NoRuntime => "no_runtime",
            personal::PersonalError::AlreadyRunning => "already_running",
            personal::PersonalError::NoBackup => "no_backup_to_restore",
            personal::PersonalError::NotRestorable => "not_restorable",
            personal::PersonalError::Io(_) => "office_failed",
        };
        HostError {
            code: code.into(),
            message: error.to_string(),
        }
    }
}

impl From<crate::ptt::PttError> for HostError {
    fn from(error: crate::ptt::PttError) -> Self {
        let code = match &error {
            crate::ptt::PttError::BadChord(_) => "bad_chord",
            crate::ptt::PttError::Register(_) => "shortcut",
            crate::ptt::PttError::Settings(_) => "settings",
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
            IdentityError::Office(_) => "office",
            IdentityError::StaleHostToken => "stale_token",
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
    /// The name this machine last registered under here, token or no token.
    ///
    /// Present and `registered: false` is the state worth naming: this office
    /// knew this computer as `known_as`, and does not any more. The page needs
    /// to tell those two apart, because "name your computer" and "your
    /// computer was called X — claim it back" are different questions, and
    /// asking the first one where the second belongs is how the agents pinned
    /// to X end up with nowhere to run.
    pub known_as: Option<String>,
}

#[tauri::command]
pub fn host_status(state: State<'_, HostState>) -> Result<HostStatus, HostError> {
    // The registered name wins. Asking the OS again would let a change of
    // network rename this computer, and agents are pinned to a machine by
    // label — so the office would show a second machine and the fleet assigned
    // to the first would quietly stop booting.
    // Per server: the same laptop is registered separately in each, so "is
    // this machine registered" is only a question you can ask about one.
    let Some(slot) = state.slot() else {
        return Ok(HostStatus {
            label: machine::label(),
            registered: false,
            known_as: None,
        });
    };
    let known_as = machine::registered_label(&state.store, slot)?;
    Ok(HostStatus {
        label: known_as.clone().unwrap_or_else(machine::label),
        registered: machine::token(&state.store, slot)?.is_some(),
        known_as,
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
    let slot = state.slot().ok_or(SpawnError::NoServer)?;
    machine::remember(&state.store, slot, &token, &label)?;
    Ok(())
}

/// Drop this machine's host token, so the next launch registers again.
///
/// The *name* stays. Registering again is how you take this machine back, and
/// the name is what says which machine that is — see `machine::forget_token_for`.
#[tauri::command]
pub fn forget_host_token(state: State<'_, HostState>) -> Result<(), HostError> {
    let slot = state.slot().ok_or(SpawnError::NoServer)?;
    machine::forget_token_for(&state.store, slot)?;
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
    let started = start_fleet_here(&state)?;
    crate::tray::refresh(&app, &started);
    Ok(started)
}

/// Start the fleet, from the page or from the tray: the one place the
/// sequence lives.
///
/// Both the working directory and the office come from this side. The page
/// asks to start the fleet; it does not get to say where, or where the
/// credential is sent.
pub fn start_fleet_here(state: &HostState) -> Result<FleetState, HostError> {
    let server = state.server.as_deref().ok_or(SpawnError::NoServer)?;
    // Where the credentials are filed; the URL is where they are sent. The
    // two differ for the personal office, whose port can move.
    let slot = state.slot().ok_or(SpawnError::NoServer)?;
    let token = machine::token(&state.store, slot)?.ok_or(SpawnError::NotRegistered)?;
    let dir = spawn::repos_dir(&state.dir);

    // Every agent assigned here gets a key of its own before the harness is
    // started — generated into the keychain, vouched for by this identity,
    // registered with the machine's token — and the harness receives the
    // map in its environment. An agent the office would not take a key for
    // is reported and boots on the host token while legacy credentials last.
    let office = agent_keys::HttpOffice::new(server, &token);
    let provisioned = match agent_keys::provision(&state.store, slot, &office) {
        Ok(provisioned) => provisioned,
        Err(IdentityError::StaleHostToken) => {
            // Drop the token so the next status check reports unregistered and
            // the UI offers to register with *this* office, rather than
            // retrying one this office has already refused.
            //
            // The name survives it. A 401 here is not always somebody revoking
            // a machine on purpose — a dev server pointed at a fresh database
            // answers exactly the same way — and forgetting what this computer
            // was called turns a re-registration into a *second* machine, with
            // every agent still pinned to the first.
            let _ = machine::forget_token_for(&state.store, slot);
            let known = machine::registered_label(&state.store, slot).ok().flatten();
            state.fleet.note(match &known {
                Some(label) => format!(
                    "this office no longer recognises this computer's token; \
                     it was registered as {label} — register under that name \
                     again to take it back"
                ),
                None => "this office no longer recognises this computer's token; \
                         register this machine again"
                    .to_string(),
            });
            return Err(IdentityError::StaleHostToken.into());
        }
        Err(error) => return Err(error.into()),
    };
    let keys = agent_keys::env_value(&provisioned.keys);

    let started = state.fleet.start(&dir, server, &token, Some(&keys))?;
    for name in &provisioned.registered {
        state.fleet.note(format!("registered a key for {name}"));
    }
    for skipped in &provisioned.skipped {
        state.fleet.note(format!(
            "{}: no key of its own ({}) — joining with the host token",
            skipped.name, skipped.why
        ));
    }
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

// --- servers ----------------------------------------------------------------

/// Every server this app knows about, and which one is live.
///
/// A server is an environment rather than a setting: its own people, its own
/// agents, its own registration of this machine. Nothing crosses between two,
/// which is why they are a list you move between.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerList {
    pub servers: Vec<crate::server::Server>,
    /// A server's URL, the word `personal`, or nothing on a first run.
    pub active: Option<String>,
    /// The personal office, when this launch is one: where it is, for the
    /// pages that show which place you are in. Not in `servers` — it is not
    /// somewhere you add or forget, and its address is not one to keep.
    pub personal: Option<PersonalEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalEntry {
    pub url: String,
    pub label: String,
}

fn listed(state: &HostState) -> ServerList {
    let stored = crate::server::load_servers(&state.dir);
    ServerList {
        servers: stored.servers,
        active: stored.active,
        personal: state.personal.as_ref().map(|office| PersonalEntry {
            url: office.origin(),
            label: "Personal office".into(),
        }),
    }
}

#[tauri::command]
pub fn list_servers(state: State<'_, HostState>) -> ServerList {
    listed(&state)
}

#[tauri::command]
pub fn add_server(
    state: State<'_, HostState>,
    url: String,
    label: Option<String>,
) -> Result<ServerList, HostError> {
    crate::server::add_server(&state.dir, &url, label).map_err(|message| HostError {
        code: "bad_server".into(),
        message,
    })?;
    Ok(listed(&state))
}

/// Make a server the live one, and restart into it.
///
/// The restart is the feature, not a shortcut. IPC is granted to exactly one
/// origin at startup, so switching in place would leave the server you left
/// still able to ask this process for a signature for the rest of the session.
/// Coming up fresh is how "these two do not talk to each other" stays true
/// rather than mostly true.
#[tauri::command]
pub fn switch_server(
    app: tauri::AppHandle,
    state: State<'_, HostState>,
    url: String,
) -> Result<(), HostError> {
    crate::server::switch_server(&state.dir, &url).map_err(|message| HostError {
        code: "bad_server".into(),
        message,
    })?;

    // Stop the fleet before going: these agents belong to the server being
    // left, and the next one will start its own. The personal office's
    // server goes too, if this launch was one.
    state.stop_everything();
    app.restart();
}

#[tauri::command]
pub fn remove_server(state: State<'_, HostState>, url: String) -> Result<ServerList, HostError> {
    let (removed, _) =
        crate::server::remove_server(&state.dir, &url).map_err(|message| HostError {
            code: "bad_server".into(),
            message,
        })?;
    // The machine registration for that server goes with it — it names a
    // machine in a server this app no longer has. Keyed on the *normalised*
    // URL, which is what the slot was written under.
    let _ = machine::forget_for(&state.store, &removed);
    Ok(listed(&state))
}

/// Go back to the server picker, restarting into it.
#[tauri::command]
pub fn open_server_picker(
    app: tauri::AppHandle,
    state: State<'_, HostState>,
) -> Result<(), HostError> {
    crate::server::clear_active(&state.dir).map_err(|message| HostError {
        code: "bad_server".into(),
        message,
    })?;
    state.stop_everything();
    app.restart();
}

// --- the personal office ------------------------------------------------------

/// Make the personal office what the app opens, and restart into it.
///
/// The picker's other button. Restarts for the same reason switching servers
/// does: the office's origin is granted IPC at startup and nowhere else.
#[tauri::command]
pub fn choose_personal_office(
    app: tauri::AppHandle,
    state: State<'_, HostState>,
) -> Result<(), HostError> {
    crate::server::choose_personal(&state.dir).map_err(|message| HostError {
        code: "bad_server".into(),
        message,
    })?;
    state.stop_everything();
    app.restart();
}

/// What the personal office is doing: starting, ready, failed or stopped.
///
/// The page shown while it comes up polls this to say something truthful —
/// "starting", "backing up", "it crashed and here is why" — instead of a
/// blank window. Answers a stopped state when this launch is not a personal
/// office at all.
#[tauri::command]
pub fn personal_status(state: State<'_, HostState>) -> personal::Status {
    match &state.personal {
        Some(office) => office.status(),
        None => personal::Status {
            phase: "stopped".into(),
            origin: None,
            message: None,
            restarts: 0,
            pid: None,
            data_dir: personal::Layout::under(&state.dir)
                .root()
                .display()
                .to_string(),
            backup: None,
            restorable: false,
        },
    }
}

/// What the office's server has said recently, for the page and for a bug
/// report. Bounded like the fleet's.
#[tauri::command]
pub fn personal_logs(state: State<'_, HostState>) -> Vec<LogLine> {
    state
        .personal
        .as_ref()
        .map(|office| office.logs())
        .unwrap_or_default()
}

/// Try again, from the top.
///
/// A failed office — a crash loop, a locked keychain, a port that was
/// taken — is fixed by a fresh launch, which re-chooses the port, re-reads
/// the keychain and re-grants the origin. That is what this does, and all it
/// does: it changes no setting, so a page that called it through XSS could
/// only make the app come back up as it was.
#[tauri::command]
pub fn retry_personal_office(app: tauri::AppHandle, state: State<'_, HostState>) {
    state.stop_everything();
    app.restart();
}

/// Put back the copy of the database taken before this version ran.
///
/// The other half of the backup, and the reason it is taken: an upgrade whose
/// migration fails leaves somebody with a broken office, a path in a log and a
/// paragraph in `docs/DESKTOP.md` about copying files around with the app shut.
/// This is that paragraph, as a button.
///
/// It takes no arguments on purpose. The page does not name the backup — the
/// office restores the one *it* took this launch, so the worst a hostile page
/// can do is ask for the thing the screen was already offering. And the office
/// refuses even that unless this launch failed before it ever opened; see
/// `Office::restore`.
#[tauri::command]
pub fn restore_personal_backup(state: State<'_, HostState>) -> Result<personal::Status, HostError> {
    let Some(office) = state.personal.as_ref() else {
        return Err(HostError {
            code: "no_office".into(),
            message: "This launch is not a personal office.".into(),
        });
    };
    Ok(office.restore()?)
}

// --- push-to-talk -----------------------------------------------------------

/// The chord that talks while some other window has the keyboard.
#[tauri::command]
pub fn push_to_talk_chord(state: State<'_, HostState>) -> String {
    crate::ptt::chord(&state.dir)
}

/// Change it. Empty restores the default. Refused, and unchanged, for a chord
/// the system cannot register — a key that never fires is worse than a
/// message.
#[tauri::command]
pub fn set_push_to_talk_chord(
    app: tauri::AppHandle,
    state: State<'_, HostState>,
    chord: String,
) -> Result<String, HostError> {
    let stored = crate::ptt::set_chord(&state.dir, &chord)?;
    crate::ptt::register(&app, &stored)?;
    Ok(stored)
}

// --- this build -------------------------------------------------------------

/// Which version of the app this is.
///
/// The number Tauri stamped this bundle with, which `check-release-version.mjs`
/// pins to every other manifest at release — so it is the same number the
/// release tag, the download page and `SHA256SUMS.txt` are talking about.
///
/// Its own command rather than granting `core:app:allow-version`, which answers
/// the same question: the bridge is the one surface the page knows about, and a
/// second way in is a second thing to grant and a second thing to keep true.
#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg(test)]
mod version_tests {
    /// The crate version and the Tauri config version must agree.
    ///
    /// `app_version` answers from whichever one Tauri resolved, and the UI
    /// prints that beside the office's own number — so a disagreement here
    /// makes the app claim a version no release ever had.
    /// `scripts/check-release-version.mjs` catches this at release time, which
    /// is late: the mistake is made in the same commit that bumps one of them.
    #[test]
    fn the_crate_version_matches_the_tauri_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["version"].as_str(),
            Some(env!("CARGO_PKG_VERSION")),
            "tauri.conf.json and Cargo.toml disagree about this app's version"
        );
    }
}
