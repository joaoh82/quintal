/**
 * Create (or re-key) an agent with a keypair of its own, from the command line.
 *
 * The settings page is the real path — *Register a key* on the agent's card
 * generates the keypair in your browser and signs the attestation with the key
 * you signed in with. This exists for the same reason `agent-new` does: setting
 * up a fleet by hand means doing that once per agent, and copying an `nsec` each
 * time before it disappears.
 *
 *   QUINTAL_OWNER_NSEC=nsec1… just agent-key reviewer
 *
 * The owner's key is what vouches for the agent, so it has to be present — the
 * office cannot sign on anyone's behalf, which is the whole point. The agent is
 * created under whoever that key belongs to (they must have signed in once), or
 * re-keyed if an agent of that name already exists. The `nsec` alone goes to
 * stdout so `KEY=$(just agent-key x)` works; everything else goes to stderr.
 */
import {
  generateSecretKey,
  getPublicKeyHex,
  npubEncode,
  nsecEncode,
  parseSecretKey,
  signAttestation,
} from '@quintal/shared';
import {
  createAgent,
  ensurePersonalWorkspace,
  findUserByPubkey,
  getDb,
  listAgentsForWorkspace,
  loadRootEnv,
  setAgentCredential,
} from '@quintal/shared/db';

loadRootEnv();

const name = process.argv[2];
const ownerSecret = process.env.QUINTAL_OWNER_NSEC ? parseSecretKey(process.env.QUINTAL_OWNER_NSEC) : null;
if (!name || !ownerSecret) {
  console.error('usage: QUINTAL_OWNER_NSEC=nsec1… just agent-key <name>');
  console.error('The owner signs the attestation, so their secret key is required — never stored, never printed.');
  process.exit(1);
}

const db = getDb();
const ownerPubkey = getPublicKeyHex(ownerSecret);
const owner = await findUserByPubkey(db, ownerPubkey);
if (!owner) {
  console.error(`no one with the key ${npubEncode(ownerPubkey)} has signed in to this office yet`);
  process.exit(1);
}

const workspace = await ensurePersonalWorkspace(db, {
  userId: owner.id,
  name: owner.name,
  pubkey: owner.pubkey,
});

const existing = (await listAgentsForWorkspace(db, workspace.id)).find(
  (agent) => agent.name === name && agent.revokedAt === null,
);
const agent =
  existing ??
  (await createAgent(db, { workspaceId: workspace.id, ownerUserId: owner.id, name, spriteKey: 'slate' }));

const secretKey = generateSecretKey();
const agentPubkey = getPublicKeyHex(secretKey);
await setAgentCredential(
  db,
  agent.id,
  {
    pubkey: agentPubkey,
    attestation: signAttestation({ agentPubkey, ownerPubkey, ownerSecretKey: ownerSecret }),
  },
  { via: 'session', userId: owner.id },
);

console.error(
  `${existing ? 're-keyed' : 'created'} "${name}" for ${owner.name || npubEncode(owner.pubkey)} — ${npubEncode(agentPubkey)}`,
);
console.log(nsecEncode(secretKey));
