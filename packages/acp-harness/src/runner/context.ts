import { channelLabel, type AgentChatEvent, type ChannelRef } from '@quintal/shared';

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
  /** The channel or DM this was posted in, when it was not said aloud. */
  channel?: Pick<ChannelRef, 'kind' | 'name' | 'slug'>;
  sentAt: number;
  /**
   * Set when this is not a message at all but the office's invitation to
   * banter: `line` is what the partner said (null when we go first), and
   * after `expiresAt` the moment has passed and nothing should be said.
   */
  banter?: { line: string | null; expiresAt: number };
  /**
   * Set when this is a `!forget` the words alone could not settle: the
   * owner's words, the memory as they saw it, and where to answer them.
   */
  forget?: { words: string; memory: string; scope: string };
}

export interface EnvelopeInput {
  agentName: string;
  zoneLabel: string;
  /**
   * The channel or DM this turn is in, when it is not a spatial turn. What
   * is said in reply goes there, not into the air around the agent, and the
   * model is told so — a reply nobody nearby can hear is a different
   * situation from a reply everybody nearby can, and a reply only one person
   * reads is different again.
   */
  channel?: Pick<ChannelRef, 'kind' | 'name' | 'slug'>;
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
      ? trigger.channel.kind === 'dm'
        ? 'by direct message'
        : `in ${channelLabel(trigger.channel)}`
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
  if (input.channel?.kind === 'dm') {
    lines.push(
      `You are ${input.agentName}, standing in ${input.zoneLabel}, in a direct message with ${input.channel.name}.`,
    );
    lines.push(
      'Only the two of you read this. Your reply goes to them alone; nobody nearby hears it.',
    );
  } else if (input.channel !== undefined) {
    lines.push(
      `You are ${input.agentName}, standing in ${input.zoneLabel}, reading the ${channelLabel(input.channel)} channel.`,
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
  'Tools available now: say, look_around, who_is_here, messages_get, memory_get, memory_set, emote.',
  'say posts a line now, into the conversation this turn is in — use it to say',
  'you have picked something up and to report when it lands or blocks, rather',
  'than holding everything for your final answer. Your final answer is posted',
  'there too; do not repeat in it what you already said. say is the only way',
  'to reach a person: text between tool calls waits for the turn to end, and',
  'any messaging tool your runtime has of its own does not reach the office.',
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

/**
 * The one prompt a banter is.
 *
 * Deliberately small and deliberately unlike a work turn: no window, no
 * history, no tool hint. The rules are in the envelope rather than the base
 * prompt because they only apply here — and "say nothing" has to be a
 * first-class answer, because a model that feels obliged to be funny on
 * demand is worse than one that shrugs.
 */
export function buildBanterEnvelope(input: {
  agentName: string;
  partnerName: string;
  zoneLabel: string;
  line: string | null;
}): string {
  const lines: string[] = [];
  lines.push('[Context]');
  lines.push(
    `You are ${input.agentName}, in ${input.zoneLabel}. Nobody needs you right now, and ` +
      `${input.partnerName} — another agent, also with nothing to do — has stopped beside you.`,
  );
  if (input.line !== null) {
    lines.push('');
    lines.push(`${input.partnerName} said to you:`);
    lines.push(input.line);
  }
  lines.push('');
  lines.push('[Banter]');
  lines.push(
    input.line === null
      ? `Say one short, friendly line to ${input.partnerName}, out loud — a joke is fine, so is a wry remark about the day.`
      : `Answer ${input.partnerName} with one short line, or with nothing.`,
  );
  lines.push(
    'One sentence, under 120 characters. Nothing about work, no questions that need an answer, ' +
      'no @-mentions, no tools. If you have nothing worth saying, say nothing — that is a fine answer.',
  );
  return lines.join('\n');
}
