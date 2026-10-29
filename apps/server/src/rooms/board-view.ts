import {
  BOARD_LAST_SEEN_GRAIN_MS,
  NO_REPO_PULLS,
  type BoardAgentRef,
  type BoardGithubRef,
  type BoardItemRef,
  type BoardPayload,
  type BoardPullReviewRef,
  type BoardTaskRef,
  type MembershipRole,
  type RepoPullsRef,
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
 *    member's. Nor whether the office has a GitHub token, nor who was asked
 *    to review what.
 * 3. GitHub being asked again is not the board changing either. A look at a
 *    pull request stamps `fetchedAt`; in the signature that stamp is kept
 *    to `BOARD_CHECKED_GRAIN_MS`, so a minute's poll that found the same
 *    facts sends nobody anything, and "checked 7m ago" catches up at most
 *    that much late. The same holds for the listing of the office's
 *    repositories' pull requests and its `fetchedAt`.
 */

/** The grain of a pull request's `fetchedAt` in the board's signature. */
export const BOARD_CHECKED_GRAIN_MS = 5 * 60_000;

export interface BoardView {
  items: readonly BoardItemRef[];
  agents: readonly BoardAgentRef[];
  tasks: readonly BoardTaskRef[];
  github: BoardGithubRef;
  pulls: RepoPullsRef;
  reviews: readonly BoardPullReviewRef[];
}

const NO_GITHUB: BoardGithubRef = { connected: false, login: null, repos: [] };

/** Agents as the board carries them: `lastSeenAt` rounded down to the grain. */
export function boardAgentsOf(agents: readonly BoardAgentRef[], grainMs = BOARD_LAST_SEEN_GRAIN_MS): BoardAgentRef[] {
  return agents.map((agent) =>
    agent.lastSeenAt === null ? agent : { ...agent, lastSeenAt: Math.floor(agent.lastSeenAt / grainMs) * grainMs },
  );
}

/**
 * The repositories' listing, as the signature reads it. It can run to
 * thousands of rows and changes only when the office lists again, while the
 * board is compared every ten seconds; so it is stringified once per listing.
 */
const pullsSignatures = new WeakMap<RepoPullsRef, { grainMs: number; signature: string }>();
function pullsSignatureOf(pulls: RepoPullsRef, grainMs: number): string {
  const known = pullsSignatures.get(pulls);
  if (known?.grainMs === grainMs) return known.signature;
  const signature = JSON.stringify({
    ...pulls,
    fetchedAt: pulls.fetchedAt === null ? null : Math.floor(pulls.fetchedAt / grainMs) * grainMs,
  });
  pullsSignatures.set(pulls, { grainMs, signature });
  return signature;
}

/** What the room compares one read with the next by. Equal means nobody is sent anything. */
export function boardSignatureOf(view: BoardView, grainMs = BOARD_CHECKED_GRAIN_MS): string {
  const tasks = view.tasks.map((task) =>
    task.github ? { ...task, github: { ...task.github, fetchedAt: Math.floor(task.github.fetchedAt / grainMs) * grainMs } } : task,
  );
  return `${JSON.stringify([view.items, view.agents, tasks, view.github, view.reviews])}\n${pullsSignatureOf(view.pulls, grainMs)}`;
}

/** The board as a person of this role is sent it. */
export function boardForRole(view: BoardView, role: MembershipRole | null): Omit<BoardPayload, 'you' | 'githubHost'> {
  if (role !== null) {
    return {
      items: [...view.items],
      agents: [...view.agents],
      tasks: [...view.tasks],
      github: { ...view.github },
      pulls: { ...view.pulls, pulls: [...view.pulls.pulls] },
      reviews: [...view.reviews],
    };
  }
  return {
    items: [...view.items],
    agents: view.agents.map((agent) => ({ ...agent, hostLabel: null, runtimeId: null, modelId: null })),
    tasks: [],
    github: { ...NO_GITHUB },
    pulls: { ...NO_REPO_PULLS },
    reviews: [],
  };
}
