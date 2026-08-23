//! Where secrets live on this machine.
//!
//! Everything is kept in **one** blob — a JSON map holding the identity nsec
//! alongside any `agent:<pubkey>` credentials — stored under a single keychain
//! entry. One entry rather than one per secret because macOS prompts per
//! entry: a fleet of ten agents would otherwise mean ten dialogs on launch,
//! and a person who is asked ten times learns to click through without reading.
//!
//! Two things here are load-bearing and easy to get subtly wrong.
//!
//! **A locked keychain is not an empty one.** If the marker says a key exists
//! and the keychain will not hand it over, that is a `Locked` state and the
//! caller must stop. Treating it as "no key yet" leads to generating a fresh
//! identity, which silently replaces the person's account and their office with
//! no way back — the keychain was merely locked, and their real key is still
//! sitting in it.
//!
//! **Writes are ordered so a crash cannot lose the only copy.** Store, read it
//! back bypassing any cache, fsync a marker, and only then remove whatever the
//! secret came from. A crash at any point leaves at least one readable copy.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};

/// Keychain service name. The account within it is always `SECRETS_KEY`.
const SERVICE: &str = "quintal-desktop";
const SECRETS_KEY: &str = "secrets";
/// Public half of the identity, kept in the clear so a locked keychain can still
/// be described to the person whose key it is.
const MARKER_FILE: &str = "identity.marker";
const SECRETS_FILE: &str = "secrets.json";
/// Written when the person confirms they have stored a backup. Gates the wipe.
const EXPORTED_MARKER: &str = "backup.confirmed";
const LOCK_FILE: &str = "secrets.lock";
const IDENTITY_SLOT: &str = "identity";

#[derive(Debug, thiserror::Error)]
pub enum SecretsError {
    #[error("the keychain holds a key but would not unlock it")]
    Locked,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("the stored secrets are not readable json: {0}")]
    Corrupt(#[from] serde_json::Error),
    #[error("keychain: {0}")]
    Keyring(String),
}

/// Which backend a store is talking to.
///
/// The file backend is a real fallback rather than a test seam — a Linux box
/// with no secret service running still has to work — but it is also what makes
/// this testable without a keychain prompt in the middle of a test run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Keychain,
    File,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Blob {
    #[serde(flatten)]
    pub slots: std::collections::BTreeMap<String, String>,
}

/// Keychain if this platform has one we can address, otherwise a file.
///
/// The probe is `Entry::new`, which fails when there is no credential store at
/// all — a Linux box with no secret service running. It deliberately does *not*
/// probe by reading: a read failure means the keychain is **locked**, and
/// falling back to an empty file there would look like a first run and mint a
/// replacement identity over a perfectly good one.
fn detect_backend() -> Backend {
    match keyring::Entry::new(SERVICE, SECRETS_KEY) {
        Ok(_) => Backend::Keychain,
        Err(error) => {
            eprintln!("[quintal] no OS keychain here ({error}); secrets will live in a 0600 file");
            Backend::File
        }
    }
}

pub struct SecretStore {
    dir: PathBuf,
    backend: Backend,
}

impl SecretStore {
    /// A store rooted at the app data directory.
    ///
    /// `QUINTAL_SECRETS_BACKEND=file` forces the file backend, which is how CI
    /// and the test suite avoid a keychain they cannot unlock.
    pub fn new(dir: impl Into<PathBuf>) -> Result<Self, SecretsError> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        let backend = match std::env::var("QUINTAL_SECRETS_BACKEND").as_deref() {
            Ok("file") => Backend::File,
            _ => detect_backend(),
        };
        Ok(Self { dir, backend })
    }

    pub fn with_backend(dir: impl Into<PathBuf>, backend: Backend) -> Result<Self, SecretsError> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        Ok(Self { dir, backend })
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }

    fn marker_path(&self) -> PathBuf {
        self.dir.join(MARKER_FILE)
    }

    fn secrets_path(&self) -> PathBuf {
        self.dir.join(SECRETS_FILE)
    }

    /// Has a backup been exported *and* confirmed stored?
    ///
    /// The gate on wiping. Exporting is not enough on its own: a blob shown on
    /// screen and never written down is not a backup, and the wipe is the one
    /// button here that cannot be undone.
    pub fn backup_confirmed(&self) -> bool {
        self.dir.join(EXPORTED_MARKER).exists()
    }

    /// Record that the person says they have stored the backup.
    pub fn confirm_backup(&self) -> Result<(), SecretsError> {
        write_synced(&self.dir.join(EXPORTED_MARKER), b"confirmed")
    }

    /// The npub recorded at the last successful write, if any.
    pub fn marker(&self) -> Option<String> {
        fs::read_to_string(self.marker_path())
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    /// Hold an exclusive lock for the duration of a write.
    ///
    /// Two instances of the app writing at once could interleave a
    /// read-modify-write and drop an agent credential; the lock is around the
    /// whole cycle, not just the store call.
    fn locked<T>(&self, body: impl FnOnce() -> Result<T, SecretsError>) -> Result<T, SecretsError> {
        let path = self.dir.join(LOCK_FILE);
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)?;
        FileExt::lock_exclusive(&file)?;
        let result = body();
        let _ = FileExt::unlock(&file);
        result
    }

    // --- backends -----------------------------------------------------------

    fn read_raw(&self) -> Result<Option<String>, SecretsError> {
        match self.backend {
            Backend::File => match fs::read_to_string(self.secrets_path()) {
                Ok(text) => Ok(Some(text)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            },
            Backend::Keychain => {
                // A fresh Entry every time, deliberately: reusing one can serve
                // a cached value, and a read-back that reads our own cache
                // proves nothing about what the keychain actually stored.
                let entry = keyring::Entry::new(SERVICE, SECRETS_KEY)
                    .map_err(|e| SecretsError::Keyring(e.to_string()))?;
                match entry.get_password() {
                    Ok(text) => Ok(Some(text)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(e) => Err(SecretsError::Keyring(e.to_string())),
                }
            }
        }
    }

    fn write_raw(&self, text: &str) -> Result<(), SecretsError> {
        match self.backend {
            Backend::File => {
                // Atomic: write beside the target and rename, so a crash leaves
                // either the old file or the new one and never half of either.
                let tmp = self.secrets_path().with_extension("json.tmp");
                write_private(&tmp, text.as_bytes())?;
                fs::rename(&tmp, self.secrets_path())?;
                Ok(())
            }
            Backend::Keychain => {
                let entry = keyring::Entry::new(SERVICE, SECRETS_KEY)
                    .map_err(|e| SecretsError::Keyring(e.to_string()))?;
                entry
                    .set_password(text)
                    .map_err(|e| SecretsError::Keyring(e.to_string()))
            }
        }
    }

    // --- the blob -----------------------------------------------------------

    /// Read the blob.
    ///
    /// `Err(Locked)` when a marker says an identity exists but the backend will
    /// not produce it. That distinction is the whole reason the marker exists.
    pub fn load(&self) -> Result<Blob, SecretsError> {
        match self.read_raw() {
            Ok(Some(text)) => Ok(serde_json::from_str(&text)?),
            Ok(None) => {
                if self.marker().is_some() {
                    // The marker is written only after a verified store, so its
                    // presence means a key was really there. Something removed
                    // or locked the entry; either way, do not start over.
                    Err(SecretsError::Locked)
                } else {
                    Ok(Blob::default())
                }
            }
            Err(SecretsError::Keyring(message)) => {
                if self.marker().is_some() {
                    Err(SecretsError::Locked)
                } else {
                    Err(SecretsError::Keyring(message))
                }
            }
            Err(other) => Err(other),
        }
    }

    /// Store the blob, prove it landed, then record the marker.
    ///
    /// `npub` is the public identity to record. The read-back is what turns
    /// "the API returned Ok" into "the bytes are retrievable", which are not the
    /// same claim on any of the three platform keychains.
    pub fn store(&self, blob: &Blob, npub: &str) -> Result<(), SecretsError> {
        self.locked(|| {
            let text = serde_json::to_string(blob)?;
            self.write_raw(&text)?;

            let back = self
                .read_raw()?
                .ok_or_else(|| SecretsError::Keyring("stored secret did not read back".into()))?;
            let parsed: Blob = serde_json::from_str(&back)?;
            if parsed.slots.get(IDENTITY_SLOT) != blob.slots.get(IDENTITY_SLOT) {
                return Err(SecretsError::Keyring(
                    "stored secret read back as something else".into(),
                ));
            }

            // Marker last, and fsynced: it is the thing that later says "a key
            // exists", so it must never appear before the key it describes.
            write_synced(&self.marker_path(), npub.as_bytes())?;
            Ok(())
        })
    }

    /// Remove everything. Used by "sign out & wipe", which is gated in the UI.
    pub fn wipe(&self) -> Result<(), SecretsError> {
        self.locked(|| {
            match self.backend {
                Backend::File => {
                    let _ = fs::remove_file(self.secrets_path());
                }
                Backend::Keychain => {
                    if let Ok(entry) = keyring::Entry::new(SERVICE, SECRETS_KEY) {
                        let _ = entry.delete_credential();
                    }
                }
            }
            let _ = fs::remove_file(self.marker_path());
            let _ = fs::remove_file(self.dir.join(EXPORTED_MARKER));
            Ok(())
        })
    }
}

/// Write a file only this user can read, replacing any existing content.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), SecretsError> {
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// Write and fsync, so the marker survives a power cut rather than sitting in a
/// buffer that never reaches the disk.
fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), SecretsError> {
    write_private(path, bytes)?;
    // Sync the directory entry too: on most filesystems the file's own fsync
    // does not guarantee the name is durable.
    if let Some(parent) = path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

/// Read a whole file, for callers that only care whether it is there.
#[allow(dead_code)]
fn read_all(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut out = String::new();
    file.read_to_string(&mut out).ok()?;
    Some(out)
}
