#!/usr/bin/env node
/**
 * A scripted ACP agent, for testing the harness without burning tokens.
 *
 * Speaks the real wire protocol — newline-delimited JSON-RPC 2.0 over stdio —
 * so the harness cannot tell it apart from Claude Code or Goose. Its behaviour
 * is driven by env vars so a test can ask for the exact shape it needs:
 *
 *   FAKE_REPLY          text streamed back as agent_message_chunk (default "ok")
 *   FAKE_STOP_REASON    end_turn | max_tokens | refusal | cancelled
 *   FAKE_TOOL           emit a tool_call with this name before replying
 *   FAKE_PERMISSION     ask for permission before replying (value = tool name)
 *   FAKE_CRASH_AFTER    exit(1) after this many prompts
 *   FAKE_CHUNKS         split the reply into N chunks (default 1)
 *   FAKE_RECORD         append every received request to this file as JSONL
 *   FAKE_DELAY_MS       pause this long mid-turn, so a status line is observable
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const reply = process.env.FAKE_REPLY ?? 'ok';
const stopReason = process.env.FAKE_STOP_REASON ?? 'end_turn';
const tool = process.env.FAKE_TOOL;
const permission = process.env.FAKE_PERMISSION;
const crashAfter = process.env.FAKE_CRASH_AFTER
  ? Number(process.env.FAKE_CRASH_AFTER)
  : Number.POSITIVE_INFINITY;
const chunks = Number(process.env.FAKE_CHUNKS ?? 1);
const delayMs = Number(process.env.FAKE_DELAY_MS ?? 0);

let nextId = 1000;
let prompts = 0;
const pending = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

/** Ask the client something and wait for its reply. */
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (line.trim().length === 0) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  // A response to something we asked (e.g. permission).
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message.result);
    }
    return;
  }

  void handle(message);
});

async function handle(message) {
  const { id, method, params } = message;

  // Record what we were handed, so a test can assert the harness really passes
  // the workspace and the MCP tool server through.
  if (process.env.FAKE_RECORD) {
    try {
      appendFileSync(process.env.FAKE_RECORD, `${JSON.stringify({ method, params })}\n`);
    } catch {
      // best effort
    }
  }

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
        authMethods: [],
      });
      return;

    case 'session/new':
      respond(id, { sessionId: `fake-session-${nextId++}` });
      return;

    case 'session/prompt': {
      prompts += 1;
      if (prompts > crashAfter) process.exit(1);

      const sessionId = params?.sessionId;

      if (tool) {
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: tool,
            status: 'in_progress',
            rawInput: { file_path: '/repo/src/auth.ts' },
          },
        });
      }

      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

      if (permission) {
        const outcome = await request('session/request_permission', {
          sessionId,
          toolCall: { toolCallId: 'call-perm', title: permission },
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        });
        notify('_test/permission_outcome', outcome);
      }

      const size = Math.ceil(reply.length / chunks);
      for (let i = 0; i < reply.length; i += size) {
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: reply.slice(i, i + size) },
          },
        });
      }

      respond(id, { stopReason });
      return;
    }

    case 'session/cancel':
      // Notification: no response.
      return;

    default:
      if (id !== undefined) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `no such method: ${method}` },
        });
      }
  }
}
