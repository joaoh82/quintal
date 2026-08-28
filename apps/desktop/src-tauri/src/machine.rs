//! The machine this app is running on, as the office knows it.
//!
//! A "machine" in Quintal is somewhere agents may be started. Registering one
//! has always meant creating a token in the office, copying it, and pasting it
//! into a terminal — a ritual that exists only because a *browser* office is
//! blind: it cannot see your laptop, so a human carries a secret across the gap
//! to prove the two belong together.
//!
//! The desktop app is not blind. It is already signed in with a key in the OS
//! keychain, so it can ask the office to register it and keep the answer. This
//! module is the keeping: the token goes into the same single keychain entry as
//! everything else, so the OS still prompts once per process rather than once
//! per secret.

use crate::identity::{decode_secret, npub_of, signing_key, IdentityError};
use crate::secrets::SecretStore;

/// Slot prefixes in the secrets blob, namespaced like `agent:<pubkey>` is.
///
/// Per office, because a `qh_` token is minted *by* an office and means nothing
/// anywhere else. The same laptop is a separate machine in each one — which is
/// what isolation has to mean when the offices do not talk to each other.
const HOST_TOKEN_SLOT: &str = "host-token";

/// The name this machine registered under.
///
/// Stored beside the token because the alternative — asking the OS again — is
/// not stable. `gethostname()` on macOS returns the name the network handed
/// out, so moving between a home router and an office one silently renames the
/// computer. Agents are pinned to a machine *by label*, so a name that drifts
/// is a fleet that stops booting and a machine that appears twice.
const LABEL_SLOT: &str = "machine-label";

fn token_slot(office: &str) -> String {
    format!("{HOST_TOKEN_SLOT}:{office}")
}

fn label_slot(office: &str) -> String {
    format!("{LABEL_SLOT}:{office}")
}

/// Move a pre-offices registration under the office it must have belonged to.
///
/// There was only ever one office before this, so the bare slots are that
/// office's. Losing them would silently unregister somebody's machine and leave
/// a live token in the office that nothing on this side could use.
pub fn migrate_to(store: &SecretStore, office: &str) -> Result<(), IdentityError> {
    let mut blob = store.load()?;
    let token = blob.slots.remove(HOST_TOKEN_SLOT);
    let label = blob.slots.remove(LABEL_SLOT);
    if token.is_none() && label.is_none() {
        return Ok(());
    }

    if let Some(token) = token {
        blob.slots.entry(token_slot(office)).or_insert(token);
    }
    if let Some(label) = label {
        blob.slots.entry(label_slot(office)).or_insert(label);
    }

    let Some(existing) = blob.slots.get(crate::identity::IDENTITY_SLOT).cloned() else {
        return Ok(());
    };
    let secret = decode_secret(&existing)?;
    let npub = npub_of(&signing_key(&secret)?.verifying_key().to_bytes().into())?;
    store.store(&blob, &npub)?;
    Ok(())
}

/// What this machine should be called, matching the harness's `hostLabel()`.
///
/// The two must agree: the same laptop reporting as `Joaos-MBP.local` from one
/// path and `Joaos-MBP` from the other becomes two rows in the Machines list,
/// and a fleet assigned to one of them silently never boots.
pub fn label() -> String {
    let raw = suggested_name();
    let trimmed = raw.trim();
    // Both suffixes come from the same place and mean the same thing: this is
    // the name a local network is using, not a name anybody chose.
    for suffix in [".local", ".home", ".lan"] {
        if let Some(stem) = trimmed.strip_suffix(suffix) {
            return stem.to_string();
        }
    }
    trimmed.to_string()
}

/// The best guess at what this computer should be called.
///
/// On macOS `LocalHostName` is the stable Bonjour name — it survives changing
/// networks, which `gethostname()` does not. Falling back to the hostname keeps
/// this working everywhere else.
fn suggested_name() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/usr/sbin/scutil")
            .args(["--get", "LocalHostName"])
            .output()
        {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    gethostname::gethostname().to_string_lossy().into_owned()
}

/// The name this machine is registered under, if it has registered.
///
/// Preferred over `label()` everywhere it exists: it is what the office knows
/// this computer as, and therefore what agents are assigned to.
pub fn registered_label(
    store: &SecretStore,
    office: &str,
) -> Result<Option<String>, IdentityError> {
    Ok(store.load()?.slots.get(&label_slot(office)).cloned())
}

/// The host token this machine holds, if it has registered.
///
/// A locked keychain propagates as an error rather than as `None`. "No token"
/// and "cannot read the token" would otherwise look identical, and the app
/// would respond to a locked keychain by registering itself a second time —
/// silently orphaning the first registration on every launch.
pub fn token(store: &SecretStore, office: &str) -> Result<Option<String>, IdentityError> {
    Ok(store.load()?.slots.get(&token_slot(office)).cloned())
}

/// Keep a token the office just issued.
///
/// Requires an identity to already exist: the token authenticates *this machine
/// as that person's*, so storing one against no identity would leave a
/// credential nothing can be attributed to. The npub is needed anyway, since
/// every write to the blob re-records the marker.
pub fn remember(
    store: &SecretStore,
    office: &str,
    token: &str,
    label: &str,
) -> Result<(), IdentityError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(IdentityError::EmptyToken);
    }
    let label = label.trim();
    if label.is_empty() {
        return Err(IdentityError::EmptyLabel);
    }

    let mut blob = store.load()?;
    let existing = blob
        .slots
        .get(crate::identity::IDENTITY_SLOT)
        .ok_or(IdentityError::NoIdentityYet)?;

    let secret = decode_secret(existing)?;
    let npub = npub_of(&signing_key(&secret)?.verifying_key().to_bytes().into())?;

    blob.slots.insert(token_slot(office), token.to_string());
    blob.slots.insert(label_slot(office), label.to_string());
    store.store(&blob, &npub)?;
    Ok(())
}

/// Drop the token, so the next launch registers again.
///
/// Used when the office rejects it — the desktop equivalent of the stale
/// `~/.quintal/host.json` the CLI walks into.
pub fn forget_for(store: &SecretStore, office: &str) -> Result<(), IdentityError> {
    let mut blob = store.load()?;
    let Some(existing) = blob.slots.get(crate::identity::IDENTITY_SLOT).cloned() else {
        return Ok(());
    };
    let had_token = blob.slots.remove(&token_slot(office)).is_some();
    let had_label = blob.slots.remove(&label_slot(office)).is_some();
    if !had_token && !had_label {
        return Ok(());
    }

    let secret = decode_secret(&existing)?;
    let npub = npub_of(&signing_key(&secret)?.verifying_key().to_bytes().into())?;
    store.store(&blob, &npub)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OFFICE: &str = "https://office.example.com";
    use crate::identity::load_or_create_with;
    use crate::secrets::{Backend, SecretStore};

    fn store() -> (tempfile::TempDir, SecretStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store =
            SecretStore::with_backend(dir.path(), Backend::File).expect("a file-backed store");
        (dir, store)
    }

    #[test]
    fn a_machine_with_no_token_has_not_registered() {
        let (_dir, store) = store();
        load_or_create_with(&store, None).expect("an identity");
        assert_eq!(token(&store, OFFICE).expect("readable"), None);
    }

    #[test]
    fn a_remembered_token_comes_back() {
        let (_dir, store) = store();
        load_or_create_with(&store, None).expect("an identity");

        remember(&store, OFFICE, "qh_abc", "laptop").expect("stored");
        assert_eq!(
            token(&store, OFFICE).expect("readable").as_deref(),
            Some("qh_abc")
        );
    }

    #[test]
    fn remembering_a_token_leaves_the_identity_alone() {
        let (_dir, store) = store();
        let before = load_or_create_with(&store, None)
            .expect("an identity")
            .npub()
            .expect("an npub");

        remember(&store, OFFICE, "qh_abc", "laptop").expect("stored");

        let after = load_or_create_with(&store, None)
            .expect("the same identity")
            .npub()
            .expect("an npub");
        assert_eq!(
            before, after,
            "registering a machine must not rotate the key"
        );
    }

    #[test]
    fn forgetting_a_token_keeps_the_identity() {
        let (_dir, store) = store();
        let before = load_or_create_with(&store, None)
            .expect("an identity")
            .npub()
            .expect("an npub");

        remember(&store, OFFICE, "qh_abc", "laptop").expect("stored");
        forget_for(&store, OFFICE).expect("forgotten");

        assert_eq!(token(&store, OFFICE).expect("readable"), None);
        let after = load_or_create_with(&store, None)
            .expect("the same identity")
            .npub()
            .expect("an npub");
        assert_eq!(before, after);
    }

    #[test]
    fn a_token_cannot_be_stored_without_an_identity() {
        let (_dir, store) = store();
        assert!(remember(&store, OFFICE, "qh_abc", "laptop").is_err());
    }

    #[test]
    fn an_empty_token_is_refused() {
        let (_dir, store) = store();
        load_or_create_with(&store, None).expect("an identity");
        assert!(remember(&store, OFFICE, "   ", "laptop").is_err());
    }

    #[test]
    fn the_label_drops_the_mdns_suffix_like_the_harness_does() {
        // Not asserting the hostname itself — CI's differs — only that whatever
        // it is comes back without the suffix the harness also strips.
        assert!(!label().ends_with(".local"));
        assert!(!label().is_empty());
    }
}

#[cfg(test)]
mod per_office_tests {
    use super::*;
    use crate::identity::load_or_create_with;
    use crate::secrets::{Backend, SecretStore};

    const A: &str = "https://a.example.com";
    const B: &str = "https://b.example.com";

    fn store() -> (tempfile::TempDir, SecretStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::with_backend(dir.path(), Backend::File).expect("a store");
        load_or_create_with(&store, None).expect("an identity");
        (dir, store)
    }

    /// The property the whole switcher rests on: two offices are two
    /// environments, and this machine is registered separately in each.
    #[test]
    fn registrations_do_not_leak_between_offices() {
        let (_dir, store) = store();
        remember(&store, A, "qh_a", "Laptop").expect("stored");

        assert_eq!(token(&store, A).expect("readable").as_deref(), Some("qh_a"));
        assert_eq!(
            token(&store, B).expect("readable"),
            None,
            "registering with one office must not register with another"
        );
    }

    #[test]
    fn each_office_keeps_its_own_name_for_this_machine() {
        let (_dir, store) = store();
        remember(&store, A, "qh_a", "Laptop").expect("stored");
        remember(&store, B, "qh_b", "Work laptop").expect("stored");

        assert_eq!(
            registered_label(&store, A).expect("readable").as_deref(),
            Some("Laptop")
        );
        assert_eq!(
            registered_label(&store, B).expect("readable").as_deref(),
            Some("Work laptop"),
        );
    }

    #[test]
    fn forgetting_one_office_leaves_the_other_alone() {
        let (_dir, store) = store();
        remember(&store, A, "qh_a", "Laptop").expect("stored");
        remember(&store, B, "qh_b", "Laptop").expect("stored");

        forget_for(&store, A).expect("forgotten");

        assert_eq!(token(&store, A).expect("readable"), None);
        assert_eq!(token(&store, B).expect("readable").as_deref(), Some("qh_b"));
    }

    /// A registration made before offices existed belonged to the only office
    /// there was. Dropping it would silently unregister somebody's machine.
    #[test]
    fn a_pre_offices_registration_is_carried_over() {
        let (_dir, store) = store();

        let mut blob = store.load().expect("blob");
        blob.slots.insert("host-token".into(), "qh_old".into());
        blob.slots.insert("machine-label".into(), "Laptop".into());
        let npub = load_or_create_with(&store, None)
            .expect("identity")
            .npub()
            .expect("npub");
        store.store(&blob, &npub).expect("stored");

        migrate_to(&store, A).expect("migrated");

        assert_eq!(
            token(&store, A).expect("readable").as_deref(),
            Some("qh_old")
        );
        assert_eq!(
            registered_label(&store, A).expect("readable").as_deref(),
            Some("Laptop")
        );
        assert!(
            !store.load().expect("blob").slots.contains_key("host-token"),
            "the bare slot is gone, so it cannot be adopted twice"
        );
    }

    #[test]
    fn migrating_with_nothing_to_carry_is_harmless() {
        let (_dir, store) = store();
        migrate_to(&store, A).expect("nothing to do");
        assert_eq!(token(&store, A).expect("readable"), None);
    }
}

#[cfg(test)]
mod label_tests {
    use super::*;

    const OFFICE: &str = "https://office.example.com";
    use crate::identity::load_or_create_with;
    use crate::secrets::{Backend, SecretStore};

    fn store() -> (tempfile::TempDir, SecretStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SecretStore::with_backend(dir.path(), Backend::File).expect("a store");
        (dir, store)
    }

    /// The bug this exists to prevent.
    ///
    /// `gethostname()` on macOS returns the name the local network handed out,
    /// so the same computer answers to different names on different networks.
    /// Agents are pinned to a machine by label, so a name that drifts is a
    /// fleet that silently stops booting and a machine that appears twice in
    /// the office. What it registered as is the only stable answer.
    #[test]
    fn the_registered_name_is_remembered_rather_than_asked_again() {
        let (_dir, store) = store();
        load_or_create_with(&store, None).expect("an identity");

        assert_eq!(registered_label(&store, OFFICE).expect("readable"), None);

        remember(&store, OFFICE, "qh_abc", "Laptop").expect("stored");
        assert_eq!(
            registered_label(&store, OFFICE)
                .expect("readable")
                .as_deref(),
            Some("Laptop"),
            "the name follows the registration, not the network"
        );
    }

    #[test]
    fn a_machine_with_no_name_is_refused() {
        let (_dir, store) = store();
        load_or_create_with(&store, None).expect("an identity");
        assert!(remember(&store, OFFICE, "qh_abc", "  ").is_err());
    }

    #[test]
    fn forgetting_drops_the_name_with_the_token() {
        let (_dir, store) = store();
        load_or_create_with(&store, None).expect("an identity");
        remember(&store, OFFICE, "qh_abc", "Laptop").expect("stored");

        forget_for(&store, OFFICE).expect("forgotten");

        assert_eq!(token(&store, OFFICE).expect("readable"), None);
        assert_eq!(
            registered_label(&store, OFFICE).expect("readable"),
            None,
            "a name with no token behind it would name a machine that cannot act"
        );
    }

    /// Network-assigned suffixes are not part of anybody's chosen name.
    #[test]
    fn a_suggested_name_carries_no_network_suffix() {
        let suggested = label();
        for suffix in [".local", ".home", ".lan"] {
            assert!(!suggested.ends_with(suffix), "{suggested} kept {suffix}");
        }
        assert!(!suggested.is_empty());
    }
}
