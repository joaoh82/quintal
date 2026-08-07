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
  /** Tiles away, or null for a mention from across the map. */
  distance: number | null;
  sentAt: number;
}

export interface EnvelopeInput {
  agentName: string;
  zoneLabel: string;
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
    trigger.distance === null
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
  lines.push(`You are ${input.agentName}, in ${input.zoneLabel}.`);

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
 * The one-line reminder of the tool surface, appended to the system prompt at
 * session creation. A line, not a manual: the tools describe themselves through
 * MCP, and repeating their schemas here would be paying for them twice.
 */
export const TOOL_HINT =
  'Tools available now: look_around, who_is_here, messages_get, memory_get, memory_set.';

/** Trim the conversation window to the messages that belong in a prompt. */
export function selectWindow(
  history: readonly AgentChatEvent[],
  triggerTimes: ReadonlySet<number>,
): AgentChatEvent[] {
  return history
    .filter((message) => !triggerTimes.has(message.sentAt))
    .slice(-WINDOW_SIZE);
}
