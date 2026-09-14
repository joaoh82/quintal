/**
 * Fetch every page as a signed-in human and insist each one renders.
 *
 * This exists because a bug shipped that no other check could see: a
 * `'use server'` file exported a constant, which is illegal, and it surfaced
 * only when React rendered the form that used it. Typecheck passed, the unit
 * tests passed, `next build` passed — every page here is `force-dynamic`, so
 * none of them are rendered at build time — and the protocol-level smoke tests
 * spoke HTTP and WebSocket without ever asking for HTML.
 *
 * So: sign in the way the browser does, then GET the pages. A route that throws
 * during render answers 500, and that is the whole test.
 *
 *   node scripts/smoke.mjs [baseUrl]
 *   node scripts/smoke.mjs [baseUrl] --save-identity /tmp/identity.json
 *   node scripts/smoke.mjs [baseUrl] --identity /tmp/identity.json
 *
 * `--save-identity` writes the session cookie after sign-in. `--identity`
 * reuses that cookie instead of minting a new key — the compose smoke uses
 * this after `docker compose restart` to prove the auth secret and the
 * database both live on the volume. A rotated secret invalidates the cookie
 * and this path fails.
 *
 * Needs a server already running (`pnpm start`, `pnpm dev`, or compose).
 */
import { readFileSync, writeFileSync } from 'node:fs';

import {
  buildAuthPayload,
  generateSecretKey,
  getPublicKeyHex,
  signAuthPayload,
} from '@quintal/shared';

function parseArgs(argv) {
  let base = 'http://127.0.0.1:3000';
  let saveIdentity = null;
  let identity = null;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--save-identity') {
      saveIdentity = argv[++i];
      if (!saveIdentity) throw new Error('--save-identity needs a path');
    } else if (arg === '--identity') {
      identity = argv[++i];
      if (!identity) throw new Error('--identity needs a path');
    } else if (arg.startsWith('http://') || arg.startsWith('https://')) {
      base = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { base: base.replace(/\/$/, ''), saveIdentity, identity };
}

const { base, saveIdentity, identity } = parseArgs(process.argv);

const failures = [];
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function signIn() {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKeyHex(secretKey);

  const challenge = await fetch(`${base}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey }),
  });
  if (!challenge.ok) throw new Error(`challenge failed: ${challenge.status}`);
  const { nonce, origin } = await challenge.json();

  const payload = buildAuthPayload({
    origin,
    nonce,
    timestamp: Math.floor(Date.now() / 1000),
  });
  // The Origin header has to match what the server considers its own, or the
  // login-CSRF gate refuses us — which is the gate doing its job.
  const verify = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ pubkey, sig: signAuthPayload(secretKey, payload), payload }),
  });
  if (!verify.ok) {
    throw new Error(`verify failed: ${verify.status} ${await verify.text()}`);
  }
  const cookie = (verify.headers.get('set-cookie') ?? '')
    .split(/,(?=[^;]+=)/)
    .map((part) => part.split(';')[0].trim())
    .join('; ');
  if (!cookie) throw new Error('verify set no session cookie');
  return cookie;
}

/**
 * A 200 is necessary but not sufficient: Next can answer 200 while showing its
 * own error screen, so the body is checked for the shapes that means. With
 * `mustContain`, the page also has to be the page: a route that answered 200
 * with the wrong page — the landing page where the office should be — is a
 * page the status alone cannot tell apart.
 *
 * `mustContain` is not optional decoration on a page with a client component.
 * When React cannot resolve one — the "Could not find the module … in the
 * React Client Manifest" failure, QUIN-9 — the route can still answer 200 and
 * stream HTML with that component simply absent. Measured, not assumed: with
 * one entry removed from `/settings/agents`'s client reference manifest, the
 * page came back 200 with 15KB of markup and no agents UI in it, and this
 * script called it ok. A status code cannot see that. A string only that
 * component renders can.
 */
/**
 * What the build actually put in a route's client reference manifest.
 *
 * Printed only when a page fails, and only to say which half of QUIN-9 this
 * is. The error React throws is the same whether the build wrote an
 * incomplete manifest or the server read the wrong one, and telling those
 * apart after the fact cost an afternoon of log archaeology. The manifest is
 * right there on disk next to the server that just served the page: read it.
 *
 * Best effort in every direction — no `.next`, a different layout, an
 * unparseable file — because a diagnostic that throws while explaining a
 * failure has made the failure harder to read, not easier.
 */
async function manifestReport(path) {
  try {
    const { readFileSync } = await import('node:fs');
    const file = new URL(
      `../apps/web/.next/server/app${path}/page_client-reference-manifest.js`,
      import.meta.url,
    );
    const source = readFileSync(file, 'utf8');
    const context = { __RSC_MANIFEST: {} };
    const { runInNewContext } = await import('node:vm');
    runInNewContext(source, context);
    const manifest = context.__RSC_MANIFEST[`${path}/page`];
    if (!manifest) return `manifest on disk has no entry for ${path}/page`;
    const modules = Object.keys(manifest.clientModules);
    const own = modules.filter((key) => key.includes(`/app${path}/`));
    return `manifest on disk: ${modules.length} client modules, ${own.length} from this route — ${
      own.map((key) => key.split('/').pop()).join(', ') || 'none'
    }`;
  } catch (error) {
    return `manifest on disk: could not be read (${error.code ?? error.message})`;
  }
}

async function page(path, cookie, label = path, mustContain = null) {
  const response = await fetch(`${base}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
  const body = response.status < 400 ? await response.text() : '';
  if (mustContain !== null && response.status === 200 && !body.includes(mustContain)) {
    check(false, label, `200 but no "${mustContain}" in it`);
    console.log(`       ${await manifestReport(path)}`);
    return;
  }
  const brokenMarkers = [
    'A &quot;use server&quot; file',
    'A "use server" file',
    'Runtime Error',
    'Internal Server Error',
    'Application error: a server-side exception',
  ];
  const marker = brokenMarkers.find((m) => body.includes(m));
  const ok = response.status === 200 && !marker;
  check(ok, label, response.status !== 200 ? `HTTP ${response.status}` : (marker ?? ''));
  // A 5xx on a page with a client component is the other face of the same
  // failure — QUIN-9 was reported as a 500 and reproduces as a silent 200 —
  // so say what the build put in the manifest either way.
  if (!ok && mustContain !== null) console.log(`       ${await manifestReport(path)}`);
}

/**
 * A page that must send this visitor somewhere else. The root is the landing
 * page for a stranger and a door to the office for somebody signed in; a
 * signed-in visitor shown the landing page is told to sign in when they
 * already have.
 */
async function redirects(path, cookie, to, label = `${path} → ${to}`) {
  const response = await fetch(`${base}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
  const location = response.headers.get('location') ?? '';
  const sentThere =
    response.status >= 300 && response.status < 400 && new URL(location, base).pathname === to;
  check(sentThere, label, sentThere ? '' : `HTTP ${response.status} ${location}`);
}

console.log(`smoke: ${base}`);

console.log('\npublic pages');
await page('/', null);
await page('/login', null);
// A token that is well-formed but unknown: renders the refusal, not a crash.
await page(`/join/v2.${'A'.repeat(43)}`, null, '/join/[token] (unknown token)');

console.log('\nsigned in');
let cookie;
if (identity) {
  const saved = JSON.parse(readFileSync(identity, 'utf8'));
  cookie = saved.cookie;
  if (!cookie) throw new Error(`${identity} has no cookie`);
  check(true, 'keypair sign-in (restored session)');
} else {
  cookie = await signIn();
  check(true, 'keypair sign-in');
  if (saveIdentity) {
    writeFileSync(saveIdentity, JSON.stringify({ cookie }, null, 2));
  }
}
await redirects('/', cookie, '/office');
// The game itself mounts in the browser, so the server's HTML carries the
// office's header and not the canvas; the header is what says it is the office.
await page('/office', cookie, '/office', 'Enter to chat');
// Each of these renders a client component, and each marker is a string only
// that component puts on the page. A page that answered 200 without its own
// component in it is the shape QUIN-9 took, and the only thing that catches it.
for (const [path, marker] of [
  ['/settings', 'Save'],
  ['/settings/profile', 'Display name'],
  ['/settings/agents', 'Create agent'],
  ['/settings/guests', 'Links you have made'],
  ['/settings/channels', 'New channel'],
  ['/settings/teams', 'New team'],
]) {
  await page(path, cookie, path, marker);
}

console.log('');
if (failures.length > 0) {
  console.error(`smoke FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('smoke passed');
