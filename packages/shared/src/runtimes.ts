/**
 * The agent runtimes Quintal knows how to drive.
 *
 * This lives in shared because three things need it and they must not drift:
 * the harness (which spawns them), the settings page (which lists them), and
 * the docs. It is deliberately *data* — a CLI that gains ACP support later is a
 * one-line change here, not a code change anywhere.
 *
 * ## What "supported" actually means
 *
 * ACP is JSON-RPC over stdio: Quintal is the client, and it spawns a
 * subprocess that speaks the protocol. Nothing is installed *into* your agent
 * CLI and nothing is registered anywhere. All Quintal needs from your machine
 * is the CLI itself, installed and signed in. Two ways that works:
 *
 * - **native** — the CLI has an ACP mode of its own (a subcommand or flag).
 * - **adapter** — it doesn't, so a published wrapper process speaks ACP on its
 *   behalf. Fetched by `npx` on demand; still nothing to install.
 *
 * And one way it doesn't:
 *
 * - **none** — the CLI has no ACP surface at all. Listing these is the point:
 *   "we don't support it" and "you can't have it" are different answers, and a
 *   runtime you can see marked unsupported beats one that silently isn't there.
 *
 * Every classification was verified against the CLI itself, not against its
 * documentation. Each carries the evidence and the date it was checked, so a
 * wrong entry can be argued with rather than guessed at.
 */

export type AcpSupport =
  | { kind: 'native'; args: string[] }
  | { kind: 'adapter'; package: string }
  | { kind: 'none' };

export interface RuntimeSpec {
  /** Stable id, used in fleet files and on the wire. */
  id: string;
  label: string;
  /** What to look for on PATH. */
  bin: string;
  acp: AcpSupport;
  /** How the classification was made, shown in the UI. */
  evidence: string;
  /** How to get it, for a runtime that isn't installed. */
  install: string;
}

export const RUNTIMES: readonly RuntimeSpec[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    bin: 'claude',
    // Not `@zed-industries/claude-code-acp`: deprecated in favour of this one,
    // and the old build refuses to start when it detects it is inside another
    // Claude Code session — exactly what happens if you boot a fleet from one.
    acp: { kind: 'adapter', package: '@agentclientprotocol/claude-agent-acp' },
    evidence: 'Adapter published by the ACP maintainers; verified end to end.',
    install: 'npm i -g @anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    acp: { kind: 'adapter', package: '@agentclientprotocol/codex-acp' },
    evidence: 'Adapter published by the ACP maintainers.',
    install: 'npm i -g @openai/codex',
  },
  {
    id: 'goose',
    label: 'Goose',
    bin: 'goose',
    acp: { kind: 'native', args: ['acp'] },
    evidence: 'Ships an `acp` subcommand.',
    install: 'https://block.github.io/goose/docs/getting-started/installation',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    acp: { kind: 'native', args: ['--experimental-acp'] },
    evidence: '`--experimental-acp` starts the agent in ACP mode.',
    install: 'npm i -g @google/gemini-cli',
  },
  {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    acp: { kind: 'native', args: ['acp'] },
    evidence: 'Ships an `acp` subcommand.',
    install: 'https://opencode.ai',
  },
  {
    id: 'omp',
    label: 'Oh My Pi',
    bin: 'omp',
    acp: { kind: 'native', args: ['acp'] },
    evidence:
      'Ships an `acp` subcommand. Answered an ACP `initialize` over stdio as `oh-my-pi` v18.0.3, protocol 1. Verified 2026-08-24.',
    install: 'https://omp.sh',
  },
  {
    id: 'grok',
    label: 'Grok Build',
    bin: 'grok',
    acp: { kind: 'none' },
    evidence:
      'Emits ACP-shaped session updates as output, but exposes no ACP server mode — nothing accepts requests on stdin. Verified 2026-08-07.',
    install: 'https://grok.com',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    bin: 'cursor-agent',
    acp: { kind: 'none' },
    evidence: 'No ACP subcommand or flag; headless mode speaks its own stream-JSON. Verified 2026-08-07.',
    install: 'https://cursor.com/cli',
  },
] as const;

export function runtimeById(id: string): RuntimeSpec | undefined {
  return RUNTIMES.find((runtime) => runtime.id === id);
}

/**
 * The command that speaks ACP for this runtime, or null when none can.
 *
 * `null` is a real answer, not a failure to compute one — see the `none` note
 * above.
 */
export function acpCommandFor(spec: RuntimeSpec): string[] | null {
  switch (spec.acp.kind) {
    case 'native':
      return [spec.bin, ...spec.acp.args];
    case 'adapter':
      return ['npx', '-y', spec.acp.package];
    case 'none':
      return null;
  }
}

// --- what a machine reports back ---------------------------------------------

/** One model a runtime offered, as it named it. */
export interface RuntimeModelChoice {
  id: string;
  label: string;
}

/**
 * What a runtime said about models when asked, over ACP.
 *
 * Probed by the harness — spawn the runtime, open a session, read the
 * `configOptions` it advertises with `category: "model"`, close it — because
 * the office cannot see the runtime and a hosted Quintal never will. The
 * choices are the runtime's own words; the picker offers those and nothing
 * else.
 */
export interface RuntimeModels {
  /** The config option's id, needed to set it later. */
  configId: string;
  /** The runtime's default, when it said. */
  current: string | null;
  choices: RuntimeModelChoice[];
}

/** One runtime as found on somebody's machine. */
export interface RuntimeStatus {
  id: string;
  /** Was the binary on PATH? */
  installed: boolean;
  /** Where it was found. Null when it wasn't. */
  path: string | null;
  /**
   * The models it offers. Absent: never asked (an older harness, or a runtime
   * that is not installed). Null: asked, and it offers no choice.
   */
  models?: RuntimeModels | null;
}

/**
 * A machine that can host agents.
 *
 * Reported by the harness rather than discovered by the office, because the
 * office cannot see your PATH — and a hosted Quintal never will. This is the
 * one direction the information can travel.
 */
export interface HostReport {
  /** Hostname, for telling two machines apart. */
  label: string;
  /** Where this machine keeps its repositories. */
  reposDir: string;
  /**
   * Undefined and empty mean different things.
   *
   * Only the first agent of a fleet scans PATH — the answer is per machine, not
   * per agent — so the rest omit the list entirely. Undefined is "I am not the
   * one who reports this, leave what you have"; an empty array is "I looked and
   * found nothing", which is a real answer and must overwrite.
   */
  runtimes?: RuntimeStatus[];
}

/** Ready to use: installed *and* able to speak the protocol. */
export function isUsable(status: RuntimeStatus): boolean {
  const spec = runtimeById(status.id);
  return status.installed && spec !== undefined && spec.acp.kind !== 'none';
}

/** Bound what a key holder can write into an owner's settings page. */
export const HOST_REPORT_LIMITS = {
  labelMaxLength: 64,
  reposDirMaxLength: 512,
  maxRuntimes: 32,
  pathMaxLength: 512,
  maxModels: 64,
  modelIdMaxLength: 128,
  modelLabelMaxLength: 128,
} as const;

/** Bring a reported model list into bounds, or say there is none. */
function normaliseModels(raw: unknown): RuntimeModels | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object') return null;
  const input = raw as Partial<RuntimeModels>;
  const configId = String(input.configId ?? '').slice(0, HOST_REPORT_LIMITS.modelIdMaxLength);
  if (configId.length === 0 || !Array.isArray(input.choices)) return null;

  const seen = new Set<string>();
  const choices: RuntimeModelChoice[] = [];
  for (const entry of input.choices) {
    if (choices.length >= HOST_REPORT_LIMITS.maxModels) break;
    const id = String((entry as RuntimeModelChoice)?.id ?? '')
      .trim()
      .slice(0, HOST_REPORT_LIMITS.modelIdMaxLength);
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const label = String((entry as RuntimeModelChoice)?.label ?? '')
      .trim()
      .slice(0, HOST_REPORT_LIMITS.modelLabelMaxLength);
    choices.push({ id, label: label.length > 0 ? label : id });
  }
  if (choices.length === 0) return null;

  const current =
    typeof input.current === 'string' && seen.has(input.current) ? input.current : null;
  return { configId, current, choices };
}

/** The choice a runtime offers under this id, if it does. */
export function modelChoice(
  status: RuntimeStatus | undefined,
  modelId: string,
): RuntimeModelChoice | null {
  return status?.models?.choices.find((choice) => choice.id === modelId) ?? null;
}

/**
 * Coerce a report from the wire into something safe to store and render.
 *
 * An agent key is a credential a person pastes into a config file; treating
 * what it sends as trusted input would make "your fleet can write anything into
 * your settings page" true. Unknown runtime ids are dropped rather than stored,
 * so the UI only ever renders things from the catalogue above.
 */
export function normaliseHostReport(raw: unknown): HostReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const input = raw as Partial<HostReport>;

  const label = String(input.label ?? '').trim().slice(0, HOST_REPORT_LIMITS.labelMaxLength);
  if (label.length === 0) return null;

  if (!Array.isArray(input.runtimes)) {
    return {
      label,
      reposDir: String(input.reposDir ?? '')
        .trim()
        .slice(0, HOST_REPORT_LIMITS.reposDirMaxLength),
    };
  }

  const seen = new Set<string>();
  const runtimes: RuntimeStatus[] = [];
  for (const entry of input.runtimes) {
    if (runtimes.length >= HOST_REPORT_LIMITS.maxRuntimes) break;
    const id = String((entry as RuntimeStatus)?.id ?? '');
    if (!runtimeById(id) || seen.has(id)) continue;
    seen.add(id);
    const path = (entry as RuntimeStatus)?.path;
    const models = normaliseModels((entry as RuntimeStatus)?.models);
    runtimes.push({
      id,
      installed: Boolean((entry as RuntimeStatus)?.installed),
      path: typeof path === 'string' ? path.slice(0, HOST_REPORT_LIMITS.pathMaxLength) : null,
      ...(models !== undefined ? { models } : {}),
    });
  }

  return {
    label,
    reposDir: String(input.reposDir ?? '')
      .trim()
      .slice(0, HOST_REPORT_LIMITS.reposDirMaxLength),
    runtimes,
  };
}
