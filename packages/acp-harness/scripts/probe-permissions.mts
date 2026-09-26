/**
 * What each installed runtime actually asks, and what its answers mean.
 *
 * QUIN-53 exists because the office labelled a standing grant without knowing
 * what one grants. The only honest way to fix that is to go and look: spawn
 * every ACP-capable runtime this machine has, open a session, ask it to touch
 * a file, and write down the `session/request_permission` payload verbatim —
 * option ids, the names it shows a human, and the ACP `kind` behind each.
 *
 * Nothing here interprets. Every request is answered `cancelled`, so no tool
 * runs and no grant is created; the output is evidence, and the catalogue in
 * `@quintal/shared` is written from it by hand with a date against each entry.
 *
 *   pnpm exec tsx packages/acp-harness/scripts/probe-permissions.mts [id...]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as schema from '@agentclientprotocol/sdk';
import { RUNTIMES, acpCommandFor } from '@quintal/shared';

import { AgentProcess } from '../src/acp/agent-process.js';

/** A change and a command: "ask before changes" and "ask before shell" differ. */
const PROMPTS = {
  write: (name: string) =>
    `Create a file called ${name} in your working directory containing the single word probe. Do not ask me anything first.`,
  shell: (name: string) =>
    `Run the shell command \`touch ${name}\` in your working directory. Use your shell tool, not a file-writing tool. Do not ask me anything first.`,
  // Some runtimes only gate what leaves the workspace: Codex's "Ask for
  // approval" mode asks about *external* files and says so in its own
  // description. A probe confined to the cwd would report "never asks".
  outside: (name: string) =>
    `Create a file at ${OUTSIDE_DIR}/${name} containing the single word probe. That path is outside your working directory. Do not ask me anything first.`,
} as const;

/** Somewhere outside every probe workspace, for the `outside` action. */
const OUTSIDE_DIR = mkdtempSync(join(tmpdir(), 'quin53-outside-'));

/** How long one runtime gets before we give up on it and move on. */
const TIMEOUT_MS = 120_000;

interface SeenRequest {
  toolCall: { title?: string; kind?: string; toolCallId?: string };
  options: Array<{ optionId?: string; name?: string; kind?: string }>;
}

interface ModeProbe {
  modeId: string | null;
  /** `write` or `shell` — the two shapes a runtime may treat differently. */
  action: keyof typeof PROMPTS;
  setModeError?: string;
  requests: SeenRequest[];
  promptError?: string;
  stopReason?: string;
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

async function probe(id: string): Promise<unknown> {
  const spec = RUNTIMES.find((runtime) => runtime.id === id);
  if (!spec) return { id, error: 'unknown runtime id' };
  const command = acpCommandFor(spec);
  if (!command) return { id, acp: 'none', evidence: spec.evidence };

  const requests: SeenRequest[] = [];
  const stderr: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), `quin53-${id}-`));
  const proc = new AgentProcess({
    command,
    cwd,
    onUpdate: () => {},
    onStderr: (line) => {
      if (stderr.length < 20) stderr.push(line);
    },
    // Answer every ask with `cancelled`: a refusal every ACP agent must
    // accept, and the one answer that cannot create a grant anywhere.
    onPermission: async (params: schema.RequestPermissionRequest) => {
      const call = params.toolCall as SeenRequest['toolCall'];
      requests.push({
        toolCall: { title: call?.title, kind: call?.kind, toolCallId: call?.toolCallId },
        options: (params.options ?? []) as SeenRequest['options'],
      });
      return { outcome: { outcome: 'cancelled' } } as schema.RequestPermissionResponse;
    },
  });

  const out: Record<string, unknown> = { id, command, probedAt: new Date().toISOString() };
  const probes: ModeProbe[] = [];
  try {
    const initialize = await withTimeout(proc.start(), `${id} initialize`);
    out.protocolVersion = initialize.protocolVersion;
    out.agent = (initialize as { agentInfo?: unknown }).agentInfo ?? null;

    const first = await withTimeout(
      proc.newSession({ cwd, mcpServers: [] } as schema.NewSessionRequest),
      `${id} session/new`,
    );
    const modes = (first as { modes?: { currentModeId?: string; availableModes?: unknown } }).modes;
    out.modes = modes ?? null;

    // The mode it opens in, then every other mode it offers: which one asks
    // is exactly the fact the office has been guessing at.
    const available = Array.isArray(modes?.availableModes)
      ? (modes.availableModes as Array<{ id?: string; name?: string }>)
      : [];
    const order: Array<string | null> = [modes?.currentModeId ?? null];
    for (const mode of available) {
      if (mode.id && !order.includes(mode.id)) order.push(mode.id);
    }

    let probeIndex = 0;
    for (const modeId of order) {
      for (const action of ['write', 'shell', 'outside'] as const) {
        probeIndex += 1;
        const entry: ModeProbe = { modeId, action, requests: [] };
        // A fresh session and a fresh target each time. Reusing either lets a
        // runtime answer "already done" and look as though it never asks.
        let sessionId: string;
        try {
          const created =
            probeIndex === 1
              ? first
              : await withTimeout(
                  proc.newSession({ cwd, mcpServers: [] } as schema.NewSessionRequest),
                  `${id} session/new #${probeIndex}`,
                );
          sessionId = created.sessionId;
        } catch (error) {
          entry.promptError = String(error);
          probes.push(entry);
          continue;
        }
        if (modeId && modeId !== modes?.currentModeId) {
          try {
            await withTimeout(
              proc.setSessionMode({ sessionId, modeId } as schema.SetSessionModeRequest),
              `${id} set_mode ${modeId}`,
            );
          } catch (error) {
            entry.setModeError = String(error);
            probes.push(entry);
            continue;
          }
        }
        const before = requests.length;
        try {
          const result = await withTimeout(
            proc.prompt({
              sessionId,
              prompt: [{ type: 'text', text: PROMPTS[action](`probe-${probeIndex}.txt`) }],
            } as schema.PromptRequest),
            `${id} ${action} in ${modeId ?? 'default'}`,
          );
          entry.stopReason = (result as { stopReason?: string }).stopReason;
        } catch (error) {
          entry.promptError = String(error);
        }
        entry.requests = requests.slice(before);
        probes.push(entry);
      }
    }
  } catch (error) {
    out.error = String(error);
    if (stderr.length > 0) out.stderr = stderr;
  } finally {
    out.probes = probes;
    proc.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
  return out;
}

const wanted = process.argv.slice(2);
const ids = wanted.length > 0 ? wanted : RUNTIMES.map((runtime) => runtime.id);
const report: unknown[] = [];
for (const id of ids) {
  process.stderr.write(`probing ${id}…\n`);
  report.push(await probe(id));
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
