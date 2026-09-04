import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as schema from '@agentclientprotocol/sdk';
import type { RuntimeModels } from '@quintal/shared';

import { AgentProcess } from './acp/agent-process.js';

/**
 * Which model an agent runs, decided the way ACP decides it.
 *
 * An agent advertises what it can be configured with when a session opens —
 * `configOptions`, each with a category — and the client picks from that
 * list with `session/set_config_option`. The model is one such option. So
 * the office never passes a model *in*: it reads what the runtime offers,
 * shows those, and the harness sets the one chosen. Nothing here ever
 * becomes a command-line argument, which is the whole reason this route was
 * taken over `--model`: step 0.7 says a spawn is built from the catalogue and
 * never from a string the office sent.
 *
 * Adapters disagree on details. The spec says `configId`; claude-agent-acp
 * has shipped `id`. Options are flat or grouped. Every reader here accepts
 * both and the set request always says `configId`, as the spec does.
 */

interface RawOption {
  configId?: unknown;
  id?: unknown;
  category?: unknown;
  type?: unknown;
  currentValue?: unknown;
  options?: unknown;
}

interface RawChoice {
  value?: unknown;
  name?: unknown;
  options?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Flatten `[choice, choice]` or `[{ name, options: [choice] }]` into choices. */
function choicesOf(options: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(options)) return [];
  const out: Array<{ id: string; label: string }> = [];
  for (const entry of options as RawChoice[]) {
    if (entry && Array.isArray(entry.options)) {
      out.push(...choicesOf(entry.options));
      continue;
    }
    const id = asString(entry?.value);
    if (id === null) continue;
    out.push({ id, label: asString(entry?.name) ?? id });
  }
  return out;
}

/** The model option among a session's config options, if it offers one. */
export function modelOption(configOptions: unknown): RuntimeModels | null {
  if (!Array.isArray(configOptions)) return null;
  for (const option of configOptions as RawOption[]) {
    if (option?.category !== 'model') continue;
    const configId = asString(option.configId) ?? asString(option.id);
    if (configId === null) continue;
    const choices = choicesOf(option.options);
    if (choices.length === 0) continue;
    const current = asString(option.currentValue);
    return {
      configId,
      current: current !== null && choices.some((c) => c.id === current) ? current : null,
      choices,
    };
  }
  return null;
}

/**
 * What to send to select `modelId`, or null when the agent did not offer it.
 *
 * Null is a refusal the caller has to act on, not a fallback: an agent quietly
 * running on a model other than the one its card names is worse than one
 * that says it cannot.
 */
export function pickModel(
  configOptions: unknown,
  modelId: string,
): { configId: string; value: string } | null {
  const offered = modelOption(configOptions);
  if (!offered) return null;
  return offered.choices.some((choice) => choice.id === modelId)
    ? { configId: offered.configId, value: modelId }
    : null;
}

/** How long a runtime gets to start, open a session, and say what it offers. */
export const PROBE_TIMEOUT_MS = 25_000;

/**
 * Ask a runtime which models it offers, by opening and closing one session.
 *
 * Spawned in an empty directory so it has nothing to read, given no tools,
 * and asked nothing — the session is opened for its `configOptions` and
 * dropped. Best-effort: a runtime that hangs, crashes, or answers without a
 * model option is reported as "no choice", which is true as far as the
 * office is concerned.
 */
export async function probeModels(command: string[]): Promise<RuntimeModels | null> {
  const cwd = mkdtempSync(join(tmpdir(), 'quintal-probe-'));
  const proc = new AgentProcess({
    command,
    cwd,
    onUpdate: () => {},
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  });

  const attempt = (async () => {
    await proc.start();
    const session = await proc.newSession({ cwd, mcpServers: [] } as schema.NewSessionRequest);
    return modelOption((session as { configOptions?: unknown }).configOptions);
  })();

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([attempt, deadline]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    proc.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
}
