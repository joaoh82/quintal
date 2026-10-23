import type * as schema from '@agentclientprotocol/sdk';
import { openMcpSecret, type AgentMcpServer, type McpVar } from '@quintal/shared';

/**
 * The owner's MCP servers, turned into what ACP hands a runtime.
 *
 * Defined in the office (see `@quintal/shared` `mcp.ts`); resolved here, on
 * the machine, because only here is the agent's secret key — the one thing
 * that opens a sealed value — and only here is it known what the runtime can
 * take. Every server that is left out is left out with a reason, so the log
 * and the agent's own `workspace_info` can say why Slack is not there rather
 * than leaving it missing.
 */

export interface ResolvedMcpServers {
  servers: schema.McpServer[];
  skipped: Array<{ name: string; reason: string }>;
}

export interface ResolveOptions {
  /** The agent's own key, or null for an agent that joins without one. */
  secretKey: Uint8Array | null;
  /** The office granted `run`: starting a program on this machine is allowed. */
  mayRun: boolean;
  /** The runtime said at `initialize` that it takes MCP over HTTP. */
  http: boolean;
}

export async function resolveMcpServers(
  defined: readonly AgentMcpServer[],
  options: ResolveOptions,
): Promise<ResolvedMcpServers> {
  const servers: schema.McpServer[] = [];
  const skipped: ResolvedMcpServers['skipped'] = [];

  for (const server of defined) {
    try {
      if (server.transport === 'http') {
        if (!options.http) {
          skipped.push({ name: server.name, reason: 'this runtime does not take MCP servers over HTTP' });
          continue;
        }
        servers.push({
          type: 'http',
          name: server.name,
          url: server.url ?? '',
          headers: await openVars(server.headers, options.secretKey),
        } as schema.McpServer);
        continue;
      }
      // Starting a stdio server is running a program on this machine — with
      // no approval card, because the runtime starts it before any turn. That
      // is exactly the authority `run` grants and nothing less does.
      if (!options.mayRun) {
        skipped.push({ name: server.name, reason: 'a local server runs a program here, which needs the "run" scope' });
        continue;
      }
      servers.push({
        name: server.name,
        command: server.command ?? '',
        args: server.args ?? [],
        env: await openVars(server.env, options.secretKey),
      } as schema.McpServer);
    } catch (error: unknown) {
      skipped.push({ name: server.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { servers, skipped };
}

async function openVars(
  vars: readonly McpVar[] | undefined,
  secretKey: Uint8Array | null,
): Promise<Array<{ name: string; value: string }>> {
  const opened: Array<{ name: string; value: string }> = [];
  for (const entry of vars ?? []) {
    if (entry.sealed === undefined) {
      opened.push({ name: entry.name, value: entry.value ?? '' });
      continue;
    }
    if (!secretKey) throw new Error(`"${entry.name}" is sealed, and this agent has no key of its own to open it`);
    try {
      opened.push({ name: entry.name, value: await openMcpSecret(secretKey, entry.name, entry.sealed) });
    } catch {
      // Sealed to another key — the agent's key was replaced since — or not
      // for this variable. Either way the owner has to enter it again.
      throw new Error(`"${entry.name}" was sealed to a different key; enter it again on the agent's settings page`);
    }
  }
  return opened;
}

// --- reading the runtime's own `/mcp` ---------------------------------------

export type McpListingGroup = 'failed' | 'needs-auth' | 'pending' | 'connected' | 'disabled';

const GROUP_TITLES: Record<string, McpListingGroup> = {
  failed: 'failed',
  'needs authentication': 'needs-auth',
  connecting: 'pending',
  connected: 'connected',
  disabled: 'disabled',
};

/**
 * What claude-agent-acp's `/mcp` says, server by server.
 *
 * Markdown meant for a person, so read loosely: a `**Group**` line opens a
 * group, a ``- `name`: detail`` line is a server in it, and anything else is
 * ignored. A runtime that words it differently yields an empty map, which
 * the caller reads as "nothing to do" — never as a reason to act.
 */
export function parseMcpListing(text: string): Map<string, { group: McpListingGroup; detail?: string }> {
  const servers = new Map<string, { group: McpListingGroup; detail?: string }>();
  let group: McpListingGroup | null = null;
  for (const line of text.split('\n')) {
    const heading = /^\s*\*\*([^*]+)\*\*\s*$/.exec(line);
    if (heading) {
      group = GROUP_TITLES[heading[1]!.trim().toLowerCase()] ?? null;
      continue;
    }
    const entry = /^\s*-\s+`([^`]+)`(?::\s*(.+))?\s*$/.exec(line);
    if (entry && group) {
      servers.set(entry[1]!, { group, ...(entry[2] ? { detail: entry[2].trim() } : {}) });
    }
  }
  return servers;
}

/** ``- Couldn't reconnect `slack`: why`` lines from `/mcp reconnect`. */
export function parseReconnectFailures(text: string): Map<string, string> {
  const failures = new Map<string, string>();
  for (const match of text.matchAll(/Couldn't reconnect `([^`]+)`:\s*(.+)/g)) {
    failures.set(match[1]!, match[2]!.trim());
  }
  return failures;
}
