/**
 * What a scope is, and how to read one.
 *
 * A scope names a conversation: a zone (by id, or `LOBBY_SCOPE` for the open
 * floor), a channel or DM, or a moment of banter with a colleague. Each has
 * its own queue of messages, its own history window, and — on whichever
 * runtime process answers it — its own ACP session.
 */

import { LOBBY_SCOPE } from './sessions.js';

/**
 * Scope prefix for a channel. Zones are scoped by zone id; a channel scope
 * cannot collide with one because no zone id carries a colon.
 */
export const CHANNEL_SCOPE = 'channel:';

/**
 * Scope prefix for a banter. Its session is thrown away after the one turn:
 * a joke told to a colleague must not sit in the zone's context when the
 * next real question arrives, and must not cost the zone its window.
 */
export const BANTER_SCOPE = 'banter:';

/**
 * Scope prefix for a `!forget` the words alone could not settle. Like banter:
 * one turn, no tools, thrown away — the model is asked which numbered note
 * the owner meant, and nothing it says is spoken as its own.
 */
export const FORGET_SCOPE = 'forget:';

export function channelScope(channelId: string): string {
  return `${CHANNEL_SCOPE}${channelId}`;
}

export function banterScope(partnerId: string): string {
  return `${BANTER_SCOPE}${partnerId}`;
}

export function isChannelScope(scope: string): boolean {
  return scope.startsWith(CHANNEL_SCOPE);
}

export function isBanterScope(scope: string): boolean {
  return scope.startsWith(BANTER_SCOPE);
}

export function forgetScope(key: string): string {
  return `${FORGET_SCOPE}${key}`;
}

export function isForgetScope(scope: string): boolean {
  return scope.startsWith(FORGET_SCOPE);
}

/** A one-turn session with no tools: banter, or a `!forget` put to the model. */
export function isThrowawayScope(scope: string): boolean {
  return isBanterScope(scope) || isForgetScope(scope);
}

/** The channel or DM id a scope names, or null for a spatial scope. */
export function channelIdOf(scope: string): string | null {
  return isChannelScope(scope) ? scope.slice(CHANNEL_SCOPE.length) : null;
}

/** Spatial: answered aloud, in the room the agent stands in. */
export function isSpatialScope(scope: string): boolean {
  return !isChannelScope(scope);
}

export { LOBBY_SCOPE };
