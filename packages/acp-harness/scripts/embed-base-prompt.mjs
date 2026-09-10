/**
 * Embed `base_prompt.md` as a TypeScript module, so the prompt ships inside
 * the compiled harness.
 *
 * `base_prompt.md` stays the source: it is product surface, edited by whoever
 * is tuning how agents behave, and it should stay readable without a build.
 * But the desktop app spawns a `bun build --compile` binary, and a file the
 * loader finds relative to `import.meta.url` is not in that binary — it
 * resolves inside bun's virtual filesystem, where the markdown was never
 * copied. Every agent the app launched ran on the seven-line emergency prompt
 * instead, and nothing said so.
 *
 * Generating a module fixes that at the root: the text becomes code, and
 * code is what the bundler carries. This runs before every build, typecheck
 * and test of the package, and the output is not committed — there is one
 * authored copy, and this is the machine-readable half of it.
 *
 *   node scripts/embed-base-prompt.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'base_prompt.md');
const out = join(root, 'src/runner/base-prompt.text.ts');

let text;
try {
  text = readFileSync(source, 'utf8').trim();
} catch (error) {
  console.error(`embed-base-prompt: cannot read ${source}: ${error.message}`);
  process.exit(1);
}
if (text.length === 0) {
  // An empty prompt would compile fine and ship agents with no manners at
  // all. Refusing here keeps that from ever being a quiet failure.
  console.error(`embed-base-prompt: ${source} is empty — refusing to embed it`);
  process.exit(1);
}

writeFileSync(
  out,
  [
    '// Generated from base_prompt.md by scripts/embed-base-prompt.mjs.',
    '// Do not edit; edit the markdown and rebuild.',
    '',
    `export const BASE_PROMPT: string = ${JSON.stringify(text)};`,
    '',
  ].join('\n'),
);
