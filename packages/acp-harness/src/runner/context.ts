import type { AgentChatEvent } from '@quintal/shared';

/**
 * What an agent is told, per turn — and, more importantly, what it is not.
 *
 * The single most valuable lesson from Buzz's architecture is **pull-first**:
 * push a tiny envelope and let the agent fetch what it actually needs through
 * tools. Stuffing the prompt with the map, the roster and the full history is
 * the obvious design, costs tokens on every turn, and makes agents worse — they
 * answer from stale context instead of looking.
 *
 * So: the envelope below, a short window of the current conversation, and
 * nothing else. Ever.
 */

/** Messages of the current conversation pushed with a turn. */
export const WINDOW_SIZE = 12;

/** Most triggering messages drained into a single prompt. */
export const MAX_BATCH = 20;

export interface Trigger {
  /** Stable id of the speaker (`users.id` / `agents.id`). */
  fromUserId: string;
  fromName: string;
  fromKind: 'human' | 'agent';
  text: string;
  /** Tiles away, or null for a mention from across the map or a channel. */
  distance: number | null;
  /** The channel this was posted in, by slug, when it was not said aloud. */
  channel?: string;
  sentAt: number;
}

export interface EnvelopeInput {
  agentName: string;
  zoneLabel: string;
  /**
   * The channel this turn is in, by slug, when it is a channel turn. What is
   * said in reply goes to the channel, not into the air around the agent,
   * and the model is told so — a reply nobody nearby can hear is a different
   * situation from a reply everybody nearby can.
   */
  channel?: string;
  /** Triggering messages, oldest first. */
  triggers: Trigger[];
  /** Recent conversation, oldest first, excluding the triggers. */
  window: AgentChatEvent[];
  /** Set when this prompt follows work that was already in flight. */
  steer?: boolean;
}

function describeSender(trigger: Trigger): string {
  const kind = trigger.fromKind === 'agent' ? 'agent' : 'human';
  const where =
    trigger.channel !== undefined
      ? `in #${trigger.channel}`
      : trigger.distance === null
        ? 'mentioned you from elsewhere'
        : `${trigger.distance} tiles away`;
  return `${trigger.fromName} (${kind}, ${where})`;
}

/**
 * Build the `[Context]` envelope.
 *
 * Format is plain text on purpose: every harness handles it, and a human
 * reading `--log-dir` output can see exactly what their agent was told.
 */
export function buildEnvelope(input: EnvelopeInput): string {
  const lines: string[] = [];

  lines.push('[Context]');
  if (input.channel !== undefined) {
    lines.push(
      `You are ${input.agentName}, standing in ${input.zoneLabel}, reading the #${input.channel} channel.`,
    );
    lines.push(
      'Your reply is posted to the channel — every member reads it, wherever they are. Nobody nearby hears it.',
    );
  } else {
    lines.push(`You are ${input.agentName}, in ${input.zoneLabel}.`);
  }

  if (input.window.length > 0) {
    lines.push('');
    lines.push(`[Recent conversation — last ${input.window.length}]`);
    for (const message of input.window) {
      const marker = message.fromKind === 'agent' ? '◆' : '';
      lines.push(`${marker}${message.fromName}: ${message.text}`);
    }
  }

  lines.push('');
  if (input.steer === true) {
    // Not an interrupt: the turn that was running finished, and this arrived
    // while it did. Saying so stops the agent re-answering what it just
    // answered, which is the most common way these loops go wrong.
    lines.push('[new message — arrived while you were working]');
  }

  const [first] = input.triggers;
  if (input.triggers.length === 1 && first) {
    lines.push(`${describeSender(first)} said:`);
    lines.push(first.text);
  } else {
    lines.push(`${input.triggers.length} messages for you:`);
    for (const trigger of input.triggers) {
      lines.push(`- ${describeSender(trigger)}: ${trigger.text}`);
    }
  }

  return lines.join('\n');
}

/**
 * What the model is told about its tools, and when to reach for one.
 *
 * The list alone was not enough. `memory_set` was available from the start and
 * never once used: an owner would say "always greet people in Portuguese", the
 * model would agree, and the promise lived in the ACP session until it rotated
 * or the app restarted. The table was empty on a database that had been in use
 * for a week, which is what a tool nobody is told to reach for looks like.
 *
 * So the memory line says when, not just what. `!remember` covers the case
 * where the owner wants certainty rather than a good chance.
 */
export const TOOL_HINT = [
  'Tools available now: look_around, who_is_here, messages_get, memory_get, memory_set.',
  'When someone asks you to remember something, or tells you how they want you to',
  'work from now on, write it to core memory with memory_set — agreeing in',
  'conversation does not persist it, and it will be gone the next time you start.',
].join('\n');

/** Trim the conversation window to the messages that belong in a prompt. */
export function selectWindow(
  history: readonly AgentChatEvent[],
  triggerTimes: ReadonlySet<number>,
): AgentChatEvent[] {
  return history
    .filter((message) => !triggerTimes.has(message.sentAt))
    .slice(-WINDOW_SIZE);
}
