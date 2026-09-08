/**
 * Secrets the harness holds, and the two places they must never go: a child
 * process, and a log line.
 *
 * The harness spawns the agent runtime with an environment, and the runtime
 * is a model with a shell. Whatever the harness was handed — the machine's
 * host token, the fleet's keys, one agent's `nsec` — must not be a variable
 * that runtime can print. The same names are what a key came in under, so the
 * list is built as keys are read rather than written down once and forgotten.
 *
 * No imports, so nothing in the harness can create a cycle by needing this.
 */

const ALWAYS = ['QUINTAL_AGENT_KEYS', 'QUINTAL_HOST_TOKEN', 'AGENT_KEY'] as const;

const noted = new Set<string>(ALWAYS);

/** Remember that a key was read from this variable, so children never see it. */
export function noteSecretEnv(name: string): void {
  if (name.trim().length > 0) noted.add(name.trim());
}

/** The variable names currently treated as secrets. For tests and diagnostics. */
export function secretEnvNames(): readonly string[] {
  return [...noted];
}

/** A copy of `env` with every secret variable removed. */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!noted.has(name)) copy[name] = value;
  }
  return copy;
}

/**
 * Blank out anything shaped like a credential in text bound for a log.
 *
 * Shapes, not values: the harness cannot know every string that is a secret,
 * but every secret it deals in has a recognisable prefix — `nsec1`, `qa_`,
 * `qh_` — chosen for exactly this reason. Public keys stay: an `npub` or a
 * hex pubkey is meant to be seen.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/nsec1[02-9ac-hj-np-z]{6,}/gi, 'nsec1…')
    .replace(/\bqa_[A-Za-z0-9_-]{6,}/g, 'qa_…')
    .replace(/\bqh_[A-Za-z0-9_-]{6,}/g, 'qh_…');
}
