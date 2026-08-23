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

use crate::secrets::{Blob, SecretStore, SecretsError};

const IDENTITY_SLOT: &str = "identity";

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error(transparent)]
    Secrets(#[from] SecretsError),
    #[error("that is not a usable secret key")]
    BadKey,
    #[error("could not encode a key: {0}")]
    Encoding(String),
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

fn signing_key(secret: &[u8; 32]) -> Result<SigningKey, IdentityError> {
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

/// Replace the identity with an imported one. Returns the new npub.
pub fn import(store: &SecretStore, secret_input: &str) -> Result<String, IdentityError> {
    let secret = decode_secret(secret_input)?;
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
        // shape and self-consistency; `identity.interop.test.ts` on the web
        // side verifies a signature this function actually produced.
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

    fn store() -> (tempfile::TempDir, SecretStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SecretStore::with_backend(dir.path(), Backend::File).unwrap();
        (dir, store)
    }

    #[test]
    fn first_run_creates_a_key_and_finds_it_again() {
        let (_dir, store) = store();
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
    fn a_missing_store_with_a_marker_is_locked_not_empty() {
        // The failure this whole design exists to prevent: the keychain is
        // there but will not open, and the app decides it is a first run and
        // generates a replacement identity nobody can undo.
        let (dir, store) = store();
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
        let (dir, store) = store();
        load_or_create_with(&store, None).unwrap();
        std::fs::remove_file(dir.path().join("secrets.json")).unwrap();
        assert_eq!(state_with(&store, None), IdentityState::Locked);

        // Importing is the way out of locked: the person is supplying the key,
        // so there is nothing left to lose by writing.
        let npub = import(&store, NSEC).unwrap();
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
        let (dir, store) = store();
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
    fn wipe_clears_both_the_secret_and_the_marker() {
        let (dir, store) = store();
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
