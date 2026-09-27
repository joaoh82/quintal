/**
 * What a runtime's permission options actually authorise.
 *
 * The office used to answer "may I run this?" with whichever option carried
 * the ACP kind `allow_always`, and label the result "for the rest of this
 * session". Both halves were guesses. `allow_always` is a *kind*, not a
 * promise: one runtime attaches it to "allow all edits in this directory
 * during this session", another to "Always allow" with nothing said at all,
 * and Claude Code attaches it to three options on a plan-exit request whose
 * real effects are "use auto mode", "clear context and use auto mode" and
 * "bypass permissions". Taking the first one found is not a policy.
 *
 * So this is a catalogue of established facts, and `unknown` is a first-class
 * answer. An option nobody has measured stays unknown; unknown is never
 * offered, never auto-taken, and never described to a person. Every entry
 * carries how it was established and when, so a wrong one can be argued with
 * rather than guessed at — the same rule `runtimes.ts` follows.
 *
 * Evidence lives in `docs/RUNTIME-PERMISSIONS.md`, and the probes that
 * produced it are `packages/acp-harness/scripts/probe-permissions.mts` and
 * `probe-grant-lifetime.mts`.
 */

/** How much one option authorises. */
export const GRANT_BREADTHS = [
  /** Exactly the call being asked about, and nothing else. */
  'this_call',
  /** Every action of this kind under a directory. */
  'directory',
  /** Every action of this tool category. */
  'tool_category',
  /** Not a tool grant at all: it changes how the session decides everything. */
  'session_policy',
  /** Not established. Never offered, never taken. */
  'unknown',
] as const;
export type GrantBreadth = (typeof GRANT_BREADTHS)[number];

/** How long it lasts. */
export const GRANT_LIFETIMES = [
  'this_call',
  /** Until this session ends. A new session asks again. */
  'session',
  /** Written down somewhere: it outlives the process. */
  'persisted',
  'unknown',
] as const;
export type GrantLifetime = (typeof GRANT_LIFETIMES)[number];

/** What one option of one runtime means. */
export interface RuntimeOptionSemantics {
  breadth: GrantBreadth;
  lifetime: GrantLifetime;
  /** Where a grant is written, when it is written anywhere. Null when nothing is. */
  persistsAt: string | null;
  /**
   * Whether taking this reduces how much the runtime will ask in future.
   *
   * Breadth and lifetime do not capture this on their own, and the gap had
   * teeth: Claude Code's four plan-exit options are *all* `session_policy` +
   * `session`, so they ranked equal and the choice fell to whatever order the
   * runtime happened to send. "Yes, manually approve edits" and "Yes, and
   * bypass permissions" are not interchangeable, and nothing about how far a
   * grant reaches says which is which — only which direction it moves the
   * next question in.
   *
   * So this is ranked before breadth, and an option that loosens future
   * permission is never offered on a card as a mere allow.
   */
  loosensFuturePermission: boolean;
  /** How this was established. Shown in the docs, not in the UI. */
  evidence: string;
}

/** One catalogued option: matched by the runtime's own id, or by ACP kind. */
export interface RuntimeOptionEntry extends RuntimeOptionSemantics {
  /** The runtime's `optionId`, when the meaning belongs to that exact option. */
  optionId?: string;
  /** The ACP `kind`, when the meaning holds for every option of that kind here. */
  kind?: string;
}

/** Whether a runtime has been seen to ask at all. */
export type AsksStatus =
  /** Observed sending `session/request_permission`. */
  | 'verified'
  /** Driven end to end and it never asked. Quintal's approvals cannot reach it. */
  | 'never_observed'
  /** Not established — not installed here, or not reachable when probed. */
  | 'unknown';

export interface RuntimePermissionProfile {
  runtimeId: string;
  asks: AsksStatus;
  /** One or two sentences an owner should read before trusting this runtime. */
  notes: string;
  options: RuntimeOptionEntry[];
  /**
   * Grants this runtime keeps for itself, outside Quintal — what they are and
   * where to look. Quintal cannot see or revoke these, and says so rather
   * than implying otherwise.
   */
  externalGrants: string | null;
  /** ISO date the entry was last established against a real runtime. */
  verifiedAt: string;
  /**
   * The exact adapter this was measured against, so a moved one can be seen.
   *
   * The evidence strings say this in prose already, but prose cannot be
   * compared to a handshake. `agentInfo` at `initialize` gives a name and a
   * version; this is the pair it is checked against. Null where nothing was
   * measured at all — an `unknown` profile has no version to have moved from.
   */
  verifiedAgainst: AdapterIdentity | null;
}

/** An adapter as it names itself at `initialize`. */
export interface AdapterIdentity {
  name: string;
  version: string;
}

/**
 * Bound on either half of a reported adapter identity.
 *
 * `agentInfo` comes off a process this machine spawned, but it reaches an
 * owner's settings page, so it is held to a length like everything else a
 * key holder can write there. See `HOST_REPORT_LIMITS` in `runtimes.ts`.
 */
export const ADAPTER_IDENTITY_MAX_LENGTH = 128;

/** Everything not established. The answer for an option nobody has measured. */
export const UNKNOWN_SEMANTICS: RuntimeOptionSemantics = {
  breadth: 'unknown',
  lifetime: 'unknown',
  persistsAt: null,
  // Unestablished is assumed to loosen: it is never offered or auto-taken
  // anyway, and the conservative reading is the right default.
  loosensFuturePermission: true,
  evidence: 'Not established.',
};

const CLAUDE_CODE: RuntimePermissionProfile = {
  runtimeId: 'claude-code',
  asks: 'verified',
  notes:
    'Asks only in the "Manual" (`default`) mode; `auto`, `acceptEdits` and `bypassPermissions` decide for themselves and never send a request. Manual asks before changes — a file edit asks, a shell command it judges safe does not.',
  options: [
    {
      optionId: 'allow-once',
      kind: 'allow_once',
      breadth: 'this_call',
      lifetime: 'this_call',
      persistsAt: null,
      loosensFuturePermission: false,
      evidence: 'Named "Yes". QUIN-52\'s live probe saw the next request asked again.',
    },
    {
      optionId: 'allow-with-updates',
      kind: 'allow_always',
      breadth: 'directory',
      lifetime: 'session',
      persistsAt: null,
      loosensFuturePermission: true,
      evidence:
        'Names itself "Yes, allow all edits in <dir>/ during this session". Measured: after taking it, the same edit and a different edit in that session were not asked again; a new session asked again, and so did a restart; no runtime settings file changed.',
    },
    {
      optionId: 'reject',
      kind: 'reject_once',
      breadth: 'this_call',
      lifetime: 'this_call',
      persistsAt: null,
      loosensFuturePermission: false,
      evidence: 'Named "No".',
    },
    // The plan-exit request is not a tool permission at all. Its `toolCall`
    // has kind `switch_mode`, and every option changes how the whole session
    // decides from then on — including two that stop it asking and one that
    // throws the conversation away. An office that reads only the ACP kind
    // would take the first `allow_always` here, which is "clear context and
    // use auto mode".
    {
      optionId: 'exit-plan-default',
      kind: 'allow_once',
      breadth: 'session_policy',
      lifetime: 'session',
      persistsAt: null,
      loosensFuturePermission: false,
      evidence: '"Yes, manually approve edits" — leaves plan mode for Manual. Observed 2026-09-24.',
    },
    {
      optionId: 'exit-plan-auto',
      kind: 'allow_always',
      breadth: 'session_policy',
      lifetime: 'session',
      persistsAt: null,
      loosensFuturePermission: true,
      evidence: '"Yes, and use auto mode" — the session stops asking. Observed 2026-09-24.',
    },
    {
      optionId: 'exit-plan-clear-auto',
      kind: 'allow_always',
      breadth: 'session_policy',
      lifetime: 'session',
      persistsAt: null,
      loosensFuturePermission: true,
      evidence:
        '"Yes, clear context and use auto mode" — the session stops asking *and* the conversation is discarded. Observed 2026-09-24.',
    },
    {
      optionId: 'exit-plan-bypass',
      kind: 'allow_always',
      breadth: 'session_policy',
      lifetime: 'session',
      persistsAt: null,
      loosensFuturePermission: true,
      evidence: '"Yes, and bypass permissions". Observed 2026-09-24.',
    },
  ],
  externalGrants:
    'Claude Code keeps its own allow rules in ~/.claude/settings.json (and a project .claude/settings.local.json). Quintal neither writes nor reads them; they are managed with the `claude` CLI.',
  verifiedAt: '2026-09-24',
  verifiedAgainst: { name: '@agentclientprotocol/claude-agent-acp', version: '0.81.2' },
};

const OMP: RuntimePermissionProfile = {
  runtimeId: 'omp',
  asks: 'verified',
  notes:
    'Asks before shell commands in its `default` mode. It did not ask before writing a file in the working directory.',
  options: [
    {
      optionId: 'allow_once',
      kind: 'allow_once',
      breadth: 'this_call',
      lifetime: 'this_call',
      persistsAt: null,
      loosensFuturePermission: false,
      evidence: 'Named "Allow once". The next command asked again.',
    },
    {
      optionId: 'allow_always',
      kind: 'allow_always',
      breadth: 'tool_category',
      lifetime: 'session',
      persistsAt: null,
      loosensFuturePermission: true,
      evidence:
        'Named only "Always allow", which says nothing, so it was measured: after taking it, the same command and a *different* shell command in that session were not asked again; a new session asked again, and so did a restart. Nothing under ~/.omp changed but session transcripts, logs and model caches.',
    },
    {
      optionId: 'reject_once',
      kind: 'reject_once',
      breadth: 'this_call',
      lifetime: 'this_call',
      persistsAt: null,
      loosensFuturePermission: false,
      evidence: 'Named "Reject".',
    },
    {
      optionId: 'reject_always',
      kind: 'reject_always',
      breadth: 'tool_category',
      lifetime: 'session',
      persistsAt: null,
      loosensFuturePermission: true,
      evidence:
        'Named "Always reject". Catalogued as the mirror of "Always allow"; never selected, because a standing refusal denies requests the owner was never shown.',
    },
  ],
  externalGrants: null,
  verifiedAt: '2026-09-24',
  verifiedAgainst: { name: 'oh-my-pi', version: '18.2.6' },
};

const CODEX: RuntimePermissionProfile = {
  runtimeId: 'codex',
  asks: 'never_observed',
  notes:
    'Never sent `session/request_permission` in any of its three modes. In `read-only` — the mode it describes as "Always ask to edit external files" — it created a file **outside** its working directory without asking. Quintal\'s approval cards cannot reach this runtime; its own settings are the only control.',
  options: [],
  externalGrants:
    'Codex decides in-process from its own approval policy and sandbox settings (~/.codex/config.toml). Nothing about those decisions reaches Quintal, and Quintal cannot change or revoke them.',
  verifiedAt: '2026-09-24',
  verifiedAgainst: { name: '@agentclientprotocol/codex-acp', version: '1.13.1' },
};

const OPENCODE: RuntimePermissionProfile = {
  runtimeId: 'opencode',
  asks: 'never_observed',
  notes:
    'Never sent `session/request_permission` in either of its modes (`build`, `plan`) for a file write, a shell command, or a write outside the working directory.',
  options: [],
  externalGrants:
    "opencode decides from its own `permission` configuration. Quintal neither sees nor changes it.",
  verifiedAt: '2026-09-24',
  verifiedAgainst: { name: 'opencode', version: '1.4.3' },
};

const GEMINI: RuntimePermissionProfile = {
  runtimeId: 'gemini',
  asks: 'unknown',
  notes:
    'Not established: the probe machine had no API key configured, so `session/new` failed before anything could be asked.',
  options: [],
  externalGrants: null,
  verifiedAt: '2026-09-24',
  verifiedAgainst: null,
};

const GOOSE: RuntimePermissionProfile = {
  runtimeId: 'goose',
  asks: 'unknown',
  notes: 'Not established: not installed on any machine this has been probed from.',
  options: [],
  externalGrants: null,
  verifiedAt: '2026-09-24',
  verifiedAgainst: null,
};

export const RUNTIME_PERMISSIONS: readonly RuntimePermissionProfile[] = [
  CLAUDE_CODE,
  CODEX,
  GEMINI,
  GOOSE,
  OMP,
  OPENCODE,
] as const;

/** What has been established about one runtime, or nothing. */
export function permissionProfile(runtimeId: string): RuntimePermissionProfile | undefined {
  return RUNTIME_PERMISSIONS.find((profile) => profile.runtimeId === runtimeId);
}

/**
 * How long a measurement is allowed to stand before it is only a rumour.
 *
 * Six months is a judgement, not a finding. It is long enough that nobody is
 * re-probing on a treadmill and short enough that an entry cannot quietly
 * outlive the adapter it describes by a year. The catalogue test fails when
 * an entry passes it, so the window is enforced against the tree rather than
 * against anybody's memory.
 */
export const VERIFICATION_WINDOW_DAYS = 183;

/** Why a profile's measured facts should no longer be trusted. */
export type StalenessReason =
  /** The adapter now names a different version than the one measured. */
  | 'version_moved'
  /** Nothing has been re-measured inside the verification window. */
  | 'expired';

export interface Staleness {
  reason: StalenessReason;
  /** What the catalogue was measured against. */
  catalogued: string;
  /** What is actually running, when that is what moved. */
  observed: string | null;
}

/**
 * Whether what is running is still the thing that was measured.
 *
 * Only ever positive about a *difference*. An unobserved version is not a
 * mismatch — most callers never see a handshake, and treating "did not look"
 * as "moved" would degrade every path in the office to the spec fallback.
 *
 * A changed name counts as much as a changed version: an adapter that renamed
 * itself is not the adapter the evidence describes, whatever its numbering.
 */
export function adapterMoved(
  profile: RuntimePermissionProfile,
  observed: AdapterIdentity | null | undefined,
): Staleness | null {
  const measured = profile.verifiedAgainst;
  if (!measured || !observed) return null;
  if (measured.name === observed.name && measured.version === observed.version) return null;
  return {
    reason: 'version_moved',
    catalogued: `${measured.name} ${measured.version}`,
    observed: `${observed.name} ${observed.version}`,
  };
}

/** Whether the measurement has simply aged out, whatever is running. */
export function verificationExpired(
  profile: RuntimePermissionProfile,
  now: Date = new Date(),
): Staleness | null {
  const verified = Date.parse(`${profile.verifiedAt}T00:00:00Z`);
  if (Number.isNaN(verified)) return null;
  const days = (now.getTime() - verified) / 86_400_000;
  if (days <= VERIFICATION_WINDOW_DAYS) return null;
  return { reason: 'expired', catalogued: profile.verifiedAt, observed: null };
}

/**
 * Whether this profile's measured facts still stand — and if not, why.
 *
 * The reporting view, for a warning line or a settings page: it answers for
 * both triggers. The decision path in `optionSemantics` uses `adapterMoved`
 * alone and says there why.
 *
 * A profile with nothing measured (`verifiedAgainst: null`, no options) can
 * never go stale: there is nothing to have moved out from under. Saying so
 * here keeps `unknown` reachable rather than collapsing it into `expired`.
 */
export function profileStaleness(
  profile: RuntimePermissionProfile,
  observed?: AdapterIdentity | null,
  now: Date = new Date(),
): Staleness | null {
  if (!profile.verifiedAgainst) return null;
  return adapterMoved(profile, observed) ?? verificationExpired(profile, now);
}

/**
 * What ACP itself defines a kind to mean, for an option nothing has been
 * established about.
 *
 * `allow_once` and `reject_once` are read from the protocol, not guessed from
 * their names: ACP defines them as permitting or refusing *this* operation,
 * and a runtime that sends one is making that claim. So an uncatalogued
 * runtime can still be allowed once — which is what keeps a CLI nobody has
 * probed yet usable rather than silently unusable.
 *
 * `allow_always` and `reject_always` get no default, deliberately. The
 * protocol does not say how far "always" reaches, and the runtimes that have
 * been measured disagree: one means every edit under a directory for this
 * session, another means the whole shell category for this session, and
 * Claude Code attaches the same kind to "bypass permissions". There is no
 * honest default to give, so there is none.
 *
 * Any catalogued entry beats this — including an `allow_once` that is really
 * something else, which is exactly Claude Code's plan-exit case.
 */
const SPEC_DEFAULTS: Readonly<Record<string, RuntimeOptionSemantics>> = {
  allow_once: {
    breadth: 'this_call',
    lifetime: 'this_call',
    persistsAt: null,
    loosensFuturePermission: false,
    evidence: 'ACP defines `allow_once` as permitting this operation only.',
  },
  reject_once: {
    breadth: 'this_call',
    lifetime: 'this_call',
    persistsAt: null,
    loosensFuturePermission: false,
    evidence: 'ACP defines `reject_once` as refusing this operation only.',
  },
};

/**
 * What one offered option means here — by the runtime's own option id first,
 * then by ACP kind for this runtime, then by what the protocol defines, then
 * not at all.
 *
 * The id comes first because that is where the meaning actually lives: two
 * options of the same kind in the same request can differ by everything that
 * matters, which is exactly the Claude Code plan-exit case.
 *
 * `observed` is the adapter as it named itself at `initialize`, when the
 * caller has a handshake to hand. When it does not, the catalogue is trusted
 * as before — "did not look" must not read as "moved", or every path that
 * never sees a handshake would degrade for no reason.
 */
export function optionSemantics(
  runtimeId: string,
  option: { optionId?: unknown; kind?: unknown },
  observed?: AdapterIdentity | null,
): RuntimeOptionSemantics {
  const catalogued = permissionProfile(runtimeId);
  // A moved adapter is not the one the catalogue measured, so its entries
  // stop being evidence about what is running now, and lookup degrades to
  // `SPEC_DEFAULTS` — the state an uncatalogued runtime is already in, where
  // `allow_once` still resolves and `allow_always` is refused as unexplained.
  // Usable rather than dead, and a path already in the tree rather than a
  // second one to reason about.
  //
  // Expiry deliberately does *not* degrade here. `verificationExpired` fails
  // the catalogue test, which is a change somebody makes and reviews; making
  // it degrade live would mean an office's buttons quietly narrowing one
  // morning because a date passed, with no adapter having moved and nothing
  // in the tree different. A measurement going unrefreshed is a debt owed by
  // this repository, not a fact about the runtime on somebody's laptop.
  const stale = catalogued !== undefined && adapterMoved(catalogued, observed) !== null;
  const profile = stale ? undefined : catalogued;
  const optionId = typeof option.optionId === 'string' ? option.optionId : undefined;
  const kind = typeof option.kind === 'string' ? option.kind : undefined;

  // Stale evidence is still enough to refuse with, just not to allow with.
  //
  // The asymmetry matters, and dropping it re-opens the bug QUIN-53 closed.
  // Claude Code's `exit-plan-default` carries kind `allow_once` while really
  // being a session-policy switch; degrade it to its kind and the spec
  // default makes it per-call, so the run scope takes it automatically and
  // the card says "Allow once" — exactly the false promise the catalogue was
  // built to stop, reappearing the moment an adapter bumps.
  //
  // "This option was measured as broader than per-call" is a fact about how
  // this runtime names things, and a version bump is no reason to believe it
  // got *narrower*. So a known-broad id stays unexplained rather than
  // reverting to its kind.
  //
  // A rename escapes this, and that escape is **not** always safe. It is
  // safe when the renamed id's kind is honest. It is not when the kind
  // lies: a moved adapter that renames `exit-plan-default` while keeping
  // kind `allow_once` is unknown to the catalogue, lands on the spec
  // default, and becomes an offerable per-call allow the `run` scope takes
  // automatically — QUIN-53's bug, re-opened through a rename.
  //
  // It is uncloseable here. A renamed lying id is indistinguishable at the
  // payload from a genuinely new, honest per-call option, and refusing every
  // unrecognised `allow_once` would kill "degraded, not dead" for the far
  // commoner case of a plain rename. What bounds it is the same thing that
  // bounds the reused-id gap: it needs a release that also moves the version,
  // and re-probing is what actually closes it. There is a failing-by-design
  // test recording this in `runtime-permissions.test.ts`.
  if (stale && optionId !== undefined) {
    const known = catalogued?.options.find((entry) => entry.optionId === optionId);
    if (known && !grantIsPerCall(known)) return UNKNOWN_SEMANTICS;
  }
  if (profile && optionId !== undefined) {
    const exact = profile.options.find((entry) => entry.optionId === optionId);
    if (exact) return exact;
  }
  if (profile && kind !== undefined) {
    // Only a kind entry that is not tied to a specific option id may stand in
    // for one: an id-specific fact says nothing about its neighbours.
    const byKind = profile.options.find(
      (entry) => entry.optionId === undefined && entry.kind === kind,
    );
    if (byKind) return byKind;
  }
  if (kind !== undefined && SPEC_DEFAULTS[kind]) return SPEC_DEFAULTS[kind];
  return UNKNOWN_SEMANTICS;
}

/** Whether both halves are established, so this can be put to a person at all. */
export function grantIsExplainable(semantics: RuntimeOptionSemantics): boolean {
  return semantics.breadth !== 'unknown' && semantics.lifetime !== 'unknown';
}

/** Whether this authorises the one call being asked about and nothing more. */
export function grantIsPerCall(semantics: RuntimeOptionSemantics): boolean {
  return semantics.breadth === 'this_call' && semantics.lifetime === 'this_call';
}

const BREADTH_RANK: Record<GrantBreadth, number> = {
  this_call: 0,
  directory: 1,
  tool_category: 2,
  session_policy: 3,
  unknown: 4,
};
const LIFETIME_RANK: Record<GrantLifetime, number> = {
  this_call: 0,
  session: 1,
  persisted: 2,
  unknown: 3,
};

/**
 * Negative when `a` authorises strictly less than `b`. Narrowest first.
 *
 * Whether it loosens future permission is compared *before* breadth, because
 * breadth and lifetime tie on exactly the case where the difference matters
 * most: Claude Code's plan-exit options are all `session_policy` + `session`,
 * so without this term "manually approve edits" and "bypass permissions" rank
 * equal and the winner is whichever the runtime listed first. A sort whose
 * result depends on payload order is not a policy.
 */
export function compareGrants(a: RuntimeOptionSemantics, b: RuntimeOptionSemantics): number {
  return (
    Number(a.loosensFuturePermission) - Number(b.loosensFuturePermission) ||
    BREADTH_RANK[a.breadth] - BREADTH_RANK[b.breadth] ||
    LIFETIME_RANK[a.lifetime] - LIFETIME_RANK[b.lifetime]
  );
}

/**
 * Whether this may be put on a card as an allow at all.
 *
 * Two conditions, and both are about what a person can be held to. It has to
 * be explainable, and it must not quietly buy less asking in future — an
 * owner clicking one button on one request is answering *that* request, and
 * "and stop asking me" is not a rider they consented to. So a loosening
 * option is never offered, even when it is the only allow the runtime sent;
 * the card then carries Deny alone, which is honest about the choice
 * available rather than inventing one.
 */
export function grantIsOfferable(semantics: RuntimeOptionSemantics): boolean {
  return grantIsExplainable(semantics) && !semantics.loosensFuturePermission;
}

const BREADTH_WORDS: Record<GrantBreadth, string> = {
  this_call: 'this one action',
  directory: 'anything like it in the working directory',
  tool_category: 'anything else this tool does',
  session_policy: "this session's whole permission policy",
  unknown: 'an unknown amount',
};
const LIFETIME_WORDS: Record<GrantLifetime, string> = {
  this_call: 'once',
  session: 'until this session ends',
  persisted: 'until it is removed in the runtime',
  unknown: 'for an unknown time',
};

/** One sentence a person can act on: "anything like it …, until this session ends". */
export function describeGrant(semantics: RuntimeOptionSemantics): string {
  return `${BREADTH_WORDS[semantics.breadth]}, ${LIFETIME_WORDS[semantics.lifetime]}`;
}

/** The button's words. Must never promise less than `describeGrant` says. */
export function grantLabel(semantics: RuntimeOptionSemantics): string {
  if (grantIsPerCall(semantics)) return 'Allow once';
  switch (semantics.breadth) {
    case 'directory':
      return semantics.lifetime === 'session' ? 'Allow here, this session' : 'Allow here';
    case 'tool_category':
      return semantics.lifetime === 'session' ? 'Allow this tool, this session' : 'Allow this tool';
    case 'session_policy':
      // The only offerable one is the non-loosening exit — Claude Code's
      // "manually approve edits". Say what it leaves behind, because "change
      // session policy" is true of the bypass option too.
      return 'Allow, and keep asking';
    default:
      // Unknown never reaches a button; a label for it would be the very
      // claim this module exists to stop.
      return 'Allow';
  }
}
