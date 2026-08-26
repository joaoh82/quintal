//! The key this machine signs with.
//!
//! Everything the office needs from the host reduces to two questions: what is
//! your public key, and will you sign this challenge. The secret never crosses
//! the bridge — the web UI asks for a signature, not for a key — so a bug in
//! the page cannot exfiltrate an identity that a bug in the page never held.

use bech32::{Bech32, Hrp};
use k256::schnorr::signature::hazmat::RandomizedPrehashSigner;
use k256::schnorr::SigningKey;
use serde::Serialize;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::nip49::{self, Nip49Error};
use crate::secrets::{Blob, SecretStore, SecretsError};

pub(crate) const IDENTITY_SLOT: &str = "identity";

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error(transparent)]
    Secrets(#[from] SecretsError),
    #[error("that is not a usable secret key")]
    BadKey,
    #[error("could not encode a key: {0}")]
    Encoding(String),
    #[error(transparent)]
    Backup(#[from] Nip49Error),
    #[error("that backup is for a different identity")]
    WrongIdentity,
    #[error("export a backup and confirm you have stored it before wiping")]
    NoBackupYet,
    #[error("register a machine only once this app has an identity")]
    NoIdentityYet,
    #[error("a host token cannot be empty")]
    EmptyToken,
    #[error("a machine needs a name")]
    EmptyLabel,
}

/// What the UI is allowed to know about the state of the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IdentityState {
    /// No key yet — a first run, and the only state in which one may be made.
    None,
    Ready,
    /// A key exists and the keychain will not open. Never treat this as `None`.
    Locked,
}

/// Read `QUINTAL_PRIVATE_KEY`, for CI and for a dev box that should not touch a
/// real keychain. Accepted as hex or nsec, used in memory, never written down.
fn key_from_env() -> Option<Zeroizing<[u8; 32]>> {
    let raw = std::env::var("QUINTAL_PRIVATE_KEY").ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    decode_secret(trimmed).ok()
}

/// Accept either a bare hex key or an `nsec1…`.
pub fn decode_secret(input: &str) -> Result<Zeroizing<[u8; 32]>, IdentityError> {
    let input = input.trim();
    let bytes = if input.starts_with("nsec1") {
        let (hrp, data) = bech32::decode(input).map_err(|_| IdentityError::BadKey)?;
        if hrp.as_str() != "nsec" {
            return Err(IdentityError::BadKey);
        }
        data
    } else {
        hex::decode(input).map_err(|_| IdentityError::BadKey)?
    };
    let array: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| IdentityError::BadKey)?;
    Ok(Zeroizing::new(array))
}

fn encode_bech32(hrp: &str, data: &[u8]) -> Result<String, IdentityError> {
    let hrp = Hrp::parse(hrp).map_err(|e| IdentityError::Encoding(e.to_string()))?;
    bech32::encode::<Bech32>(hrp, data).map_err(|e| IdentityError::Encoding(e.to_string()))
}

pub fn nsec_of(secret: &[u8; 32]) -> Result<String, IdentityError> {
    encode_bech32("nsec", secret)
}

pub fn npub_of(pubkey: &[u8; 32]) -> Result<String, IdentityError> {
    encode_bech32("npub", pubkey)
}

pub(crate) fn signing_key(secret: &[u8; 32]) -> Result<SigningKey, IdentityError> {
    SigningKey::from_bytes(secret).map_err(|_| IdentityError::BadKey)
}

/// x-only public key for a secret, lowercase hex.
pub fn public_key_hex(secret: &[u8; 32]) -> Result<String, IdentityError> {
    let key = signing_key(secret)?;
    Ok(hex::encode(key.verifying_key().to_bytes()))
}

/// Sign a canonical payload: BIP-340 over sha256(payload), lowercase hex.
///
/// **`sign_prehash`, not `sign`.** k256's plain `Signer` impl hashes whatever
/// it is handed — `verify` is literally `verify_digest(Sha256::new_with_prefix(msg))`
/// — so passing the digest to it signs `sha256(sha256(payload))`. That produces
/// a perfectly valid signature over the wrong message, which the office rejects
/// with no hint as to why. The prehash variants treat the 32 bytes as the
/// message, which is what `@noble/curves` does on the web side.
///
/// Randomised auxiliary data rather than the zeros `sign_prehash` defaults to:
/// BIP-340 recommends it, and noble uses it too.
pub fn sign_payload(secret: &[u8; 32], payload: &str) -> Result<String, IdentityError> {
    let digest = Sha256::digest(payload.as_bytes());
    let key = signing_key(secret)?;
    let signature = key
        .sign_prehash_with_rng(&mut rand_core::OsRng, &digest)
        .map_err(|_| IdentityError::BadKey)?;
    Ok(hex::encode(signature.to_bytes()))
}

/// The identity held on this machine.
pub struct Identity {
    secret: Zeroizing<[u8; 32]>,
    /// True when the key came from the environment and must not be persisted.
    ephemeral: bool,
}

impl Identity {
    pub fn public_key_hex(&self) -> Result<String, IdentityError> {
        public_key_hex(&self.secret)
    }

    pub fn npub(&self) -> Result<String, IdentityError> {
        let key = signing_key(&self.secret)?;
        npub_of(&key.verifying_key().to_bytes().into())
    }

    pub fn sign(&self, payload: &str) -> Result<String, IdentityError> {
        sign_payload(&self.secret, payload)
    }

    pub fn is_ephemeral(&self) -> bool {
        self.ephemeral
    }
}

/// What the store currently holds, without unlocking anything unnecessarily.
pub fn state(store: &SecretStore) -> IdentityState {
    state_with(store, key_from_env())
}

/// The escape hatch is passed in rather than read here.
///
/// `std::env::set_var` is process-wide and Rust runs tests in parallel, so a
/// test that set it would decide the answer for every other test in the file.
/// Threading it through also makes the rule visible: the env key wins, and it
/// is never written down.
pub fn state_with(store: &SecretStore, env_key: Option<Zeroizing<[u8; 32]>>) -> IdentityState {
    if env_key.is_some() {
        return IdentityState::Ready;
    }
    match store.load() {
        Ok(blob) => {
            if blob.slots.contains_key(IDENTITY_SLOT) {
                IdentityState::Ready
            } else {
                IdentityState::None
            }
        }
        Err(SecretsError::Locked) => IdentityState::Locked,
        // Anything else — unreadable json, a broken backend — is reported as
        // locked rather than none for the same reason: "we could not read it"
        // must never become "there was nothing there".
        Err(_) => {
            if store.marker().is_some() {
                IdentityState::Locked
            } else {
                IdentityState::None
            }
        }
    }
}

/// Load the identity, creating one only on a genuine first run.
///
/// The ordering is the point. A key is generated only when the store says
/// `None`, which it only says when there is no marker; a locked keychain
/// returns an error instead, so the one path that can overwrite an identity is
/// the one path that has proven there is nothing to overwrite.
pub fn load_or_create(store: &SecretStore) -> Result<Identity, IdentityError> {
    load_or_create_with(store, key_from_env())
}

/// See `state_with` for why the environment is an argument.
pub fn load_or_create_with(
    store: &SecretStore,
    env_key: Option<Zeroizing<[u8; 32]>>,
) -> Result<Identity, IdentityError> {
    if let Some(secret) = env_key {
        return Ok(Identity {
            secret,
            ephemeral: true,
        });
    }

    let mut blob = store.load()?;
    if let Some(existing) = blob.slots.get(IDENTITY_SLOT) {
        let secret = decode_secret(existing)?;
        // Heal a marker that went missing while the secret survived — see
        // `SecretStore::ensure_marker`. Without this the drift persists until
        // the next write, and so does the window where a locked keychain looks
        // like a first run.
        let signing = signing_key(&secret)?;
        store.ensure_marker(&npub_of(&signing.verifying_key().to_bytes().into())?)?;
        return Ok(Identity {
            secret,
            ephemeral: false,
        });
    }

    let signing = SigningKey::random(&mut rand_core::OsRng);
    let secret = Zeroizing::new(signing.to_bytes().into());
    let npub = npub_of(&signing.verifying_key().to_bytes().into())?;

    blob.slots
        .insert(IDENTITY_SLOT.to_string(), nsec_of(&secret)?);
    store.store(&blob, &npub)?;

    Ok(Identity {
        secret,
        ephemeral: false,
    })
}

/// A backup blob and the passphrase that opens it.
pub struct Backup {
    pub blob: String,
    pub passphrase: String,
}

/// Encrypt the identity into an `ncryptsec1…`.
///
/// The blob is decrypted again before it is handed back, and the key that comes
/// out is checked against the one that went in. A backup nobody can open is
/// worse than no backup: it is a backup you *believe* you have, and you find
/// out otherwise on the day the machine is gone.
pub fn export(store: &SecretStore, passphrase: Option<&str>) -> Result<Backup, IdentityError> {
    let identity = load_or_create(store)?;
    let passphrase = match passphrase {
        Some(given) if !given.trim().is_empty() => given.trim().to_string(),
        _ => nip49::generate_passphrase(),
    };

    let blob = nip49::encrypt(&identity.secret, &passphrase, nip49::DEFAULT_LOG_N)?;

    let reopened = nip49::decrypt(&blob, &passphrase)?;
    if public_key_hex(&reopened)? != identity.public_key_hex()? {
        return Err(IdentityError::WrongIdentity);
    }

    Ok(Backup { blob, passphrase })
}

/// Wipe the identity, but only once a backup has been confirmed stored.
pub fn wipe(store: &SecretStore) -> Result<(), IdentityError> {
    if !store.backup_confirmed() {
        return Err(IdentityError::NoBackupYet);
    }
    store.wipe()?;
    Ok(())
}

/// Replace the identity with an imported one. Returns the new npub.
///
/// Takes an nsec, a bare hex key, or an `ncryptsec1…` with its passphrase.
pub fn import(
    store: &SecretStore,
    secret_input: &str,
    passphrase: Option<&str>,
) -> Result<String, IdentityError> {
    let trimmed = secret_input.trim();
    let secret = if trimmed.starts_with("ncryptsec1") {
        nip49::decrypt(trimmed, passphrase.unwrap_or_default())?
    } else {
        decode_secret(trimmed)?
    };
    let signing = signing_key(&secret)?;
    let npub = npub_of(&signing.verifying_key().to_bytes().into())?;

    let mut blob = match store.load() {
        Ok(blob) => blob,
        // An import is the one operation allowed to proceed past a locked
        // store: the person is handing us the key, so nothing can be lost.
        Err(SecretsError::Locked) => Blob::default(),
        Err(e) => return Err(e.into()),
    };
    blob.slots
        .insert(IDENTITY_SLOT.to_string(), nsec_of(&secret)?);
    store.store(&blob, &npub)?;

    // The confirmation belonged to the identity that was just replaced. Leaving
    // it would unlock the wipe for a key nobody has ever backed up — the same
    // inheritance a wipe already clears.
    store.clear_backup_confirmation()?;
    Ok(npub)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::{Backend, SecretStore};
    use k256::schnorr::signature::hazmat::PrehashVerifier;

    /// Produced by `@noble/curves` on the web side — the exact library the
    /// office verifies with. Regenerate with the same secret if this ever needs
    /// to change, and be suspicious of any change that needs it.
    const SECRET_HEX: &str = "0000000000000000000000000000000000000000000000000000000000000003";
    const NSEC: &str = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqps52s3re";
    const PUBKEY: &str = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
    const PAYLOAD: &str = "quintal-auth:v1:https://office.example.test:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1700000000";
    /// A signature noble made. Rust must accept it, or the two sides disagree
    /// about what is being signed and every login from the app would fail.
    const NOBLE_SIG: &str = "8b27f0a6986e115b7ad23650a6e37a59f6317cfa69f59991dbca49265cf56dce045b19e8bfb23cc65d2b1923ffdf5a9bcb4d13a9d1c15a8566842d76fab16d75";

    fn secret() -> Zeroizing<[u8; 32]> {
        decode_secret(SECRET_HEX).expect("vector secret decodes")
    }

    #[test]
    fn derives_the_same_public_key_as_noble() {
        assert_eq!(public_key_hex(&secret()).unwrap(), PUBKEY);
    }

    #[test]
    fn nsec_round_trips_and_matches_noble() {
        assert_eq!(nsec_of(&secret()).unwrap(), NSEC);
        assert_eq!(&*decode_secret(NSEC).unwrap(), &*secret());
    }

    #[test]
    fn verifies_a_signature_noble_produced() {
        use k256::schnorr::{Signature, VerifyingKey};

        let digest = Sha256::digest(PAYLOAD.as_bytes());
        let pubkey = hex::decode(PUBKEY).unwrap();
        let key = VerifyingKey::from_bytes(&pubkey).unwrap();
        let sig = Signature::try_from(hex::decode(NOBLE_SIG).unwrap().as_slice()).unwrap();

        key.verify_prehash(&digest, &sig)
            .expect("noble's signature must verify here, or the two sides sign different things");
    }

    #[test]
    fn signs_something_noble_would_accept() {
        // The other direction. Signatures are randomised, so this checks the
        // shape and self-consistency; `scripts/desktop-ipc-check.mjs` closes
        // the loop by verifying a signature this app really produced, over
        // real IPC, with noble.
        let sig = sign_payload(&secret(), PAYLOAD).unwrap();
        assert_eq!(sig.len(), 128, "64 bytes, hex");

        use k256::schnorr::{Signature, VerifyingKey};
        let digest = Sha256::digest(PAYLOAD.as_bytes());
        let key = VerifyingKey::from_bytes(&hex::decode(PUBKEY).unwrap()).unwrap();
        let parsed = Signature::try_from(hex::decode(&sig).unwrap().as_slice()).unwrap();
        key.verify_prehash(&digest, &parsed).unwrap();
    }

    #[test]
    fn the_plain_signer_would_have_signed_the_wrong_thing() {
        // Kept as a live warning rather than a comment. k256's `Verifier` and
        // `Signer` impls hash whatever they are given, so using them with an
        // already-computed digest signs sha256(sha256(payload)) — valid, and
        // rejected by the office every time. If this ever starts passing, the
        // crate changed its semantics and `sign_payload` needs rereading.
        use k256::schnorr::signature::Verifier;
        use k256::schnorr::{Signature, VerifyingKey};

        let digest = Sha256::digest(PAYLOAD.as_bytes());
        let key = VerifyingKey::from_bytes(&hex::decode(PUBKEY).unwrap()).unwrap();
        let sig = Signature::try_from(hex::decode(NOBLE_SIG).unwrap().as_slice()).unwrap();

        assert!(
            key.verify(&digest, &sig).is_err(),
            "the hashing verifier must NOT accept a signature over the raw digest",
        );
    }

    #[test]
    fn refuses_junk_secrets() {
        assert!(decode_secret("").is_err());
        assert!(decode_secret("not hex").is_err());
        assert!(decode_secret("aabb").is_err(), "too short");
        assert!(decode_secret(&"f".repeat(64)).is_ok(), "syntactically fine");
        // An npub is a public key; accepting one here would mean signing with
        // something that cannot sign.
        assert!(decode_secret(
            "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
        )
        .is_err());
    }

    // --- the states that must never be confused -----------------------------

    fn new_store() -> (tempfile::TempDir, SecretStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SecretStore::with_backend(dir.path(), Backend::File).unwrap();
        (dir, store)
    }

    #[test]
    fn first_run_creates_a_key_and_finds_it_again() {
        let (_dir, store) = new_store();
        assert_eq!(state_with(&store, None), IdentityState::None);

        let first = load_or_create_with(&store, None).unwrap();
        assert_eq!(state_with(&store, None), IdentityState::Ready);

        let second = load_or_create_with(&store, None).unwrap();
        assert_eq!(
            first.public_key_hex().unwrap(),
            second.public_key_hex().unwrap(),
            "a second launch must not mint a second identity",
        );
    }

    #[test]
    fn a_marker_lost_beside_a_surviving_secret_is_put_back() {
        // The drift is real and easy to cause: the secret lives in the OS
        // keychain, the marker is a file, and deleting the app data directory
        // takes one and not the other.
        let (dir, store) = new_store();
        let created = load_or_create_with(&store, None).unwrap();
        let npub = created.npub().unwrap();

        std::fs::remove_file(dir.path().join("identity.marker")).unwrap();
        assert!(store.marker().is_none(), "drift established");

        let again = load_or_create_with(&store, None).unwrap();
        assert_eq!(again.npub().unwrap(), npub, "same identity, not a new one");
        assert_eq!(
            store.marker().as_deref(),
            Some(npub.as_str()),
            "and the marker describes it again",
        );
    }

    #[test]
    fn healing_the_marker_restores_the_locked_check() {
        // Why the healing matters at all. With the marker gone, a keychain that
        // will not open reads as "no key yet" and the UI offers to create one
        // over an identity that already exists. Reading once puts the guard
        // back.
        let (dir, store) = new_store();
        load_or_create_with(&store, None).unwrap();
        std::fs::remove_file(dir.path().join("identity.marker")).unwrap();

        // Before healing: secret unreadable + no marker looks like a first run.
        let secrets = dir.path().join("secrets.json");
        let saved = std::fs::read(&secrets).unwrap();
        std::fs::remove_file(&secrets).unwrap();
        assert_eq!(
            state_with(&store, None),
            IdentityState::None,
            "this is the window the drift opens",
        );

        // Put the secret back, read once to heal, then take it away again.
        std::fs::write(&secrets, &saved).unwrap();
        load_or_create_with(&store, None).unwrap();
        std::fs::remove_file(&secrets).unwrap();

        assert_eq!(
            state_with(&store, None),
            IdentityState::Locked,
            "now an unreadable secret is correctly reported as locked",
        );
    }

    #[test]
    fn a_missing_store_with_a_marker_is_locked_not_empty() {
        // The failure this whole design exists to prevent: the keychain is
        // there but will not open, and the app decides it is a first run and
        // generates a replacement identity nobody can undo.
        let (dir, store) = new_store();
        let created = load_or_create_with(&store, None).unwrap();
        let npub = created.npub().unwrap();

        std::fs::remove_file(dir.path().join("secrets.json")).unwrap();
        assert!(
            dir.path().join("identity.marker").exists(),
            "marker survives"
        );

        assert_eq!(state_with(&store, None), IdentityState::Locked);
        assert!(
            matches!(
                load_or_create_with(&store, None),
                Err(IdentityError::Secrets(SecretsError::Locked))
            ),
            "loading must refuse rather than generate over the top",
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("identity.marker")).unwrap(),
            npub,
            "and the marker still names whose key is locked away",
        );
    }

    #[test]
    fn import_replaces_the_identity_and_survives_a_locked_store() {
        let (dir, store) = new_store();
        load_or_create_with(&store, None).unwrap();
        std::fs::remove_file(dir.path().join("secrets.json")).unwrap();
        assert_eq!(state_with(&store, None), IdentityState::Locked);

        // Importing is the way out of locked: the person is supplying the key,
        // so there is nothing left to lose by writing.
        let npub = import(&store, NSEC, None).unwrap();
        assert_eq!(state_with(&store, None), IdentityState::Ready);
        assert_eq!(
            load_or_create_with(&store, None)
                .unwrap()
                .public_key_hex()
                .unwrap(),
            PUBKEY
        );
        assert!(npub.starts_with("npub1"));
    }

    #[test]
    fn an_env_key_is_used_and_never_written_down() {
        let (dir, store) = new_store();
        let identity = load_or_create_with(&store, Some(secret())).unwrap();

        assert_eq!(identity.public_key_hex().unwrap(), PUBKEY);
        assert!(identity.is_ephemeral());
        assert!(
            !dir.path().join("secrets.json").exists(),
            "an escape-hatch key must not be persisted",
        );
        assert!(
            !dir.path().join("identity.marker").exists(),
            "and it must not leave a marker claiming a key is stored here",
        );
        assert_eq!(state_with(&store, Some(secret())), IdentityState::Ready);
    }

    #[test]
    fn the_env_key_parses_in_both_forms_the_docs_promise() {
        assert_eq!(&*decode_secret(SECRET_HEX).unwrap(), &*secret());
        assert_eq!(&*decode_secret(NSEC).unwrap(), &*secret());
        assert_eq!(
            &*decode_secret(&format!("  {SECRET_HEX}  ")).unwrap(),
            &*secret()
        );
    }

    #[test]
    fn a_backup_opens_again_and_restores_the_same_identity() {
        let (_dir, store) = new_store();
        let original = load_or_create_with(&store, None)
            .unwrap()
            .public_key_hex()
            .unwrap();

        let backup = export(&store, Some("a-known-passphrase")).unwrap();
        assert!(backup.blob.starts_with("ncryptsec1"));
        assert_eq!(backup.passphrase, "a-known-passphrase");

        // A different machine entirely.
        let (_other_dir, other) = new_store();
        let npub = import(&other, &backup.blob, Some("a-known-passphrase")).unwrap();
        assert!(npub.starts_with("npub1"));
        assert_eq!(
            load_or_create_with(&other, None)
                .unwrap()
                .public_key_hex()
                .unwrap(),
            original,
            "export then import must land the same identity, not a lookalike",
        );
    }

    #[test]
    fn a_generated_passphrase_is_long_enough_to_be_worth_having() {
        let (_dir, store) = new_store();
        let backup = export(&store, None).unwrap();
        assert_eq!(
            backup.passphrase.split('-').count(),
            crate::nip49::PASSPHRASE_WORDS,
        );
        assert!(!backup.passphrase.trim().is_empty());
    }

    #[test]
    fn an_empty_passphrase_is_treated_as_asking_us_to_pick_one() {
        // Otherwise a blank field would produce a blob encrypted under "",
        // which is not a backup, it is a plain-text key with extra steps.
        let (_dir, store) = new_store();
        let backup = export(&store, Some("   ")).unwrap();
        assert_eq!(
            backup.passphrase.split('-').count(),
            crate::nip49::PASSPHRASE_WORDS,
        );
    }

    #[test]
    fn a_wrong_passphrase_does_not_import() {
        let (_dir, store) = new_store();
        let backup = export(&store, Some("right-one")).unwrap();
        let (_other_dir, other) = new_store();
        assert!(import(&other, &backup.blob, Some("wrong-one")).is_err());
        assert_eq!(
            state_with(&other, None),
            IdentityState::None,
            "and nothing was written"
        );
    }

    #[test]
    fn wiping_is_refused_until_a_backup_is_confirmed_stored() {
        // The gate. Exporting alone is not enough: a blob shown on screen and
        // never written down is exactly the case this protects against.
        let (_dir, store) = new_store();
        load_or_create_with(&store, None).unwrap();

        assert!(matches!(wipe(&store), Err(IdentityError::NoBackupYet)));
        export(&store, None).unwrap();
        assert!(
            matches!(wipe(&store), Err(IdentityError::NoBackupYet)),
            "exporting is not confirming",
        );

        store.confirm_backup().unwrap();
        wipe(&store).unwrap();
        assert_eq!(state_with(&store, None), IdentityState::None);
    }

    #[test]
    fn importing_clears_the_previous_identity_s_backup_confirmation() {
        // Otherwise: back up A, import B, and the wipe is unlocked for B — a
        // key that has never been written down anywhere.
        let (_dir, store) = new_store();
        load_or_create_with(&store, None).unwrap();
        export(&store, None).unwrap();
        store.confirm_backup().unwrap();

        import(&store, NSEC, None).unwrap();

        assert!(
            matches!(wipe(&store), Err(IdentityError::NoBackupYet)),
            "the new identity has to earn its own confirmation",
        );
    }

    #[test]
    fn a_wipe_also_clears_the_backup_confirmation() {
        // Otherwise the next identity on this machine would inherit permission
        // to be wiped, having never been backed up at all.
        let (_dir, store) = new_store();
        load_or_create_with(&store, None).unwrap();
        store.confirm_backup().unwrap();
        wipe(&store).unwrap();

        load_or_create_with(&store, None).unwrap();
        assert!(matches!(wipe(&store), Err(IdentityError::NoBackupYet)));
    }

    #[test]
    fn wipe_clears_both_the_secret_and_the_marker() {
        let (dir, store) = new_store();
        load_or_create_with(&store, None).unwrap();
        store.wipe().unwrap();
        assert!(!dir.path().join("secrets.json").exists());
        assert!(!dir.path().join("identity.marker").exists());
        assert_eq!(
            state_with(&store, None),
            IdentityState::None,
            "a wipe is a real first run again"
        );
    }
}
