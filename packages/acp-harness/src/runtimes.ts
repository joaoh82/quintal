import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

import { RUNTIMES, type RuntimeStatus } from '@quintal/shared';

const run = promisify(execFile);

/**
 * Which agent runtimes exist on this machine.
 *
 * Detection is deliberately shallow: does the binary resolve on PATH? We do not
 * run it, do not parse its `--help`, and do not check whether it is signed in.
 * Launching somebody's agent CLI to find out whether it exists is the kind of
 * side effect a settings page should not have, and a CLI that prompts for
 * auth on first run would hang the scan.
 *
 * Whether a runtime can *speak ACP* is a fact about the software, not about
 * this machine, so it comes from the catalogue in `@quintal/shared` rather than
 * from probing. That split is what lets the office render an honest list
 * without ever seeing your PATH.
 */
export async function detectRuntimes(): Promise<RuntimeStatus[]> {
  return Promise.all(
    RUNTIMES.map(async (spec): Promise<RuntimeStatus> => {
      const path = await which(spec.bin);
      return { id: spec.id, installed: path !== null, path };
    }),
  );
}

/**
 * Resolve a binary the way a shell would.
 *
 * `which` rather than walking PATH ourselves: it already knows about the
 * platform's rules, and getting those subtly wrong produces a runtime that is
 * installed but reported missing — the most confusing possible answer.
 */
async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', [bin], {
      timeout: 3_000,
    });
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first?.trim() ?? null;
  } catch {
    // Non-zero exit means "not found", which is an answer, not a failure.
    return null;
  }
}

/** This machine's name, for telling a laptop from a build box. */
export function hostLabel(): string {
  return hostname().replace(/\.local$/, '');
}
