import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type * as schema from '@agentclientprotocol/sdk';

import { AgentProcess } from '../src/acp/agent-process.js';

/**
 * Integration tests against a scripted ACP agent that speaks the real wire
 * protocol. These are the tests that would have caught the things the docs got
 * wrong — the update discriminator is `sessionUpdate`, permission outcomes are
 * `selected`/`cancelled`, and stop reasons include `max_turn_requests`.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

interface Harness {
  proc: AgentProcess;
  updates: schema.SessionNotification[];
  permissions: schema.RequestPermissionRequest[];
  stop: () => void;
}

async function startFake(
  env: NodeJS.ProcessEnv = {},
  onPermission?: (
    params: schema.RequestPermissionRequest,
  ) => Promise<schema.RequestPermissionResponse>,
): Promise<Harness> {
  const updates: schema.SessionNotification[] = [];
  const permissions: schema.RequestPermissionRequest[] = [];

  const proc = new AgentProcess({
    command: [process.execPath, FAKE],
    cwd: process.cwd(),
    env,
    onUpdate: (params) => updates.push(params),
    onPermission: async (params) => {
      permissions.push(params);
      if (onPermission) return onPermission(params);
      return { outcome: { outcome: 'selected', optionId: 'yes' } } as
        unknown as schema.RequestPermissionResponse;
    },
  });

  await proc.start();
  return { proc, updates, permissions, stop: () => proc.stop() };
}

describe('ACP handshake', () => {
  it('initializes and reports the agent', async () => {
    const harness = await startFake();
    try {
      assert.equal(harness.proc.initialized?.agentInfo?.name, 'fake-acp-agent');
      assert.equal(harness.proc.running, true);
    } finally {
      harness.stop();
    }
  });

  it('hands the agent its workspace and its senses', async () => {
    const record = join(mkdtempSync(join(tmpdir(), 'quintal-acp-')), 'calls.jsonl');
    const harness = await startFake({ FAKE_RECORD: record });

    try {
      const created = await harness.proc.newSession({
        cwd: '/repo/example',
        mcpServers: [
          {
            name: 'quintal-tools',
            command: process.execPath,
            args: ['cli.js', 'mcp-server'],
            env: [{ name: 'QUINTAL_BRIDGE_URL', value: 'http://127.0.0.1:1' }],
          },
        ],
      } as schema.NewSessionRequest);

      assert.match(created.sessionId, /^fake-session-/);

      const calls = readFileSync(record, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });

      const newSession = calls.find((call) => call.method === 'session/new');
      assert.ok(newSession, 'the agent never received session/new');

      // Code context always comes from cwd, never from Quintal.
      assert.equal(newSession.params?.cwd, '/repo/example');

      const servers = newSession.params?.mcpServers as Array<{ name: string; args: string[] }>;
      assert.equal(servers.length, 1);
      assert.equal(servers[0]?.name, 'quintal-tools');
      assert.ok(servers[0]?.args.includes('mcp-server'));
    } finally {
      harness.stop();
    }
  });
});

describe('prompt turn', () => {
  it('streams text back as agent_message_chunk', async () => {
    const harness = await startFake({ FAKE_REPLY: 'Hello from the fake.', FAKE_CHUNKS: '4' });
    try {
      const session = await harness.proc.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      } as schema.NewSessionRequest);

      const response = await harness.proc.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });

      assert.equal(response.stopReason, 'end_turn');

      const text = harness.updates
        .map((update) => update.update as { sessionUpdate?: string; content?: { text?: string } })
        .filter((update) => update.sessionUpdate === 'agent_message_chunk')
        .map((update) => update.content?.text ?? '')
        .join('');

      assert.equal(text, 'Hello from the fake.');
      assert.ok(harness.updates.length >= 4, 'expected the reply to arrive in chunks');
    } finally {
      harness.stop();
    }
  });

  it('reports a token-limit stop reason', async () => {
    const harness = await startFake({ FAKE_STOP_REASON: 'max_tokens' });
    try {
      const session = await harness.proc.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      } as schema.NewSessionRequest);
      const response = await harness.proc.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
      assert.equal(response.stopReason, 'max_tokens');
    } finally {
      harness.stop();
    }
  });

  it('surfaces tool calls so they can drive the status line', async () => {
    const harness = await startFake({ FAKE_TOOL: 'Edit' });
    try {
      const session = await harness.proc.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      } as schema.NewSessionRequest);
      await harness.proc.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });

      const toolCall = harness.updates
        .map((update) => update.update as { sessionUpdate?: string; title?: string })
        .find((update) => update.sessionUpdate === 'tool_call');

      assert.equal(toolCall?.title, 'Edit');
    } finally {
      harness.stop();
    }
  });
});

describe('permission requests', () => {
  it('asks the client and accepts a selected option', async () => {
    const harness = await startFake({ FAKE_PERMISSION: 'Bash' });
    try {
      const session = await harness.proc.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      } as schema.NewSessionRequest);
      await harness.proc.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });

      assert.equal(harness.permissions.length, 1);
      const options = harness.permissions[0]?.options as Array<{ kind?: string }>;
      assert.deepEqual(
        options.map((option) => option.kind),
        ['allow_once', 'reject_once'],
      );
    } finally {
      harness.stop();
    }
  });

  it('can deny, and the agent still finishes its turn', async () => {
    const harness = await startFake({ FAKE_PERMISSION: 'Bash' }, async () => ({
      outcome: { outcome: 'selected', optionId: 'no' },
    }) as unknown as schema.RequestPermissionResponse);

    try {
      const session = await harness.proc.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      } as schema.NewSessionRequest);
      const response = await harness.proc.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
      assert.equal(response.stopReason, 'end_turn');
    } finally {
      harness.stop();
    }
  });
});
