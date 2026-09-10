/**
 * Finding the note the owner means by `!forget`.
 *
 * The owner is quoting themselves from memory — "the joke thing", "naswer
 * every answer with a joke" — not pasting the line. So there are three ways
 * to find it, tried in order, each pure so it can be tested without an agent:
 *
 * 1. **By number.** `!memory` lists the notes numbered; `!forget 2` names
 *    one. Deterministic, and the way out when nothing else agrees.
 * 2. **By the words, exactly.** The phrase as a substring of a line, case
 *    and spacing aside — what the command always did.
 * 3. **By the words, forgivingly.** Enough of the owner's words found in a
 *    line, a typo or a plural apart, and no other line that could be meant.
 *
 * What none of those settles — a paraphrase, or two lines that both fit — is
 * put to the agent's own model, with the notes numbered, and it answers with
 * numbers. The prompt for that and the reading of its answer live here too.
 */

export interface Forget {
  kept: string;
  dropped: string[];
}

/** The notes, one per line, blank lines out — in the order `!memory` numbers them. */
export function memoryLines(memory: string): string[] {
  return memory
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Memory as `!memory` says it: numbered, so `!forget 2` means something. */
export function numbered(memory: string): string {
  return memoryLines(memory)
    .map((line, index) => `${index + 1}. ${line}`)
    .join('\n');
}

/**
 * `2`, `#2`, `2, 3`, `2 and 3` → [2, 3]. Anything with a word in it is not
 * a list of numbers, and null says so — "forget the 3 rules" is words.
 */
export function parseLineNumbers(words: string): number[] | null {
  const cleaned = words.trim().replace(/#/g, '');
  if (!/^\d+(\s*(,|and|&|\s)\s*\d+)*$/i.test(cleaned)) return null;
  const numbers = [...new Set((cleaned.match(/\d+/g) ?? []).map(Number))].filter((n) => n > 0);
  return numbers.length > 0 ? numbers : null;
}

/** Drop the notes with these one-based numbers. Numbers off the end name nothing. */
export function dropNumbered(memory: string, numbers: number[]): Forget {
  const lines = memoryLines(memory);
  const drop = new Set(numbers);
  return {
    kept: lines.filter((_, index) => !drop.has(index + 1)).join('\n'),
    dropped: lines.filter((_, index) => drop.has(index + 1)),
  };
}

/** Drop these exact notes, wherever they now sit — for a pick made from an earlier listing. */
export function dropLines(memory: string, lines: string[]): Forget {
  const drop = new Set(lines.map((line) => line.trim()));
  const all = memoryLines(memory);
  return {
    kept: all.filter((line) => !drop.has(line)).join('\n'),
    dropped: all.filter((line) => drop.has(line)),
  };
}

/**
 * Which lines of a memory contain these words, exactly: a case-insensitive
 * substring match on the whole phrase, whitespace collapsed, so
 * "finish  with a joke" still finds "always finish with a joke".
 */
export function forgetLines(memory: string, words: string): Forget {
  const needle = words.trim().replace(/\s+/g, ' ').toLowerCase();
  const lines = memory.split('\n');
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const line of lines) {
    const haystack = line.replace(/\s+/g, ' ').toLowerCase();
    if (needle.length > 0 && haystack.includes(needle)) dropped.push(line.trim());
    else kept.push(line);
  }
  return { kept: kept.join('\n').trim(), dropped };
}

// --- the forgiving match ----------------------------------------------------------

/**
 * Words that say nothing about *which* note is meant. "the joke thing" is
 * about jokes; "always", "every" and "please" would match half a memory.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'as',
  'i', 'me', 'my', 'you', 'your', 'it', 'its', 'is', 'be', 'do', 'not', 'no',
  'that', 'this', 'these', 'those', 'thing', 'things', 'stuff', 'about',
  'always', 'never', 'every', 'each', 'all', 'any', 'please', 'should', 'must', 'stop',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
}

/**
 * Edit distance where a swapped pair counts as one edit — "naswer" is one
 * slip from "answer", not two. Optimal string alignment, the cheap variant.
 */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) d[i]![0] = i;
  for (let j = 0; j < cols; j += 1) d[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/** The same word, allowing a typo in a longer one or a plural on the end. */
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const tolerance = Math.max(a.length, b.length) >= 8 ? 2 : 1;
  if (editDistance(a, b) <= tolerance) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.startsWith(short) && long.length - short.length <= 3;
}

/** How much of what the owner said is in this line: 0 to 1, by content words. */
export function overlap(line: string, words: string): number {
  const want = tokens(words);
  if (want.length === 0) return 0;
  const have = tokens(line);
  const hit = want.filter((word) => have.some((other) => similar(word, other))).length;
  return hit / want.length;
}

/** This much of the owner's words found in one line, and in no other, is a match. */
export const FORGIVING_MATCH = 0.6;

export type Found =
  | ({ kind: 'exact' | 'forgiving' } & Forget)
  /** Nothing settled it: a paraphrase, or more than one line that could be meant. */
  | { kind: 'ask' }
  | { kind: 'empty' };

/** The note the owner means, if the words alone can say. */
export function findForget(memory: string, words: string): Found {
  const lines = memoryLines(memory);
  if (lines.length === 0) return { kind: 'empty' };

  const exact = forgetLines(memory, words);
  if (exact.dropped.length > 0) return { kind: 'exact', ...exact };

  const strong = lines
    .map((line, index) => ({ number: index + 1, score: overlap(line, words) }))
    .filter((entry) => entry.score >= FORGIVING_MATCH);
  if (strong.length === 1) return { kind: 'forgiving', ...dropNumbered(memory, [strong[0]!.number]) };

  return { kind: 'ask' };
}

// --- asking the model ----------------------------------------------------------

/** The one turn that decides what the words alone could not. */
export function buildForgetPrompt(memory: string, words: string): string {
  return [
    'Your owner asked you to forget one of your own notes, quoting it from memory.',
    'Their wording may differ from the note, and may contain typos.',
    '',
    `They said: "${words.trim()}"`,
    '',
    'Your notes:',
    numbered(memory),
    '',
    'Which notes say that? Answer with the numbers only, separated by commas,',
    'or the single word "none" if no note means that. A note that merely shares',
    'a word with what they said is not the one. Nothing else in your answer.',
  ].join('\n');
}

/**
 * The numbers in the model's answer, within range. "none" anywhere in it wins:
 * a model that says "none — though 2 mentions jokes" has said none.
 */
export function parseForgetAnswer(text: string, count: number): number[] {
  if (/\bnone\b/i.test(text)) return [];
  return [...new Set((text.match(/\d+/g) ?? []).map(Number))].filter((n) => n >= 1 && n <= count);
}
