//! The bridge, from the Rust side.
//!
//! Every command here is something a browser cannot do. Note what is *not*
//! here: nothing hands the secret key across. The web UI asks for a public key
//! or for a signature over a payload it supplies, so a bug in the page cannot
//! leak an identity the page never held.

use serde::Serialize;
use tauri::State;

use crate::identity::{self, IdentityError, IdentityState};
use crate::nip49::Nip49Error;
use crate::secrets::{SecretStore, SecretsError};

pub struct HostState {
    pub store: SecretStore,
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

impl From<IdentityError> for HostError {
    fn from(error: IdentityError) -> Self {
        let code = match &error {
            IdentityError::Secrets(SecretsError::Locked) => "locked",
            IdentityError::BadKey => "bad_key",
            IdentityError::NoBackupYet => "no_backup",
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
    Ok(identity::import(
        &state.store,
        &secret,
        passphrase.as_deref(),
    )?)
}

#[derive(Debug, Serialize)]
pub struct BackupPayload {
    pub blob: String,
    pub passphrase: String,
}

/// Produce a backup. Does **not** mark it stored — see `confirm_backup`.
#[tauri::command]
pub fn export_backup(
    state: State<'_, HostState>,
    passphrase: Option<String>,
) -> Result<BackupPayload, HostError> {
    let backup = identity::export(&state.store, passphrase.as_deref())?;
    Ok(BackupPayload {
        blob: backup.blob,
        passphrase: backup.passphrase,
    })
}

/// The person says they have stored the backup. This is what unlocks the wipe.
///
/// Separate from `export_backup` on purpose: a blob rendered on screen and
/// never written down is not a backup, and the wipe is the one action here that
/// cannot be taken back.
#[tauri::command]
pub fn confirm_backup(state: State<'_, HostState>) -> Result<(), HostError> {
    state.store.confirm_backup().map_err(IdentityError::from)?;
    Ok(())
}

#[tauri::command]
pub fn can_wipe(state: State<'_, HostState>) -> bool {
    state.store.backup_confirmed()
}

#[tauri::command]
pub fn wipe_identity(state: State<'_, HostState>) -> Result<(), HostError> {
    Ok(identity::wipe(&state.store)?)
}
