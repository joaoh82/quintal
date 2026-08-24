//! NIP-49: a secret key you can write on paper.
//!
//! An `ncryptsec1…` is the nsec encrypted under a passphrase — scrypt to make
//! guessing expensive, XChaCha20-Poly1305 to do the actual hiding. It is the
//! answer to the only question that matters about a keypair identity: what
//! happens when this machine is gone.
//!
//! Layout, from the NIP, all 91 bytes of it:
//!
//! ```text
//!   version   1   always 0x02
//!   log_n     1   scrypt cost, N = 2^log_n
//!   salt     16
//!   nonce    24   XChaCha20 wants 24, not 12
//!   security  1   also the AEAD's associated data
//!   payload  48   32-byte key + 16-byte tag
//! ```

use bech32::{Bech32, Hrp};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand_core::RngCore;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

const VERSION: u8 = 0x02;
const HRP: &str = "ncryptsec";

/// Default scrypt cost. 2^16 needs 64 MiB per guess, which is what makes a
/// dictionary attack expensive rather than merely slow.
pub const DEFAULT_LOG_N: u8 = 16;

/// Refuse to honour a cost above this when *importing*.
///
/// scrypt's memory is `128 * N * r` bytes, so log_n 20 is already 1 GiB and 25
/// would be 32 GiB. A blob is untrusted input — somebody can hand you one that
/// asks for more memory than the machine has, and "decrypt this backup" should
/// not be a way to knock the app over.
pub const MAX_IMPORT_LOG_N: u8 = 20;

/// `0x02` — "the key was never handled insecurely", which is true of a key that
/// has only ever lived in the keychain. The byte is also the AEAD's associated
/// data, so it cannot be edited without invalidating the tag.
const KEY_SECURITY_SECURE: u8 = 0x02;

#[derive(Debug, thiserror::Error)]
pub enum Nip49Error {
    #[error("that is not an ncryptsec")]
    NotNcryptsec,
    #[error("this backup asks for {asked} rounds of key stretching; {max} is the most we will do")]
    CostTooHigh { asked: u8, max: u8 },
    #[error("wrong passphrase, or the backup is damaged")]
    Undecryptable,
    #[error("crypto: {0}")]
    Crypto(String),
}

/// Stretch the passphrase. NFKC first, per the NIP — the same characters typed
/// on two machines must produce the same bytes.
fn derive(passphrase: &str, salt: &[u8; 16], log_n: u8) -> Result<Zeroizing<[u8; 32]>, Nip49Error> {
    let normalised: String = passphrase.nfkc().collect();
    let params = scrypt::Params::new(log_n, 8, 1, 32)
        .map_err(|e| Nip49Error::Crypto(format!("scrypt params: {e}")))?;
    let mut key = Zeroizing::new([0u8; 32]);
    scrypt::scrypt(normalised.as_bytes(), salt, &params, key.as_mut())
        .map_err(|e| Nip49Error::Crypto(format!("scrypt: {e}")))?;
    Ok(key)
}

/// Encrypt a secret key into an `ncryptsec1…`.
pub fn encrypt(secret: &[u8; 32], passphrase: &str, log_n: u8) -> Result<String, Nip49Error> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 24];
    rand_core::OsRng.fill_bytes(&mut salt);
    rand_core::OsRng.fill_bytes(&mut nonce);

    let key = derive(passphrase, &salt, log_n)?;
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: secret.as_slice(),
                aad: &[KEY_SECURITY_SECURE],
            },
        )
        .map_err(|e| Nip49Error::Crypto(e.to_string()))?;

    let mut data = Vec::with_capacity(91);
    data.push(VERSION);
    data.push(log_n);
    data.extend_from_slice(&salt);
    data.extend_from_slice(&nonce);
    data.push(KEY_SECURITY_SECURE);
    data.extend_from_slice(&ciphertext);

    let hrp = Hrp::parse(HRP).map_err(|e| Nip49Error::Crypto(e.to_string()))?;
    bech32::encode::<Bech32>(hrp, &data).map_err(|e| Nip49Error::Crypto(e.to_string()))
}

/// Decrypt an `ncryptsec1…` back into a secret key.
pub fn decrypt(blob: &str, passphrase: &str) -> Result<Zeroizing<[u8; 32]>, Nip49Error> {
    let (hrp, data) = bech32::decode(blob.trim()).map_err(|_| Nip49Error::NotNcryptsec)?;
    if hrp.as_str() != HRP || data.len() != 91 || data[0] != VERSION {
        return Err(Nip49Error::NotNcryptsec);
    }

    let log_n = data[1];
    if log_n > MAX_IMPORT_LOG_N {
        return Err(Nip49Error::CostTooHigh {
            asked: log_n,
            max: MAX_IMPORT_LOG_N,
        });
    }

    let salt: [u8; 16] = data[2..18]
        .try_into()
        .map_err(|_| Nip49Error::NotNcryptsec)?;
    let nonce: [u8; 24] = data[18..42]
        .try_into()
        .map_err(|_| Nip49Error::NotNcryptsec)?;
    let security = data[42];
    let ciphertext = &data[43..];

    let key = derive(passphrase, &salt, log_n)?;
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let plain = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: ciphertext,
                aad: &[security],
            },
        )
        // A failed tag means the wrong passphrase far more often than a damaged
        // blob, and the two are indistinguishable from here, so say both.
        .map_err(|_| Nip49Error::Undecryptable)?;

    let secret: [u8; 32] = plain
        .as_slice()
        .try_into()
        .map_err(|_| Nip49Error::Undecryptable)?;
    Ok(Zeroizing::new(secret))
}

// --- passphrases ------------------------------------------------------------

/// The character between words in a generated passphrase.
const SEPARATOR: char = '-';

/// The EFF short wordlist, minus anything containing the separator.
///
/// The list has exactly one hyphenated entry, `yo-yo`, and joining words with a
/// hyphen makes it ambiguous the moment it is drawn: `ivy-crumb-yo-yo-ride`
/// cannot be told apart from five separate words by the person copying it onto
/// paper, which is the only thing this passphrase is for. Dropping it costs
/// 0.001 bits and makes "count the dashes" a way to check you transcribed it
/// correctly.
fn wordlist() -> Vec<&'static str> {
    include_str!("wordlists/eff_short_wordlist.txt")
        .lines()
        .filter(|line| !line.starts_with('#') && !line.trim().is_empty())
        .filter(|word| !word.contains(SEPARATOR))
        .collect()
}

/// How many words a generated passphrase gets.
///
/// **Six, not three.** The list holds 1296 words, so each one is 10.34 bits:
/// three words is 31 bits, and a backup blob is a thing people write down and
/// lose. scrypt makes each guess cost 64 MiB, but 2^31 candidates is still
/// within reach of anybody willing to spend a little — and the prize is an
/// identity that cannot be revoked or reissued. Six words is 62 bits, which is
/// not.
///
/// The cost is two more words to write on the paper.
pub const PASSPHRASE_WORDS: usize = 6;

/// A passphrase from the CSPRNG, `PASSPHRASE_WORDS` words joined by dashes.
pub fn generate_passphrase() -> String {
    let words = wordlist();
    (0..PASSPHRASE_WORDS)
        .map(|_| words[uniform_index(words.len())])
        .collect::<Vec<_>>()
        .join(&SEPARATOR.to_string())
}

/// A uniform index, rejecting the biased tail rather than taking a modulus.
///
/// `next_u32() % 1296` would make the first 928 words very slightly likelier
/// than the rest. It is a small bias, and it is free to not have.
fn uniform_index(len: usize) -> usize {
    let len = len as u32;
    let limit = u32::MAX - (u32::MAX % len) - 1;
    loop {
        let value = rand_core::OsRng.next_u32();
        if value <= limit {
            return (value % len) as usize;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Straight from the NIP. This is the check that matters: a blob another
    /// implementation produced must open here, or "your backup" only means
    /// "your backup, in this app, this version".
    const SPEC_NCRYPTSEC: &str = "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p";
    const SPEC_PASSWORD: &str = "nostr";
    const SPEC_SECRET_HEX: &str =
        "3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683";

    #[test]
    fn opens_the_blob_from_the_spec() {
        let secret = decrypt(SPEC_NCRYPTSEC, SPEC_PASSWORD).expect("the NIP's own vector");
        assert_eq!(hex::encode(&*secret), SPEC_SECRET_HEX);
    }

    #[test]
    fn round_trips_at_a_sane_cost() {
        let secret: [u8; 32] = hex::decode(SPEC_SECRET_HEX).unwrap().try_into().unwrap();
        // log_n 12 rather than the default: 64 MiB per test run adds up.
        let blob = encrypt(&secret, "correct horse battery staple", 12).unwrap();
        assert!(blob.starts_with("ncryptsec1"));
        let back = decrypt(&blob, "correct horse battery staple").unwrap();
        assert_eq!(&*back, &secret);
    }

    #[test]
    fn a_wrong_passphrase_fails_closed() {
        let secret = [7u8; 32];
        let blob = encrypt(&secret, "right", 12).unwrap();
        assert!(matches!(
            decrypt(&blob, "wrong"),
            Err(Nip49Error::Undecryptable)
        ));
    }

    #[test]
    fn normalises_the_passphrase_so_the_same_keys_open_it() {
        // "é" typed as one code point and as e + combining accent are the same
        // passphrase to a person, and must be to us.
        let secret = [9u8; 32];
        let composed = "caf\u{00e9}";
        let decomposed = "cafe\u{0301}";
        let blob = encrypt(&secret, composed, 12).unwrap();
        assert_eq!(&*decrypt(&blob, decomposed).unwrap(), &secret);
    }

    #[test]
    fn refuses_a_blob_that_demands_absurd_memory() {
        // Untrusted input: log_n 25 would ask for 32 GiB. Reject on the header
        // rather than finding out by allocating it.
        let mut data = vec![VERSION, 25];
        data.extend_from_slice(&[0u8; 16]);
        data.extend_from_slice(&[0u8; 24]);
        data.push(KEY_SECURITY_SECURE);
        data.extend_from_slice(&[0u8; 48]);
        let hrp = Hrp::parse(HRP).unwrap();
        let blob = bech32::encode::<Bech32>(hrp, &data).unwrap();

        assert!(matches!(
            decrypt(&blob, "anything"),
            Err(Nip49Error::CostTooHigh { asked: 25, max: 20 })
        ));
    }

    #[test]
    fn rejects_things_that_are_not_ncryptsec() {
        assert!(matches!(decrypt("", "x"), Err(Nip49Error::NotNcryptsec)));
        assert!(matches!(
            decrypt("hello", "x"),
            Err(Nip49Error::NotNcryptsec)
        ));
        assert!(matches!(
            decrypt(
                "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqps52s3re",
                "x"
            ),
            Err(Nip49Error::NotNcryptsec)
        ));
    }

    #[test]
    fn the_wordlist_is_the_one_we_think_it_is() {
        // 1296 in the file, less the single hyphenated entry we cannot use.
        let words = wordlist();
        assert_eq!(words.len(), 1295, "EFF short wordlist #1, minus `yo-yo`");
        assert!(words.iter().all(|w| !w.contains(char::is_whitespace)));
        assert!(
            words.iter().all(|w| !w.contains(SEPARATOR)),
            "a word containing the separator makes the passphrase ambiguous to read",
        );
        let unique: std::collections::HashSet<_> = words.iter().collect();
        assert_eq!(unique.len(), 1295, "a duplicate would quietly cost entropy");
    }

    #[test]
    fn a_passphrase_always_has_exactly_the_words_it_claims() {
        // This failed in CI roughly one run in two hundred, because `yo-yo`
        // could be drawn and then split into two. The bug was not the test.
        for _ in 0..2_000 {
            let phrase = generate_passphrase();
            assert_eq!(
                phrase.split(SEPARATOR).count(),
                PASSPHRASE_WORDS,
                "{phrase} does not read as {PASSPHRASE_WORDS} words",
            );
        }
    }

    #[test]
    fn passphrases_have_the_entropy_claimed_for_them() {
        let phrase = generate_passphrase();
        assert_eq!(phrase.split('-').count(), PASSPHRASE_WORDS);
        assert!(PASSPHRASE_WORDS >= 6, "below six words this is guessable");

        // Not a randomness test — just that it is not returning a constant.
        let another = generate_passphrase();
        assert_ne!(phrase, another);
    }
}
