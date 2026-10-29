import {
  BOARD_LAST_SEEN_GRAIN_MS,
  type BoardAgentRef,
  type BoardItemRef,
  type BoardPayload,
  type BoardTaskRef,
  type MembershipRole,
} from '@quintal/shared';

/**
 * The board as the room holds it, and as it is sent. Pure, so the two rules
 * here are pinned by tests rather than by watching sockets.
 *
 * 1. The board is re-sent only when it changed, and an agent being heard
 *    from is not a change. `agents.last_seen_at` is rewritten on nearly
 *    every command an agent sends; rounded to the minute before it goes in,
 *    the signature holds still while the panel still says "last seen 2h ago".
 * 2. A guest reads the notes, which is the board's policy from the start.
 *    They do not get the office's history of work, nor the names of its
 *    machines: the ledger and `hostLabel`, `runtimeId`, `modelId` are a
 *    member's.
 */

export interface BoardView {
  items: readonly BoardItemRef[];
  agents: readonly BoardAgentRef[];
  tasks: readonly BoardTaskRef[];
}

/** Agents as the board carries them: `lastSeenAt` rounded down to the grain. */
export function boardAgentsOf(agents: readonly BoardAgentRef[], grainMs = BOARD_LAST_SEEN_GRAIN_MS): BoardAgentRef[] {
  return agents.map((agent) =>
    agent.lastSeenAt === null ? agent : { ...agent, lastSeenAt: Math.floor(agent.lastSeenAt / grainMs) * grainMs },
  );
}

/** What the room compares one read with the next by. Equal means nobody is sent anything. */
export function boardSignatureOf(view: BoardView): string {
  return JSON.stringify([view.items, view.agents, view.tasks]);
}

/** The board as a person of this role is sent it. */
export function boardForRole(view: BoardView, role: MembershipRole | null): Omit<BoardPayload, 'you'> {
  if (role !== null) {
    return { items: [...view.items], agents: [...view.agents], tasks: [...view.tasks] };
  }
  return {
    items: [...view.items],
    agents: view.agents.map((agent) => ({ ...agent, hostLabel: null, runtimeId: null, modelId: null })),
    tasks: [],
  };
}
