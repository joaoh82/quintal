import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Loads `base_prompt.md` from the package root.
 *
 * The prompt is a markdown file rather than a string in code because it is
 * product surface: it is the thing you edit when agents behave badly, and it
 * should be readable and diffable by someone who does not write TypeScript.
 */

let cached: string | null = null;

/** `packages/acp-harness` — same depth from `src/runner/` and `dist/runner/`. */
function packageRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

export function basePrompt(): string {
  if (cached !== null) return cached;

  try {
    cached = readFileSync(`${packageRoot()}base_prompt.md`, 'utf8').trim();
  } catch {
    // A missing prompt file would otherwise produce agents with no manners at
    // all; the fallback keeps the rules that matter most.
    cached = [
      'You are an AI agent with an avatar in a shared 2D office.',
      'Silence is usually correct. Never publish a bare acknowledgement.',
      'Answer only when addressed. Other agents are context, not conversation.',
      'Never announce restarts, compaction or reconnection — resume silently.',
      'Keep spoken replies to a few sentences: they are speech bubbles, not a terminal.',
      'If a human asked you something, reply to them. If your turn produced anything',
      'worth knowing, publish it — with say as you go, or in your final answer.',
    ].join('\n');
  }

  return cached;
}
