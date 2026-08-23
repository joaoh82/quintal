//! The bridge, from the Rust side.
//!
//! Every command here is something a browser cannot do. Note what is *not*
//! here: nothing hands the secret key across. The web UI asks for a public key
//! or for a signature over a payload it supplies, so a bug in the page cannot
//! leak an identity the page never held.

use serde::Serialize;
use tauri::State;

use crate::identity::{self, IdentityError, IdentityState};
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
pub fn import_identity(state: State<'_, HostState>, secret: String) -> Result<String, HostError> {
    Ok(identity::import(&state.store, &secret)?)
}
