import { CHOSEN_EMOTES } from '@quintal/shared';
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
      'in tiles. Also lists every zone in the office, which is where move_to can ' +
      'take you. Call this before answering questions about who is present or ' +
      'where you are — your pushed context deliberately does not include it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'move_to',
    description:
      'Walk somewhere. Name either a person or a zone. ' +
      'Use `person` when somebody asks you to come to them — "come here", ' +
      '"can you join me" — and you will stop beside them wherever they are, ' +
      'in a room or not. Use `zone` for a place: its id or human label ' +
      '("focus", "Focus Room"); call look_around if you are unsure which ' +
      'exist. You walk at human speed along a real path and arrive seconds ' +
      'later, so this returns before you get there; it is a request to walk, ' +
      'not teleportation. Do not wander on your own.',
    inputSchema: {
      type: 'object',
      properties: {
        person: {
          type: 'string',
          description:
            'Somebody in the office, by the name you see them under. You stop ' +
            'next to them; you do not need to know where they are.',
        },
        zone: { type: 'string', description: 'Zone id or human label.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_status',
    description:
      'Set the short line under your nameplate — how the room sees what you are ' +
      'doing without interrupting you. Keep it under 60 characters and in the ' +
      'present tense: "reading auth.ts", "waiting for review". Pass an empty ' +
      'string when you go idle. This is not chat: nobody is notified.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
      required: ['status'],
      additionalProperties: false,
    },
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
      'Read what was said. "nearby" is what you could hear from where you stand; ' +
      '"zone" is a zone\'s transcript (yours, or any zone by id from look_around); ' +
      '"channel" is a channel you are a member of (by name, e.g. "engineering"); ' +
      '"mentions" is every message that addressed you by name, wherever it was said. ' +
      'History is kept across restarts. Use this when someone refers to something ' +
      'said before you were asked, rather than guessing; pass "before" (the sentAt ' +
      'of the oldest message you have) to page further back.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['nearby', 'zone', 'channel', 'mentions'],
          default: 'nearby',
        },
        zone: { type: 'string', description: 'With scope "zone": a zone id.' },
        channel: {
          type: 'string',
          description: 'With scope "channel": the channel, by name (without the #) or id.',
        },
        n: { type: 'number', minimum: 1, maximum: 50, default: 20 },
        before: { type: 'number', description: 'Only messages sent before this time (ms).' },
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
  {
    name: 'emote',
    description:
      'Put a small balloon over your head for a few seconds — a reaction to ' +
      'something said to you: laugh at a joke, look sad at an insult, a heart ' +
      'for thanks. Sparingly, and only in reaction; never as decoration. Your ' +
      'thinking and working balloons are shown for you.',
    inputSchema: {
      type: 'object',
      properties: {
        emote: { type: 'string', enum: [...CHOSEN_EMOTES] },
      },
      required: ['emote'],
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
