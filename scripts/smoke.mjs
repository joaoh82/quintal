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
 *
 * Needs a server already running (`pnpm start` or `pnpm dev`).
 */
import {
  buildAuthPayload,
  generateSecretKey,
  getPublicKeyHex,
  signAuthPayload,
} from '@quintal/shared';

const base = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

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
 * own error screen, so the body is checked for the shapes that means.
 */
async function page(path, cookie, label = path) {
  const response = await fetch(`${base}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
  const body = response.status < 400 ? await response.text() : '';
  const brokenMarkers = [
    'A &quot;use server&quot; file',
    'A "use server" file',
    'Runtime Error',
    'Internal Server Error',
    'Application error: a server-side exception',
  ];
  const marker = brokenMarkers.find((m) => body.includes(m));
  check(
    response.status === 200 && !marker,
    label,
    response.status !== 200 ? `HTTP ${response.status}` : (marker ?? ''),
  );
}

console.log(`smoke: ${base}`);

console.log('\npublic pages');
await page('/', null);
await page('/login', null);
// A token that is well-formed but unknown: renders the refusal, not a crash.
await page(`/join/v2.${'A'.repeat(43)}`, null, '/join/[token] (unknown token)');

console.log('\nsigned in');
const cookie = await signIn();
check(true, 'keypair sign-in');
for (const path of [
  '/office',
  '/settings',
  '/settings/profile',
  '/settings/agents',
  '/settings/guests',
]) {
  await page(path, cookie);
}

console.log('');
if (failures.length > 0) {
  console.error(`smoke FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('smoke passed');
