/**
 * Emit the runtime catalogue as data, for the Rust host to read.
 *
 * `packages/shared/src/runtimes.ts` stays the source of truth — it is authored,
 * and the reasoning in its comments (which adapter, why not the other one, what
 * evidence the classification rests on) is the valuable part. This writes the
 * machine-readable half beside it.
 *
 * Rust needs the data rather than only a PATH probe, and the reason is the
 * spawn path: the office is a web page, so "never an arbitrary string from the
 * office" means the host must map a runtime id to a command itself. That
 * requires the catalogue on the Rust side. Generating it keeps one authored
 * copy instead of two hand-maintained ones, and CI fails if they drift — the
 * same arrangement the drizzle migrations already use.
 *
 *   node scripts/emit-runtimes.mjs
 */
import { writeFileSync } from 'node:fs';

import { RUNTIMES, acpCommandFor } from '@quintal/shared';

const catalogue = RUNTIMES.map((spec) => ({
  id: spec.id,
  label: spec.label,
  bin: spec.bin,
  // Flattened: the host cares which shape it is and what to run, not about
  // reconstructing a tagged union.
  acp: spec.acp.kind,
  command: acpCommandFor(spec),
  evidence: spec.evidence,
  install: spec.install,
}));

const out = 'packages/shared/runtimes.generated.json';
writeFileSync(
  out,
  `${JSON.stringify(
    {
      $comment:
        'Generated from packages/shared/src/runtimes.ts by scripts/emit-runtimes.mjs. Do not edit; edit the TypeScript and re-run.',
      runtimes: catalogue,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${out} (${catalogue.length} runtimes)`);
