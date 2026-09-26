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
}

/** Everything not established. The answer for an option nobody has measured. */
export const UNKNOWN_SEMANTICS: RuntimeOptionSemantics = {
  breadth: 'unknown',
  lifetime: 'unknown',
  persistsAt: null,
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
      evidence: 'Named "Yes". QUIN-52\'s live probe saw the next request asked again.',
    },
    {
      optionId: 'allow-with-updates',
      kind: 'allow_always',
      breadth: 'directory',
      lifetime: 'session',
      persistsAt: null,
      evidence:
        'Names itself "Yes, allow all edits in <dir>/ during this session". Measured: after taking it, the same edit and a different edit in that session were not asked again; a new session asked again, and so did a restart; no runtime settings file changed.',
    },
    {
      optionId: 'reject',
      kind: 'reject_once',
      breadth: 'this_call',
      lifetime: 'this_call',
      persistsAt: null,
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
      evidence: '"Yes, manually approve edits" — leaves plan mode for Manual. Observed 2026-09-24.',
    },
    {
      optionId: 'exit-plan-auto',
      kind: 'allow_always',
      breadth: 'session_policy',
      lifetime: 'session',
      persistsAt: null,
      evidence: '"Yes, and use auto mode" — the session stops asking. Observed 2026-09-24.',
    },
    {
      optionId: 'exit-plan-clear-auto',
      kind: 'allow_always',
      breadth: 'session_policy',
      lifetime: 'session',
      persistsAt: null,
      evidence:
        '"Yes, clear context and use auto mode" — the session stops asking *and* the conversation is discarded. Observed 2026-09-24.',
    },
    {
      optionId: 'exit-plan-bypass',
      kind: 'allow_always',
      breadth: 'session_policy',
      lifetime: 'session',
      persistsAt: null,
      evidence: '"Yes, and bypass permissions". Observed 2026-09-24.',
    },
  ],
  externalGrants:
    'Claude Code keeps its own allow rules in ~/.claude/settings.json (and a project .claude/settings.local.json). Quintal neither writes nor reads them; they are managed with the `claude` CLI.',
  verifiedAt: '2026-09-24',
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
      evidence: 'Named "Allow once". The next command asked again.',
    },
    {
      optionId: 'allow_always',
      kind: 'allow_always',
      breadth: 'tool_category',
      lifetime: 'session',
      persistsAt: null,
      evidence:
        'Named only "Always allow", which says nothing, so it was measured: after taking it, the same command and a *different* shell command in that session were not asked again; a new session asked again, and so did a restart. Nothing under ~/.omp changed but session transcripts, logs and model caches.',
    },
    {
      optionId: 'reject_once',
      kind: 'reject_once',
      breadth: 'this_call',
      lifetime: 'this_call',
      persistsAt: null,
      evidence: 'Named "Reject".',
    },
    {
      optionId: 'reject_always',
      kind: 'reject_always',
      breadth: 'tool_category',
      lifetime: 'session',
      persistsAt: null,
      evidence:
        'Named "Always reject". Catalogued as the mirror of "Always allow"; never selected, because a standing refusal denies requests the owner was never shown.',
    },
  ],
  externalGrants: null,
  verifiedAt: '2026-09-24',
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
};

const GEMINI: RuntimePermissionProfile = {
  runtimeId: 'gemini',
  asks: 'unknown',
  notes:
    'Not established: the probe machine had no API key configured, so `session/new` failed before anything could be asked.',
  options: [],
  externalGrants: null,
  verifiedAt: '2026-09-24',
};

const GOOSE: RuntimePermissionProfile = {
  runtimeId: 'goose',
  asks: 'unknown',
  notes: 'Not established: not installed on any machine this has been probed from.',
  options: [],
  externalGrants: null,
  verifiedAt: '2026-09-24',
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
    evidence: 'ACP defines `allow_once` as permitting this operation only.',
  },
  reject_once: {
    breadth: 'this_call',
    lifetime: 'this_call',
    persistsAt: null,
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
 */
export function optionSemantics(
  runtimeId: string,
  option: { optionId?: unknown; kind?: unknown },
): RuntimeOptionSemantics {
  const profile = permissionProfile(runtimeId);
  const optionId = typeof option.optionId === 'string' ? option.optionId : undefined;
  const kind = typeof option.kind === 'string' ? option.kind : undefined;
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

/** Negative when `a` authorises strictly less than `b`. Narrowest first. */
export function compareGrants(a: RuntimeOptionSemantics, b: RuntimeOptionSemantics): number {
  return (
    BREADTH_RANK[a.breadth] - BREADTH_RANK[b.breadth] ||
    LIFETIME_RANK[a.lifetime] - LIFETIME_RANK[b.lifetime]
  );
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
      return 'Change session policy';
    default:
      // Unknown never reaches a button; a label for it would be the very
      // claim this module exists to stop.
      return 'Allow';
  }
}
