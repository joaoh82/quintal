/**
 * Embed the harness's markdown as TypeScript modules, so the text ships inside
 * the compiled harness.
 *
 * Two files are product surface, edited by whoever is tuning how agents
 * behave, and should stay readable without a build: `base_prompt.md`, the
 * manners every agent is given, and `nest_agents.md`, the AGENTS.md written
 * into the shared workspace. Both stay the source. But the desktop app spawns
 * a `bun build --compile` binary, and a file the loader finds relative to
 * `import.meta.url` is not in that binary — it resolves inside bun's virtual
 * filesystem, where the markdown was never copied. Every agent the app
 * launched ran on the seven-line emergency prompt instead, and nothing said so.
 *
 * Generating a module fixes that at the root: the text becomes code, and code
 * is what the bundler carries. This runs before every build, typecheck and
 * test of the package, and the output is not committed — there is one
 * authored copy, and this is the machine-readable half of it.
 *
 *   node scripts/embed-base-prompt.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EMBEDS = [
  { source: 'base_prompt.md', out: 'src/runner/base-prompt.text.ts', name: 'BASE_PROMPT' },
  { source: 'nest_agents.md', out: 'src/nest-agents.text.ts', name: 'NEST_AGENTS_MD' },
];

for (const { source, out, name } of EMBEDS) {
  const path = join(root, source);
  let text;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch (error) {
    console.error(`embed-base-prompt: cannot read ${path}: ${error.message}`);
    process.exit(1);
  }
  if (text.length === 0) {
    // An empty prompt would compile fine and ship agents with no manners at
    // all. Refusing here keeps that from ever being a quiet failure.
    console.error(`embed-base-prompt: ${path} is empty — refusing to embed it`);
    process.exit(1);
  }

  writeFileSync(
    join(root, out),
    [
      `// Generated from ${source} by scripts/embed-base-prompt.mjs.`,
      '// Do not edit; edit the markdown and rebuild.',
      '',
      `export const ${name}: string = ${JSON.stringify(text)};`,
      '',
    ].join('\n'),
  );
}
