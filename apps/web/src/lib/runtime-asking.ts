import {
  RUN_SCOPE_WITHDRAWAL_NOTE,
  RUN_SCOPE_WITHDRAWAL_NOTE_NEVER_ASKS,
  permissionProfile,
  runtimeById,
  type AsksStatus,
} from '@quintal/shared';

/**
 * What must be said about a runtime that has never been seen to ask.
 *
 * A `never_observed` runtime must not be described as gated: leaving `run` off
 * promises the owner that commands will be put to them, and on those runtimes
 * none ever are. Why each runtime carries the status it does is in
 * `docs/RUNTIME-PERMISSIONS.md` and the catalogue's own `notes`.
 *
 * The claim is about tool permissions alone. Every other scope is enforced by
 * the office regardless of what the runtime does, so nothing here may read as
 * "this agent is ungoverned".
 */
export interface AskingCaveat {
  /** Which fact this is. `verified` never produces a caveat. */
  status: Exclude<AsksStatus, 'verified'>;
  /** Two or three words for a row or a card, where a sentence will not fit. */
  badge: string;
  /** The sentence an owner has to read before trusting the `run` scope here. */
  headline: string;
  /**
   * The same fact in one clause, for a surface with no room for the sentence —
   * the office card is a few hundred pixels wide. Shorter, never softer.
   */
  summary: string;
  /**
   * Where the runtime's own control lives, when the catalogue names the file.
   * Null rather than a guess: pointing at the wrong settings file is worse
   * than pointing at none.
   *
   * The headline deliberately stops before "and here is where it is decided",
   * because this says that with the path in it. Two sentences making the same
   * claim, one of them vaguer, is how a notice stops being read.
   */
  externalGrants: string | null;
}

/**
 * What must be said about this runtime's asking, or null when nothing must be.
 *
 * Null for three reasons that all mean "say nothing": the runtime is
 * `verified`, the agent has no runtime the office decided, or the id is not in
 * the catalogue — an uncatalogued id gets silence rather than a warning,
 * because a warning would be a claim about a runtime nobody has measured.
 *
 * `unknown` reads deliberately weaker than `never_observed`: "we have not
 * established this" and "we drove it and it never asked" are different facts,
 * and only the second changes what an owner should expect.
 */
export function askingCaveat(runtimeId: string | null | undefined): AskingCaveat | null {
  if (!runtimeId) return null;
  const profile = permissionProfile(runtimeId);
  if (!profile || profile.asks === 'verified') return null;
  const label = runtimeById(runtimeId)?.label ?? runtimeId;

  if (profile.asks === 'never_observed') {
    return {
      status: 'never_observed',
      badge: 'never asks',
      headline: `${label} decides tool permissions itself: driven end to end, it never once asked Quintal. Leaving the run scope off will not put its commands to you, and taking it away stops nothing. The other scopes are unaffected — the office enforces those itself.`,
      summary: `${label} decides tool permissions itself; the run scope does not gate them.`,
      externalGrants: profile.externalGrants,
    };
  }

  return {
    status: 'unknown',
    badge: 'asking unverified',
    headline: `It has not been established whether ${label} ever asks Quintal for tool permission. If it does not, leaving the run scope off will not put its commands to you. The other scopes are unaffected either way — the office enforces those itself.`,
    summary: `Not established whether ${label} ever asks Quintal for tool permission.`,
    externalGrants: profile.externalGrants,
  };
}

/**
 * What to say after withdrawing `run` from an agent on this runtime.
 *
 * The general note keeps its wording for every runtime that does ask; only a
 * `never_observed` one gets the companion. `unknown` keeps the general note
 * too: we have not established that the withdrawal changes nothing, and
 * saying it did would be its own unfounded claim.
 */
export function runWithdrawalNote(runtimeId: string | null | undefined): string {
  return askingCaveat(runtimeId)?.status === 'never_observed'
    ? RUN_SCOPE_WITHDRAWAL_NOTE_NEVER_ASKS
    : RUN_SCOPE_WITHDRAWAL_NOTE;
}
