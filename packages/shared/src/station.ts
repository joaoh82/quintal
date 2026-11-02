import { normaliseBoardBody, normaliseBoardTitle } from './board.js';

/**
 * A task begun from a desk, as the office reads a `desk_begin`: the desk,
 * the agent, and what the task is — a note already on the board, or the
 * title and details of one the office writes now.
 */
export type DeskBeginInput =
  | { seatId: string; agentId: string; what: { kind: 'note'; itemId: string } }
  | { seatId: string; agentId: string; what: { kind: 'typed'; title: string; body: string } };

function id(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

/**
 * Rebuild a `desk_begin` payload. Null when it names no desk or no agent, or
 * says neither which note nor what the task is. A note wins over a typed
 * title when both are sent: the number is the one that follows the work.
 * A title is read as the board reads one — one line, trimmed, capped at
 * `BOARD_TITLE_MAX_LENGTH` — because it becomes a note.
 */
export function parseDeskBegin(value: unknown): DeskBeginInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const seatId = id(v.seatId);
  const agentId = id(v.agentId);
  if (!seatId || !agentId) return null;
  const itemId = v.itemId === undefined || v.itemId === null ? null : id(v.itemId);
  if (v.itemId !== undefined && v.itemId !== null && !itemId) return null;
  if (itemId) return { seatId, agentId, what: { kind: 'note', itemId } };
  const title = normaliseBoardTitle(v.title);
  if (!title) return null;
  return { seatId, agentId, what: { kind: 'typed', title, body: normaliseBoardBody(v.body) } };
}
