import {
  RUN_SCOPE_WITHDRAWAL_NOTE,
  RUN_SCOPE_WITHDRAWAL_NOTE_NEVER_ASKS,
  permissionProfile,
  runtimeById,
  type AsksStatus,
} from '@quintal/shared';

/**
 * Whether the office can honestly claim to be gating an agent's tools.
 *
 * QUIN-53 drove every installed runtime end to end and found two that never
 * send `session/request_permission` at all: Codex, which created a file
 * *outside* its working directory in the mode it calls "Always ask to edit
 * external files", and opencode, in both of its modes. The catalogue has said
 * so since — `asks: 'never_observed'` — and the harness logs it, into its own
 * stdout, where the owner setting scopes in a browser never sees it. The fact
 * was on the wrong side of the screen.
 *
 * It matters because of what an owner believes when they leave `run` off, or
 * take it away: that every command the agent is unsure about will be put to
 * them. On those two runtimes nothing ever is, and withdrawing `run` — which
 * reads as "I have taken this authority back" — takes back nothing, because
 * nothing was routed through Quintal in the first place.
 *
 * This is honesty about a limit, not a fix for it. Quintal cannot make Codex
 * ask, and nothing here blocks or hides anything: an owner may run an agent on
 * Codex, they simply should not be able to believe Quintal is gating it.
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
   */
  externalGrants: string | null;
}

/**
 * What must be said about this runtime's asking, or null when nothing must be.
 *
 * Null for three different reasons, all of which mean "say nothing": the
 * runtime is `verified` (it does ask, and the office's cards reach it), the
 * agent has no runtime the office decided, or the id is not in the catalogue
 * at all — a fleet file written against a newer catalogue, say. An unknown id
 * gets silence rather than a warning, because a warning would be a claim
 * about a runtime nobody has measured.
 *
 * `unknown` reads deliberately weaker than `never_observed`. "We have not
 * established this" and "we drove it and it never asked" are different facts,
 * and only the second one changes what an owner should expect. Gemini and
 * Goose are `unknown` today, for want of an API key and an install.
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
      headline: `${label} decides tool permissions itself. Driven end to end, it never once asked Quintal — so nothing here gates what this agent does, with or without the run scope, and the runtime's own settings are the only control.`,
      summary: `${label} decides for itself; Quintal gates nothing here.`,
      externalGrants: profile.externalGrants,
    };
  }

  return {
    status: 'unknown',
    badge: 'asking unverified',
    headline: `It has not been established whether ${label} ever asks Quintal for permission. If it does not, leaving the run scope off gates nothing, and the runtime's own settings are the only control.`,
    summary: `Not established whether ${label} ever asks Quintal.`,
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
