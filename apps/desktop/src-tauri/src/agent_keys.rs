//! A key of its own for every agent this machine runs (credentials v2).
//!
//! An agent the office assigned to this machine used to join on the machine's
//! host token — the office had no key for it, on purpose, because a key the
//! office could hand out is a key the office would have to store recoverably.
//! Now the agent has a keypair that was generated *here*, vouched for by the
//! identity this app holds: the owner signs a statement that the holder of
//! this public key acts for them, the office keeps the public half and the
//! signature, and the secret goes into the same keychain blob as the identity.
//! The office never sees it, and cannot forge a credential for the agent.
//!
//! Three rules, all inherited from the identity:
//!
//! - **A locked keychain is not an empty one.** If the marker says keys exist
//!   and the keychain will not open, this stops. It never generates a
//!   replacement key over the top of one it cannot read — the office would
//!   accept the replacement, and the old one would be gone for good.
//! - **The key goes to the harness in the environment, at spawn.** Never
//!   argv, never a file. See `spawn`.
//! - **The host token is the caller; the owner's signature is the authority.**
//!   Registration goes over the wire with the machine's token, and the office
//!   verifies the attestation against the *owner's* key, so a token alone can
//!   register nothing.

use std::collections::BTreeMap;

use k256::schnorr::SigningKey;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::identity::{self, decode_secret, nsec_of, public_key_hex, Identity, IdentityError};
use crate::secrets::SecretStore;

/// The variable the harness reads a JSON map of agent id → nsec from.
pub const AGENT_KEYS_ENV: &str = "QUINTAL_AGENT_KEYS";

/// Prefix of the preimage the owner signs. Must match `@quintal/shared`.
const ATTESTATION_PREFIX: &str = "quintal:agent-auth";

/// Per server and per agent: an agent id is minted by one office and means
/// nothing anywhere else, and the same machine may run fleets for two.
const AGENT_KEY_SLOT: &str = "agent-key";

fn slot(server: &str, agent_id: &str) -> String {
    format!("{AGENT_KEY_SLOT}:{server}:{agent_id}")
}

/// One agent the office says belongs here, as much of it as this cares about.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetAgent {
    pub agent_id: String,
    pub name: String,
    /// What the office has registered for it, if anything.
    #[serde(default)]
    pub pubkey: Option<String>,
}

/// `[ownerPubkeyHex, conditions, sigHex]` — the shape the office stores.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Attestation(pub [String; 3]);

/// The office, as much of it as provisioning needs. A trait so the whole
/// ceremony runs in a test with no server behind it.
pub trait Office {
    fn fleet(&self) -> Result<Vec<FleetAgent>, String>;
    fn register(
        &self,
        agent_id: &str,
        agent_pubkey: &str,
        attestation: &Attestation,
    ) -> Result<(), String>;
}

/// What provisioning produced: keys to hand the harness, and what it could not do.
#[derive(Debug, Default)]
pub struct Provisioned {
    /// Agent id → nsec, for every fleet agent this machine now holds a key for.
    pub keys: BTreeMap<String, Zeroizing<String>>,
    /// Agents that got a key just now, by name — for the log.
    pub registered: Vec<String>,
    /// Agents that will have to fall back to the host token, and why.
    pub skipped: Vec<Skipped>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub name: String,
    pub why: String,
}

/// The string the owner signs: `quintal:agent-auth:<agentPubkeyHex>:<conditions>`.
/// Conditions are empty today and signed verbatim — never normalised — so a
/// constraint can be added later without changing this ceremony.
pub fn attestation_preimage(agent_pubkey: &str, conditions: &str) -> String {
    format!("{ATTESTATION_PREFIX}:{agent_pubkey}:{conditions}")
}

/// The owner vouches for an agent's key.
pub fn attest(owner: &Identity, agent_pubkey: &str) -> Result<Attestation, IdentityError> {
    let owner_pubkey = owner.public_key_hex()?;
    if owner_pubkey == agent_pubkey {
        // The same rule the office enforces: an agent cannot vouch for itself.
        return Err(IdentityError::BadKey);
    }
    let sig = owner.sign(&attestation_preimage(agent_pubkey, ""))?;
    Ok(Attestation([owner_pubkey, String::new(), sig]))
}

/// Make sure every agent in this machine's fleet has a key the office knows.
pub fn provision(
    store: &SecretStore,
    server: &str,
    office: &dyn Office,
) -> Result<Provisioned, IdentityError> {
    provision_with(store, server, office, identity::load_or_create(store)?)
}

/// See `identity::load_or_create_with` for why the identity is an argument:
/// the environment escape hatch is process-wide, and tests run in parallel.
pub fn provision_with(
    store: &SecretStore,
    server: &str,
    office: &dyn Office,
    owner: Identity,
) -> Result<Provisioned, IdentityError> {
    // The blob before the fleet: a locked keychain must stop this before a
    // single request leaves the machine, let alone before a key is made.
    let mut blob = store.load()?;
    let fleet = office.fleet().map_err(IdentityError::Office)?;

    let mut out = Provisioned::default();
    let mut dirty = false;

    for agent in fleet {
        let slot_name = slot(server, &agent.agent_id);

        // A key already here. Reuse it — and if the office has forgotten it
        // (a rotation elsewhere, a recreated database), register *this* key
        // again rather than minting another. The agent is assigned to run
        // here; here is where its key is.
        let held: Option<(Zeroizing<[u8; 32]>, String)> = match blob.slots.get(&slot_name) {
            Some(existing) => match decode_secret(existing) {
                Ok(secret) => {
                    let pubkey = public_key_hex(&secret)?;
                    Some((secret, pubkey))
                }
                Err(_) => {
                    out.skipped.push(Skipped {
                        name: agent.name.clone(),
                        why: "the key held for it does not decode".into(),
                    });
                    continue;
                }
            },
            None => None,
        };

        let (secret, pubkey, fresh) = match held {
            Some((secret, pubkey)) => (secret, pubkey, false),
            None => {
                let signing = SigningKey::random(&mut rand_core::OsRng);
                let secret: Zeroizing<[u8; 32]> = Zeroizing::new(signing.to_bytes().into());
                let pubkey = public_key_hex(&secret)?;
                (secret, pubkey, true)
            }
        };

        let known = agent.pubkey.as_deref() == Some(pubkey.as_str());
        if !known {
            let attestation = attest(&owner, &pubkey)?;
            if let Err(why) = office.register(&agent.agent_id, &pubkey, &attestation) {
                // Nothing is written for a key the office did not accept: a
                // key held here that the office never learned is a key that
                // can only ever be refused at the door.
                out.skipped.push(Skipped {
                    name: agent.name.clone(),
                    why,
                });
                continue;
            }
            out.registered.push(agent.name.clone());
        }

        if fresh {
            blob.slots.insert(slot_name, nsec_of(&secret)?);
            dirty = true;
        }
        out.keys
            .insert(agent.agent_id.clone(), Zeroizing::new(nsec_of(&secret)?));
    }

    // An identity from the environment is never written down, and neither are
    // keys vouched for by it: the next start registers them again, which is
    // the right price for a key that was meant to be ephemeral.
    if dirty && !owner.is_ephemeral() {
        store.store(&blob, &owner.npub()?)?;
    }

    Ok(out)
}

/// What goes into `QUINTAL_AGENT_KEYS`: a JSON object of agent id to nsec.
pub fn env_value(keys: &BTreeMap<String, Zeroizing<String>>) -> Zeroizing<String> {
    let plain: BTreeMap<&str, &str> = keys
        .iter()
        .map(|(id, nsec)| (id.as_str(), nsec.as_str()))
        .collect();
    Zeroizing::new(serde_json::to_string(&plain).unwrap_or_else(|_| "{}".into()))
}

/// The real office, over HTTP, with the machine's token.
pub struct HttpOffice {
    server: String,
    token: String,
}

impl HttpOffice {
    pub fn new(server: &str, token: &str) -> Self {
        Self {
            server: server.trim_end_matches('/').to_string(),
            token: token.to_string(),
        }
    }

    fn agent() -> ureq::Agent {
        ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(15))
            .build()
    }
}

#[derive(Deserialize)]
struct FleetBody {
    agents: Vec<FleetAgent>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<String>,
}

fn describe(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let body = response
                .into_json::<ErrorBody>()
                .ok()
                .and_then(|body| body.error)
                .unwrap_or_default();
            if body.is_empty() {
                format!("the office answered {code}")
            } else {
                format!("the office answered {code}: {body}")
            }
        }
        ureq::Error::Transport(transport) => format!("could not reach the office: {transport}"),
    }
}

impl Office for HttpOffice {
    fn fleet(&self) -> Result<Vec<FleetAgent>, String> {
        let body: FleetBody = Self::agent()
            .get(&format!("{}/api/host/fleet", self.server))
            .set("authorization", &format!("Bearer {}", self.token))
            .call()
            .map_err(describe)?
            .into_json()
            .map_err(|error| format!("the fleet list did not parse: {error}"))?;
        Ok(body.agents)
    }

    fn register(
        &self,
        agent_id: &str,
        agent_pubkey: &str,
        attestation: &Attestation,
    ) -> Result<(), String> {
        Self::agent()
            .post(&format!(
                "{}/api/agents/{}/credential",
                self.server, agent_id
            ))
            .set("authorization", &format!("Bearer {}", self.token))
            .send_json(serde_json::json!({
                "agentPubkey": agent_pubkey,
                "attestation": attestation.0,
            }))
            .map(|_| ())
            .map_err(describe)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::load_or_create_with;
    use crate::secrets::{Backend, SecretStore};
    use k256::schnorr::signature::hazmat::PrehashVerifier;
    use k256::schnorr::{Signature, VerifyingKey};
    use sha2::{Digest, Sha256};
    use std::cell::RefCell;

    const SERVER: &str = "https://office.example.test";

    /// An office that remembers what was registered and can be told to refuse.
    struct FakeOffice {
        fleet: RefCell<Vec<FleetAgent>>,
        registered: RefCell<Vec<(String, String, Attestation)>>,
        refuse: bool,
        unreachable: bool,
    }

    impl FakeOffice {
        fn with(agents: &[(&str, &str)]) -> Self {
            Self {
                fleet: RefCell::new(
                    agents
                        .iter()
                        .map(|(id, name)| FleetAgent {
                            agent_id: id.to_string(),
                            name: name.to_string(),
                            pubkey: None,
                        })
                        .collect(),
                ),
                registered: RefCell::new(Vec::new()),
                refuse: false,
                unreachable: false,
            }
        }

        fn registrations(&self) -> Vec<(String, String, Attestation)> {
            self.registered.borrow().clone()
        }
    }

    impl Office for FakeOffice {
        fn fleet(&self) -> Result<Vec<FleetAgent>, String> {
            if self.unreachable {
                return Err("could not reach the office".into());
            }
            Ok(self.fleet.borrow().clone())
        }

        fn register(
            &self,
            agent_id: &str,
            agent_pubkey: &str,
            attestation: &Attestation,
        ) -> Result<(), String> {
            if self.refuse {
                return Err("the office answered 422".into());
            }
            self.registered.borrow_mut().push((
                agent_id.to_string(),
                agent_pubkey.to_string(),
                attestation.clone(),
            ));
            // The office now knows it, the way the real one would on the next pull.
            for agent in self.fleet.borrow_mut().iter_mut() {
                if agent.agent_id == agent_id {
                    agent.pubkey = Some(agent_pubkey.to_string());
                }
            }
            Ok(())
        }
    }

    fn new_store() -> (tempfile::TempDir, SecretStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SecretStore::with_backend(dir.path(), Backend::File).unwrap();
        (dir, store)
    }

    fn owner(store: &SecretStore) -> Identity {
        load_or_create_with(store, None).unwrap()
    }

    fn pubkey_of(nsec: &str) -> String {
        public_key_hex(&decode_secret(nsec).unwrap()).unwrap()
    }

    #[test]
    fn a_new_agent_gets_a_key_the_owner_vouched_for() {
        let (_dir, store) = new_store();
        let office = FakeOffice::with(&[("a1", "buzz")]);
        let owner_pubkey = owner(&store).public_key_hex().unwrap();

        let out = provision_with(&store, SERVER, &office, owner(&store)).unwrap();

        assert_eq!(out.registered, vec!["buzz".to_string()]);
        assert!(out.skipped.is_empty());
        let nsec = out.keys.get("a1").expect("a key for buzz");
        let agent_pubkey = pubkey_of(nsec);

        // Registered exactly once, with the key the harness will be handed.
        let registrations = office.registrations();
        assert_eq!(registrations.len(), 1);
        let (id, registered_pubkey, attestation) = &registrations[0];
        assert_eq!(id, "a1");
        assert_eq!(registered_pubkey, &agent_pubkey);

        // The attestation names the owner and is signed by them over exactly
        // the preimage the office rebuilds.
        assert_eq!(attestation.0[0], owner_pubkey);
        assert_eq!(attestation.0[1], "");
        let digest = Sha256::digest(attestation_preimage(&agent_pubkey, "").as_bytes());
        let key = VerifyingKey::from_bytes(&hex::decode(&owner_pubkey).unwrap()).unwrap();
        let sig = Signature::try_from(hex::decode(&attestation.0[2]).unwrap().as_slice()).unwrap();
        key.verify_prehash(&digest, &sig)
            .expect("the owner's signature over the attestation preimage");

        // And the secret is in the keychain blob, under this server and agent.
        let blob = store.load().unwrap();
        assert_eq!(
            blob.slots.get(&slot(SERVER, "a1")).map(String::as_str),
            Some(nsec.as_str())
        );
    }

    #[test]
    fn a_held_key_the_office_knows_is_not_registered_again() {
        let (_dir, store) = new_store();
        let office = FakeOffice::with(&[("a1", "buzz")]);
        let first = provision_with(&store, SERVER, &office, owner(&store)).unwrap();
        let second = provision_with(&store, SERVER, &office, owner(&store)).unwrap();

        assert_eq!(office.registrations().len(), 1, "once");
        assert!(second.registered.is_empty());
        assert_eq!(
            first.keys.get("a1"),
            second.keys.get("a1"),
            "the same key, every start"
        );
    }

    #[test]
    fn a_key_the_office_forgot_is_registered_again_not_replaced() {
        // A recreated database, or a rotation from the settings page to a key
        // that lives elsewhere: the office's pubkey for the agent is not the
        // one held here. The agent is assigned to run *here*, so the key here
        // is re-registered — and not minted afresh, which would churn the
        // audit log and the keychain for nothing.
        let (_dir, store) = new_store();
        let office = FakeOffice::with(&[("a1", "buzz")]);
        let first = provision_with(&store, SERVER, &office, owner(&store)).unwrap();
        office.fleet.borrow_mut()[0].pubkey = Some("f".repeat(64));

        let again = provision_with(&store, SERVER, &office, owner(&store)).unwrap();

        assert_eq!(again.registered, vec!["buzz".to_string()]);
        assert_eq!(office.registrations().len(), 2);
        assert_eq!(
            office.registrations()[1].1,
            pubkey_of(first.keys.get("a1").unwrap()),
            "the key held here, again",
        );
        assert_eq!(first.keys.get("a1"), again.keys.get("a1"));
    }

    #[test]
    fn a_registration_the_office_refuses_leaves_no_key_behind() {
        let (_dir, store) = new_store();
        let mut office = FakeOffice::with(&[("a1", "buzz"), ("a2", "ann")]);
        office.refuse = true;

        let out = provision_with(&store, SERVER, &office, owner(&store)).unwrap();

        assert!(out.keys.is_empty(), "nothing to hand the harness");
        assert_eq!(out.skipped.len(), 2);
        assert!(out.skipped[0].why.contains("422"));
        let blob = store.load().unwrap();
        assert!(
            !blob.slots.keys().any(|k| k.starts_with(AGENT_KEY_SLOT)),
            "a key the office never learned is not kept",
        );
    }

    #[test]
    fn a_locked_keychain_stops_everything_before_a_key_is_made() {
        // The rule this whole design exists for. The marker says keys exist
        // and the store will not open: refuse. Never mint a replacement the
        // office would happily accept over the one that is locked away.
        let (dir, store) = new_store();
        let office = FakeOffice::with(&[("a1", "buzz")]);
        let identity = owner(&store);
        provision_with(&store, SERVER, &office, owner(&store)).unwrap();
        std::fs::remove_file(dir.path().join("secrets.json")).unwrap();

        let result = provision_with(&store, SERVER, &office, identity);

        assert!(
            matches!(
                result,
                Err(IdentityError::Secrets(crate::secrets::SecretsError::Locked))
            ),
            "locked, not empty: {result:?}",
        );
        assert_eq!(
            office.registrations().len(),
            1,
            "nothing new reached the office"
        );
    }

    #[test]
    fn an_unreachable_office_is_an_error_and_writes_nothing() {
        let (_dir, store) = new_store();
        let mut office = FakeOffice::with(&[("a1", "buzz")]);
        office.unreachable = true;
        let identity = owner(&store);
        let before = store.load().unwrap().slots.len();

        let result = provision_with(&store, SERVER, &office, identity);

        assert!(matches!(result, Err(IdentityError::Office(_))));
        assert_eq!(store.load().unwrap().slots.len(), before);
    }

    #[test]
    fn keys_are_kept_apart_by_server() {
        let (_dir, store) = new_store();
        let office = FakeOffice::with(&[("a1", "buzz")]);
        let here = provision_with(&store, SERVER, &office, owner(&store)).unwrap();
        let other = FakeOffice::with(&[("a1", "buzz")]);
        let there =
            provision_with(&store, "https://other.example.test", &other, owner(&store)).unwrap();
        assert_ne!(here.keys.get("a1"), there.keys.get("a1"));
    }

    #[test]
    fn the_environment_value_is_a_json_object_of_id_to_nsec() {
        let mut keys = BTreeMap::new();
        keys.insert("a1".to_string(), Zeroizing::new("nsec1x".to_string()));
        keys.insert("a2".to_string(), Zeroizing::new("nsec1y".to_string()));
        assert_eq!(&*env_value(&keys), r#"{"a1":"nsec1x","a2":"nsec1y"}"#);
        assert_eq!(&*env_value(&BTreeMap::new()), "{}");
    }

    /// The whole ceremony against a real office, then a real harness.
    ///
    /// Ignored by default: it needs an office running, a machine registered in
    /// it, and the owner's key. Point it at one with
    ///
    ///     QUINTAL_LIVE_SERVER=http://localhost:3200 \
    ///     QUINTAL_LIVE_TOKEN=qh_… QUINTAL_PRIVATE_KEY=nsec1… \
    ///     QUINTAL_ACP_BIN=…/quintal-acp \
    ///     cargo test live_ -- --ignored --nocapture
    ///
    /// and the office's audit log then says which door each agent came through.
    #[test]
    #[ignore]
    fn live_office_round_trip() {
        let server = std::env::var("QUINTAL_LIVE_SERVER").expect("QUINTAL_LIVE_SERVER");
        let token = std::env::var("QUINTAL_LIVE_TOKEN").expect("QUINTAL_LIVE_TOKEN");
        let owner_key = std::env::var("QUINTAL_PRIVATE_KEY").expect("QUINTAL_PRIVATE_KEY");
        let repos = std::env::var("QUINTAL_LIVE_REPOS").expect("QUINTAL_LIVE_REPOS");

        let (_dir, store) = new_store();
        let office = HttpOffice::new(&server, &token);
        let identity =
            load_or_create_with(&store, Some(decode_secret(&owner_key).unwrap())).unwrap();

        let first = provision_with(&store, &server, &office, identity).unwrap();
        eprintln!(
            "registered: {:?}; skipped: {:?}; keys for: {:?}",
            first.registered,
            first.skipped,
            first.keys.keys().collect::<Vec<_>>()
        );
        assert!(
            !first.keys.is_empty(),
            "the office assigned nothing to this machine"
        );
        assert!(first.skipped.is_empty(), "{:?}", first.skipped);

        // An ephemeral owner key writes nothing down, so the second pass
        // registers again — with the same keys it just made? No: fresh ones,
        // because nothing was kept. That is the documented price of an
        // environment identity; assert it so it stays deliberate.
        let identity =
            load_or_create_with(&store, Some(decode_secret(&owner_key).unwrap())).unwrap();
        let second = provision_with(&store, &server, &office, identity).unwrap();
        assert_eq!(second.registered.len(), first.registered.len());

        // Now the harness, with the map in its environment, against the office.
        let fleet = crate::spawn::Fleet::new();
        let keys = env_value(&second.keys);
        fleet
            .start(std::path::Path::new(&repos), &server, &token, Some(&keys))
            .expect("the harness starts");
        std::thread::sleep(std::time::Duration::from_secs(12));
        for line in fleet.logs() {
            eprintln!("[{}] {}", line.stream, line.text);
        }
        fleet
            .stop_within(std::time::Duration::from_secs(5))
            .expect("the harness stops");
    }

    #[test]
    fn an_agent_cannot_be_vouched_for_with_its_owners_own_key() {
        let (_dir, store) = new_store();
        let identity = owner(&store);
        let own = identity.public_key_hex().unwrap();
        assert!(attest(&identity, &own).is_err());
    }
}
