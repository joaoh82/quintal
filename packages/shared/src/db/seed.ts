import { randomUUID } from 'node:crypto';

import { getDb } from './client.js';
import { users } from './schema.js';
import { ensurePersonalWorkspace, findUserByPubkey } from './workspaces.js';
import {
  displayNameFromPubkey,
  generateSecretKey,
  getPublicKeyHex,
  npubEncode,
  nsecEncode,
  parsePubkey,
} from '../identity.js';

/**
 * Idempotent local seed: one human with their personal workspace, so you can
 * poke at the database without signing in first.
 *
 * With no `SEED_PUBKEY` set it mints a fresh keypair and prints the nsec, which
 * is the only time that secret is ever printed — the database stores the public
 * half and nothing else. Set `SEED_PUBKEY` (hex or npub) to seed a workspace
 * for a key you already hold, and no secret is generated at all.
 */
export async function seed(): Promise<void> {
  const db = getDb();

  const configured = process.env.SEED_PUBKEY;
  let pubkey: string;
  let nsec: string | null = null;

  if (configured) {
    const parsed = parsePubkey(configured);
    if (!parsed) {
      throw new Error(
        `SEED_PUBKEY is not a valid public key (expected hex or npub): ${configured}`,
      );
    }
    pubkey = parsed;
  } else {
    const secretKey = generateSecretKey();
    pubkey = getPublicKeyHex(secretKey);
    nsec = nsecEncode(secretKey);
  }

  const name = process.env.SEED_NAME ?? displayNameFromPubkey(pubkey);

  const existing = await findUserByPubkey(db, pubkey);
  const userId = existing?.id ?? randomUUID();

  if (!existing) {
    await db.insert(users).values({ id: userId, name, pubkey });
    console.log(`[seed] created user ${npubEncode(pubkey)}`);
    if (nsec) {
      console.log(
        [
          '',
          '  ┌─ Seed identity ' + '─'.repeat(47),
          `  │  npub: ${npubEncode(pubkey)}`,
          `  │  nsec: ${nsec}`,
          '  │',
          '  │  This secret is printed once and is not stored. Paste the nsec',
          '  │  into the sign-in page to use this identity.',
          '  └' + '─'.repeat(63),
          '',
        ].join('\n'),
      );
    }
  } else {
    console.log(`[seed] user ${npubEncode(pubkey)} already exists`);
  }

  const workspace = await ensurePersonalWorkspace(db, {
    userId,
    name: existing?.name ?? name,
    pubkey,
  });
  console.log(`[seed] workspace "${workspace.name}" (/${workspace.slug})`);
}
