import { eq } from 'drizzle-orm';

import { npubDecode, npubEncode, parsePubkey } from '../identity.js';
import { closeDb, getDb } from '../db/client.js';
import { loadRootEnv } from '../db/env.js';
import { users } from '../db/schema.js';
import {
  listInstanceAdmins,
  setInstanceAdmin,
} from '../db/settings.js';
import { resolveDatabaseUrl } from '../db/url.js';

/**
 * `pnpm admin` — who may change instance-wide settings.
 *
 * The whole reason this exists rather than a setting somewhere: whoever is in
 * charge has to be correctable from outside the app. The first account on an
 * instance is made admin automatically, and on an instance that has been
 * through any testing that first account may well be a stale identity nobody
 * uses — which is exactly what happened here.
 *
 * There is no admin panel; the plan cuts one. This is the smaller thing that
 * has to exist underneath: a way to say who is in charge, from a shell, on a
 * machine you already control.
 *
 *   pnpm admin                       who is in charge
 *   pnpm admin grant  npub1…         add somebody
 *   pnpm admin revoke npub1…         remove somebody
 */
function usage(): void {
  console.log(
    [
      'pnpm admin                 list who may change instance settings',
      'pnpm admin grant  <npub>   let somebody change them',
      'pnpm admin revoke <npub>   stop somebody changing them',
    ].join('\n'),
  );
}

/** Accepts an `npub1…` or bare hex, because both get pasted. */
function toPubkey(raw: string): string | null {
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('npub1')) return npubDecode(trimmed);
  } catch {
    return null;
  }
  return parsePubkey(trimmed);
}

async function list(): Promise<void> {
  const admins = await listInstanceAdmins(getDb());
  if (admins.length === 0) {
    // Reachable: every admin revoked, or a database restored from before this
    // existed. Worth saying plainly, because the office cannot be renamed and
    // nothing in the app explains why.
    console.log('Nobody. Instance settings cannot be changed until somebody is.');
    console.log('  pnpm admin grant <npub>');
    return;
  }
  console.log(`${admins.length} can change instance settings:`);
  for (const admin of admins) {
    console.log(`  ${npubEncode(admin.pubkey)}  ${admin.name}`);
  }
}

async function change(raw: string, admin: boolean): Promise<void> {
  const pubkey = toPubkey(raw);
  if (!pubkey) {
    console.error(`${raw} is not an npub or a public key.`);
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.pubkey, pubkey))
    .limit(1);

  const user = rows[0];
  if (!user) {
    // Deliberately not created here. An account appears when somebody signs in
    // with a key; inventing one from a shell would put a row in the office for
    // a person who has never been to it.
    console.error('No account here has that key. They have to sign in once first.');
    process.exitCode = 1;
    return;
  }

  await setInstanceAdmin(db, user.id, admin);
  console.log(`${user.name} ${admin ? 'can' : 'can no longer'} change instance settings.`);
}

async function main(): Promise<void> {
  loadRootEnv();
  const [command, who] = process.argv.slice(2);

  if (command === undefined) {
    console.log(`[admin] ${resolveDatabaseUrl().url}`);
    await list();
  } else if ((command === 'grant' || command === 'revoke') && who) {
    console.log(`[admin] ${resolveDatabaseUrl().url}`);
    await change(who, command === 'grant');
  } else {
    usage();
    process.exitCode = 1;
  }

  await closeDb();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
