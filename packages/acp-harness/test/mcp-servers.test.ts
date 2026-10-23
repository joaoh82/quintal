import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import {
  generateSecretKey,
  getPublicKeyHex,
  sealMcpSecret,
  type AgentMcpServer,
  type McpServerStatus,
} from '@quintal/shared';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import { parseMcpListing, parseReconnectFailures } from '../src/runner/mcp-servers.js';
import type { AgentConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * MCP servers defined in the office, on the agent's settings page.
 *
 * What has to hold: the runtime is handed them beside `quintal-tools`, a
 * sealed value arrives opened and nowhere else, a local server runs only for
 * an agent that may run things, a change reaches a conversation already
 * under way without losing it, and a sign-in link goes to the owner's page —
 * never into the conversation.
 */

interface Handlers {
  ready?: (payload: unknown) => void;
  chat?: (message: unknown) => void;
  mcpServers?: (event: { servers: AgentMcpServer[] }) => void;
}

const OWNER = 'owner-1';

function fakeGateway(handlers: Handlers, ready: Record<string, unknown>) {
  const said: string[] = [];
  const reports: McpServerStatus[][] = [];
  const gateway = {
    ready,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => {
      handlers.ready?.(ready);
      return ready;
    },
    leave: async () => {},
    say: (text: string) => said.push(text),
    setStatus: () => {},
    emote: () => {},
    hostReport: () => {},
    moveToZone: () => {},
    lookAround: async () => ({}),
    messagesGet: async () => ({ messages: [] }),
    memoryGet: async () => ({ content: '' }),
    memorySet: async () => ({ ok: true }),
    mcpStatus: (servers: McpServerStatus[]) => reports.push(servers),
    channels: () => [],
    occupants: () => [],
    on: (event: string, handler: unknown) => {
      (handlers as Record<string, unknown>)[event] = handler;
    },
  } as unknown as Gateway;
  return { gateway, said, reports };
}

function fromOwner(text: string) {
  return { fromUserId: OWNER, fromName: 'Josh', fromKind: 'human' as const, text, distance: 1, sentAt: Date.now() };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Recorded {
  method: string;
  params?: Record<string, unknown> & {
    mcpServers?: Array<{ name: string; type?: string; env?: Array<{ name: string; value: string }>; url?: string }>;
  };
}

function recorded(file: string): Recorded[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Recorded);
}

const calls = (file: string, method: string) => recorded(file).filter((entry) => entry.method === method);
const lastReport = (reports: McpServerStatus[][]) => reports.at(-1) ?? [];

describe('an agent’s own MCP servers', () => {
  let current: AgentRunner | null = null;

  afterEach(async () => {
    const runner = current;
    current = null;
    await runner?.stop();
    for (const name of [
      'FAKE_RECORD', 'FAKE_RESUME', 'FAKE_MCP_HTTP', 'FAKE_ELICIT_URL', 'FAKE_ELICIT_COMPLETE', 'FAKE_MCP_COMMAND',
      'FAKE_MCP_LISTING', 'FAKE_MCP_RECONNECT', 'FAKE_ELICIT_ON_RECONNECT', 'FAKE_ELICIT_SERVER', 'QUINTAL_MCP_CHECK_MS',
    ]) {
      delete process.env[name];
    }
  });

  async function run(options: { servers: AgentMcpServer[]; scopes: string[]; env?: Record<string, string>; secretKey: Uint8Array }) {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
    const record = join(dir, 'record.jsonl');
    process.env.FAKE_RECORD = record;
    for (const [name, value] of Object.entries(options.env ?? {})) process.env[name] = value;
    const handlers: Handlers = {};
    const ready = {
      agentId: 'agent-1',
      name: 'Bob',
      ownerUserId: OWNER,
      ownerName: 'Josh',
      instructions: '',
      description: '',
      scopes: options.scopes,
      mcpVersion: 1,
      mcpServers: options.servers,
      limits: { walkUpRadiusTiles: 4 },
    };
    const fake = fakeGateway(handlers, ready);
    const config = {
      name: 'Bob',
      key: Buffer.from(options.secretKey).toString('hex'),
      hostToken: '',
      agentId: '',
      harness: 'custom',
      command: [process.execPath, FAKE],
      cwd: dir,
      url: 'http://localhost:0',
      mapId: 'hq',
      workspaceId: 'ws-1',
    } as unknown as AgentConfig;
    const runner = new AgentRunner(config, undefined, fake.gateway);
    current = runner;
    await runner.start();
    return { handlers, record, ...fake };
  }

  it('hands the runtime its servers, with sealed values opened only here', async () => {
    const key = generateSecretKey();
    const sealed = await sealMcpSecret(getPublicKeyHex(key), 'API_KEY', 'sk-live-123');
    const { record, reports } = await run({
      secretKey: key,
      scopes: ['chat', 'status', 'run'],
      env: { FAKE_MCP_HTTP: '1' },
      servers: [
        { name: 'slack', transport: 'http', url: 'https://mcp.slack.com/mcp' },
        { name: 'files', transport: 'stdio', command: 'files-mcp', args: ['--root', '/srv'], env: [{ name: 'API_KEY', sealed }] },
      ],
    });

    await until(() => calls(record, 'session/new').length > 0, 'a session');
    const servers = calls(record, 'session/new')[0]?.params?.mcpServers ?? [];
    assert.deepEqual(servers.map((server) => server.name), ['quintal-tools', 'slack', 'files']);
    assert.equal(servers[1]?.type, 'http');
    assert.equal(servers[1]?.url, 'https://mcp.slack.com/mcp');
    assert.deepEqual(servers[2]?.env, [{ name: 'API_KEY', value: 'sk-live-123' }]);
    assert.deepEqual(lastReport(reports).map(({ name, state }) => [name, state]), [['slack', 'ready'], ['files', 'ready']]);

    const initialize = calls(record, 'initialize')[0]?.params as { clientCapabilities?: { elicitation?: unknown } };
    assert.deepEqual(initialize.clientCapabilities?.elicitation, { url: {} }, 'sign-in URLs are only offered to a client that says it takes them');
  });

  it('runs no local server for an agent that may not run things, and says why', async () => {
    const { record, reports } = await run({
      secretKey: generateSecretKey(),
      scopes: ['chat', 'status'],
      servers: [
        { name: 'files', transport: 'stdio', command: 'files-mcp' },
        { name: 'slack', transport: 'http', url: 'https://mcp.slack.com/mcp' },
      ],
    });

    await until(() => calls(record, 'session/new').length > 0, 'a session');
    const servers = calls(record, 'session/new')[0]?.params?.mcpServers ?? [];
    assert.deepEqual(servers.map((server) => server.name), ['quintal-tools']);
    const report = lastReport(reports);
    assert.equal(report.find((entry) => entry.name === 'files')?.state, 'skipped');
    assert.match(report.find((entry) => entry.name === 'files')?.reason ?? '', /run/);
    // The fake runtime does not advertise HTTP, so Slack is left out with a reason too.
    assert.match(report.find((entry) => entry.name === 'slack')?.reason ?? '', /HTTP/);
  });

  it('reaches a conversation under way when the owner changes them, without losing it', async () => {
    const { handlers, record, said } = await run({
      secretKey: generateSecretKey(),
      scopes: ['chat', 'status'],
      env: { FAKE_RESUME: '1', FAKE_MCP_HTTP: '1' },
      servers: [],
    });

    handlers.chat?.(fromOwner('hello'));
    await until(() => said.includes('ok'), 'the first answer');
    const session = calls(record, 'session/prompt')[0]?.params?.sessionId;

    handlers.mcpServers?.({ servers: [{ name: 'slack', transport: 'http', url: 'https://mcp.slack.com/mcp' }] });
    await until(() => calls(record, 'initialize').length === 2, 'the runtime to reload');

    handlers.chat?.(fromOwner('can you see slack now?'));
    await until(() => calls(record, 'session/prompt').length === 2, 'the second prompt');
    assert.equal(calls(record, 'session/prompt')[1]?.params?.sessionId, session);
    const resumed = calls(record, 'session/resume')[0]?.params?.mcpServers ?? [];
    assert.deepEqual(resumed.map((server) => server.name), ['quintal-tools', 'slack']);
  });

  it('opens a session after the owner’s change, so a sign-in can start before anyone speaks', async () => {
    const { handlers, record } = await run({ secretKey: generateSecretKey(), scopes: ['chat'], env: { FAKE_MCP_HTTP: '1' }, servers: [] });
    await until(() => calls(record, 'session/new').length === 1, 'the warm session at start');
    handlers.mcpServers?.({ servers: [{ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp' }] });
    await until(() => calls(record, 'initialize').length === 2, 'the runtime to reload');
    await until(() => calls(record, 'session/new').length === 2, 'a session in the new process, with nobody speaking');
    const servers = calls(record, 'session/new')[1]?.params?.mcpServers ?? [];
    assert.deepEqual(servers.map((server) => server.name), ['quintal-tools', 'linear']);
  });

  it('leaves the same list alone when the office says it again', async () => {
    const servers: AgentMcpServer[] = [{ name: 'slack', transport: 'http', url: 'https://mcp.slack.com/mcp' }];
    const { handlers, record } = await run({ secretKey: generateSecretKey(), scopes: ['chat'], servers });
    await until(() => calls(record, 'initialize').length === 1, 'the runtime');
    handlers.mcpServers?.({ servers: structuredClone(servers) });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(calls(record, 'initialize').length, 1, 'no reload for no change');
  });

  it('sends a sign-in link to the owner’s page, never into the conversation', async () => {
    const url = 'https://slack.com/oauth/v2/authorize?client_id=x&state=secret-state';
    const { handlers, record, said, reports } = await run({
      secretKey: generateSecretKey(),
      scopes: ['chat', 'status'],
      env: { FAKE_MCP_HTTP: '1', FAKE_ELICIT_URL: url },
      servers: [{ name: 'slack', transport: 'http', url: 'https://mcp.slack.com/mcp' }],
    });

    handlers.chat?.(fromOwner('post the summary to slack'));
    await until(() => lastReport(reports)[0]?.state === 'sign_in', 'the sign-in to be reported');
    assert.equal(lastReport(reports)[0]?.signInUrl, url);
    assert.equal(calls(record, '_test/elicitation_response')[0]?.params?.action, 'accept');
    await until(() => said.some((line) => line.includes('needs signing in')), 'the conversation to be told');
    assert.ok(said.every((line) => !line.includes('secret-state')), 'the link must not reach the conversation');
  });

  it('takes the link down when the runtime closes the sign-in', async () => {
    const { record, reports } = await run({
      secretKey: generateSecretKey(),
      scopes: ['chat', 'status'],
      env: { FAKE_MCP_HTTP: '1', FAKE_ELICIT_URL: 'https://slack.com/oauth', FAKE_ELICIT_COMPLETE: '1' },
      servers: [{ name: 'slack', transport: 'http', url: 'https://mcp.slack.com/mcp' }],
    });
    await until(() => calls(record, '_test/elicitation_response').length > 0, 'the sign-in');
    await until(() => lastReport(reports)[0]?.state === 'ready', 'the sign-in to clear');
  });

  /**
   * claude-agent-acp looks for servers needing sign-in once, as the session
   * opens — while a hosted server is still connecting, so it finds none and
   * the sign-in never starts. Its own `/mcp reconnect` does start it.
   */
  it('starts the sign-in itself when the runtime’s own check came too early', async () => {
    const url = 'https://mcp.linear.app/authorize?state=x';
    const { record, reports, said } = await run({
      secretKey: generateSecretKey(),
      scopes: ['chat', 'status'],
      env: {
        QUINTAL_MCP_CHECK_MS: '50',
        FAKE_MCP_HTTP: '1',
        FAKE_MCP_COMMAND: '1',
        FAKE_ELICIT_URL: url,
        FAKE_ELICIT_ON_RECONNECT: '1',
        FAKE_ELICIT_SERVER: 'linear',
        FAKE_MCP_LISTING: '**MCP servers:** 3\n**Failed**\n- `slack`: Incompatible auth server: does not support dynamic client registration\n**Needs authentication**\n- `linear`\n- `someone-elses`\n**Connected**\n- `quintal-tools`: 14 tools',
        FAKE_MCP_RECONNECT: "- Couldn't reconnect `linear`: Server status: needs-auth",
      },
      servers: [
        { name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp' },
        { name: 'slack', transport: 'http', url: 'https://mcp.slack.com/mcp' },
      ],
    });

    await until(() => lastReport(reports).find((entry) => entry.name === 'linear')?.state === 'sign_in', 'linear to need signing in');
    const report = lastReport(reports);
    assert.equal(report.find((entry) => entry.name === 'linear')?.signInUrl, url);
    assert.equal(report.find((entry) => entry.name === 'slack')?.state, 'skipped');
    assert.match(report.find((entry) => entry.name === 'slack')?.reason ?? '', /dynamic client registration/);
    // Only the owner's servers: one the runtime has from elsewhere is not ours to sign in to.
    const asked = calls(record, 'session/prompt').map((entry) => (entry.params?.prompt as Array<{ text: string }>)[0]?.text);
    assert.deepEqual(asked, ['/mcp', '/mcp reconnect linear']);
    // The runtime's own answers are read, not said.
    assert.ok(said.every((line) => !line.includes('MCP servers:')));
  });
});

describe('reading the runtime’s /mcp', () => {
  it('reads each group, and ignores what it does not recognise', () => {
    const listing = parseMcpListing(
      '**MCP servers:** 3 (1 failed)\n**Failed**\n- `gmail`: No URL configured\n**Needs authentication**\n- `linear`\n**Connected**\n- `notion`: 65 tools\n**Something new**\n- `odd`',
    );
    assert.deepEqual(listing.get('gmail'), { group: 'failed', detail: 'No URL configured' });
    assert.deepEqual(listing.get('linear'), { group: 'needs-auth' });
    assert.equal(listing.get('notion')?.group, 'connected');
    assert.equal(listing.has('odd'), false);
    assert.equal(parseMcpListing('MCP is fine, thanks').size, 0);
  });

  it('reads why a reconnect failed', () => {
    const failures = parseReconnectFailures("- Couldn't reconnect `slack`: Incompatible auth server\n- Reconnected `x`");
    assert.deepEqual([...failures], [['slack', 'Incompatible auth server']]);
  });
});
