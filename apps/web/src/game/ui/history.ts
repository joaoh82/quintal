/**
 * The lines you sent, for Up and Down in the chat input — a shell's history,
 * because retyping `!review @claude` for the fourth time is not an interface.
 *
 * Pure on purpose: the input keeps the list and where you are in it, and these
 * say what the next line is.
 */

/** Enough to scroll back through a session; not a transcript. */
export const HISTORY_LIMIT = 100;

/** Where Up and Down have taken you. */
export interface Recall {
  /** Index into the history, or null while you are typing your own line. */
  index: number | null;
  /** What you were typing before the first Up, for Down to give back. */
  stash: string;
}

export const NOT_RECALLING: Recall = { index: null, stash: '' };

/** The history with `text` added, unless it repeats the line before it. */
export function remember(history: readonly string[], text: string): string[] {
  if (text.length === 0 || history[history.length - 1] === text) return [...history];
  return [...history, text].slice(-HISTORY_LIMIT);
}

/**
 * One step through the history: `older` is Up, otherwise Down. Null when there
 * is nowhere to go, so the key does nothing rather than clearing the line.
 */
export function step(
  history: readonly string[],
  recall: Recall,
  draft: string,
  older: boolean,
): { recall: Recall; text: string } | null {
  if (older) {
    if (recall.index === null) {
      const last = history.length - 1;
      if (last < 0) return null;
      return { recall: { index: last, stash: draft }, text: history[last] ?? '' };
    }
    if (recall.index === 0) return null;
    const index = recall.index - 1;
    return { recall: { ...recall, index }, text: history[index] ?? '' };
  }

  if (recall.index === null) return null;
  // Past the newest line is the one you were writing.
  if (recall.index >= history.length - 1) return { recall: NOT_RECALLING, text: recall.stash };
  const index = recall.index + 1;
  return { recall: { ...recall, index }, text: history[index] ?? '' };
}
