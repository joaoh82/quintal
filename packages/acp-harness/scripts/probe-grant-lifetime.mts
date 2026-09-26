/**
 * What a runtime's "always" option actually grants, measured rather than read.
 *
 * A button named "Always allow" says nothing about breadth or lifetime. So
 * this takes one — once, in an isolated workspace — and then asks the same
 * runtime to do four more things, watching which of them it asks about again:
 *
 *   same     the identical action. Asks again → the grant was per-call.
 *   sibling  a different action of the same kind. Asks → per-call or per-args.
 *   session  the sibling action in a fresh session, same process.
 *   restart  the sibling action after the process is restarted.
 *
 * Silence at `restart` means the grant outlived the process, which means it
 * was written somewhere — so every candidate config path is fingerprinted
 * before and after and the ones that moved are reported.
 *
 * The action matters: a runtime may offer a standing grant for edits and none
 * for shell, so `write` and `shell` are measured separately.
 *
 *   pnpm exec tsx packages/acp-harness/scripts/probe-grant-lifetime.mts <id> [modeId] [write|shell]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as schema from '@agentclientprotocol/sdk';
import { RUNTIMES, acpCommandFor } from '@quintal/shared';

import { AgentProcess } from '../src/acp/agent-process.js';

const TIMEOUT_MS = 180_000;

/** Where runtimes are known or likely to keep settings. Fingerprinted, never written. */
const CONFIG_PATHS = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude.json',
  '.omp',
  '.config/omp',
  '.codex/config.toml',
  '.config/opencode',
  '.gemini/settings.json',
];

interface Ask {
  title: string;
  options: Array<{ optionId?: string; name?: string; kind?: string }>;
}

/** A stable fingerprint of a file or directory, so "did it change?" is answerable. */
function fingerprint(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const hash = createHash('sha256');
    const walk = (dir: string, depth: number): void => {
      if (depth > 3) return;
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
          hash.update(`d:${entry.name}`);
          walk(child, depth + 1);
        } else if (entry.isFile()) {
          try {
            hash.update(`f:${entry.name}:${statSync(child).size}:${statSync(child).mtimeMs}`);
          } catch {
            // Raced with the runtime; the next line still fingerprints the rest.
          }
        }
      }
    };
    try {
      walk(path, 0);
    } catch {
      return 'unreadable';
    }
    return hash.digest('hex').slice(0, 16);
  }
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return 'unreadable';
  }
}

function snapshot(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const relative of CONFIG_PATHS) out[relative] = fingerprint(join(homedir(), relative));
  return out;
}

async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const id = process.argv[2];
const modeId = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : null;
const action = (process.argv[4] ?? 'shell') as 'write' | 'shell';
const spec = RUNTIMES.find((runtime) => runtime.id === id);
if (!spec) throw new Error(`unknown runtime: ${id}`);
const command = acpCommandFor(spec);
if (!command) throw new Error(`${id} has no ACP mode`);

const cwd = mkdtempSync(join(tmpdir(), `quin53-grant-${id}-`));
const asks: Ask[] = [];
/** Which option kind to take on the *first* ask, and once only. */
let takeAlways = true;
let taken: string | null = null;

function makeProcess(): AgentProcess {
  return new AgentProcess({
    command,
    cwd,
    onUpdate: () => {},
    onPermission: async (params: schema.RequestPermissionRequest) => {
      const options = (params.options ?? []) as Ask['options'];
      asks.push({ title: String((params.toolCall as { title?: string }).title ?? ''), options });
      if (takeAlways) {
        const always = options.find((option) => option.kind === 'allow_always');
        if (always?.optionId) {
          takeAlways = false;
          taken = `${always.optionId} (${always.name ?? ''})`;
          return { outcome: { outcome: 'selected', optionId: always.optionId } } as schema.RequestPermissionResponse;
        }
      }
      // Every later ask is refused: the question is whether it was asked at
      // all, and nothing beyond the one grant under test should ever run.
      return { outcome: { outcome: 'cancelled' } } as schema.RequestPermissionResponse;
    },
  });
}

async function step(proc: AgentProcess, sessionId: string, text: string): Promise<number> {
  const before = asks.length;
  try {
    await withTimeout(
      proc.prompt({ sessionId, prompt: [{ type: 'text', text }] } as schema.PromptRequest),
      text,
    );
  } catch {
    // A refused step still answers the question: did it ask?
  }
  return asks.length - before;
}

async function open(proc: AgentProcess): Promise<string> {
  const created = await withTimeout(
    proc.newSession({ cwd, mcpServers: [] } as schema.NewSessionRequest),
    'session/new',
  );
  if (modeId) {
    await withTimeout(
      proc.setSessionMode({ sessionId: created.sessionId, modeId } as schema.SetSessionModeRequest),
      `set_mode ${modeId}`,
    );
  }
  return created.sessionId;
}

const ACTIONS = {
  shell: (n: string) =>
    `Run the shell command \`touch ${n}\` in your working directory. Use your shell tool. Do not ask me anything first.`,
  write: (n: string) =>
    `Create a file called ${n} in your working directory containing the single word probe. Do not ask me anything first.`,
} as const;
const shell = ACTIONS[action];

const before = snapshot();
const result: Record<string, unknown> = {
  id,
  modeId,
  action,
  command,
  probedAt: new Date().toISOString(),
};
let proc = makeProcess();
try {
  await withTimeout(proc.start(), 'initialize');
  const first = await open(proc);
  result.grant = { askedOnFirst: await step(proc, first, shell('grant.txt')), optionTaken: taken };
  result.same = await step(proc, first, shell('grant.txt'));
  result.sibling = await step(proc, first, shell('sibling.txt'));
  const second = await open(proc);
  result.newSession = await step(proc, second, shell('session.txt'));
  proc.stop();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  proc = makeProcess();
  await withTimeout(proc.start(), 're-initialize');
  const third = await open(proc);
  result.afterRestart = await step(proc, third, shell('restart.txt'));
} catch (error) {
  result.error = String(error);
} finally {
  proc.stop();
  const after = snapshot();
  result.configChanged = Object.keys(before).filter((key) => before[key] !== after[key]);
  result.asks = asks.map((ask) => ({ title: ask.title, options: ask.options.map((o) => `${o.optionId}:${o.kind}`) }));
  rmSync(cwd, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
