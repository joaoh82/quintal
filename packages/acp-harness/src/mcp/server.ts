import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * `quintal-tools` — the MCP server the agent's harness spawns.
 *
 * These tools are the agent's senses. Everything an agent knows about the room
 * beyond the small envelope pushed with its prompt, it learns by calling one of
 * these — which is the whole point of the pull-first design: context costs
 * tokens only when it's actually wanted.
 *
 * This process holds no credentials and no socket to the office. It forwards to
 * the harness over loopback (see `bridge.ts`), which is what keeps a single
 * agent identity attached to a single connection.
 */

const BRIDGE_URL = process.env.QUINTAL_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.QUINTAL_BRIDGE_TOKEN;

interface BridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

async function callBridge(tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    throw new Error('quintal-tools was started outside a harness (no bridge configured)');
  }

  const response = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quintal-token': BRIDGE_TOKEN },
    body: JSON.stringify({ tool, args }),
  });

  if (!response.ok) throw new Error(`bridge refused the call (${response.status})`);

  const payload = (await response.json()) as BridgeResponse;
  if (!payload.ok) throw new Error(payload.error ?? 'tool failed');
  return payload.result;
}

const TOOLS = [
  {
    name: 'look_around',
    description:
      'Look at the room you are standing in: which zone you are in, your tile, ' +
      'and everyone nearby with their kind (human or agent), status and distance ' +
      'in tiles. Call this before answering questions about who is present or ' +
      'where you are — your pushed context deliberately does not include it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'who_is_here',
    description:
      'Just the occupants near you, without your own position. Cheaper to read ' +
      'when all you need is who you are talking to.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'messages_get',
    description:
      'Recent messages you could legitimately have heard: "nearby" (within ' +
      'earshot) or "zone" (everyone in your current zone). Use this when someone ' +
      'refers to something said before you were asked, rather than guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['nearby', 'zone'], default: 'nearby' },
        n: { type: 'number', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_get',
    description:
      'Read one of your memory slugs. "core" holds your identity, standing ' +
      'instructions and current focus; other slugs hold cold detail you filed away.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', default: 'core' } },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_set',
    description:
      'Write one of your memory slugs. Keep "core" under 8KB — it is loaded on ' +
      'every session, so it costs tokens forever. Move finished work out to ' +
      'named slugs like "mem/auth-refactor". Never store conversation transcripts.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['slug', 'content'],
      additionalProperties: false,
    },
  },
] as const;

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'quintal-tools', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOLS] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await callBridge(request.params.name, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 1) }] };
    } catch (error: unknown) {
      return {
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : 'tool failed',
          },
        ],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
}
