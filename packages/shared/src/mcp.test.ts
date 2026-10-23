import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateSecretKey, getPublicKeyHex } from './identity.js';
import {
  isSealedMcpSecret,
  mcpServersFingerprint,
  openMcpSecret,
  sealMcpSecret,
  validateMcpServers,
} from './mcp.js';

describe('validating an agent’s MCP servers', () => {
  it('accepts a hosted server and a local one, and keeps nothing it did not check', () => {
    const result = validateMcpServers([
      { name: 'slack', transport: 'http', url: 'https://mcp.slack.com/mcp', extra: 'smuggled' },
      { name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'some-mcp'], env: [{ name: 'ROOT', value: '/srv' }] },
    ]);
    assert.ok(result.ok);
    assert.deepEqual(result.servers, [
      { name: 'slack', transport: 'http', url: 'https://mcp.slack.com/mcp' },
      { name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'some-mcp'], env: [{ name: 'ROOT', value: '/srv' }] },
    ]);
  });

  it('refuses plain http off this machine, credentials in a URL, and the harness’s own name', () => {
    for (const bad of [
      { name: 'a', transport: 'http', url: 'http://mcp.example.com' },
      { name: 'a', transport: 'http', url: 'https://user:pass@mcp.example.com' },
      { name: 'quintal-tools', transport: 'http', url: 'https://mcp.example.com' },
      { name: 'Has Space', transport: 'http', url: 'https://mcp.example.com' },
      { name: 'a', transport: 'stdio', command: '' },
      { name: 'a', transport: 'stdio', command: 'x', env: [{ name: 'K', value: 'v', sealed: 'qs1.AA' }] },
      { name: 'a', transport: 'carrier-pigeon' },
    ]) {
      assert.equal(validateMcpServers([bad]).ok, false, JSON.stringify(bad));
    }
    assert.ok(validateMcpServers([{ name: 'local', transport: 'http', url: 'http://localhost:3000/mcp' }]).ok);
  });

  it('refuses two servers with one name', () => {
    const server = { name: 'slack', transport: 'http', url: 'https://mcp.slack.com/mcp' };
    assert.equal(validateMcpServers([server, server]).ok, false);
  });

  it('fingerprints what would be handed over, not how it was written', () => {
    const a = validateMcpServers([{ name: 'slack', transport: 'http', url: ' https://mcp.slack.com/mcp ' }]);
    const b = validateMcpServers([{ url: 'https://mcp.slack.com/mcp', transport: 'http', name: 'slack' }]);
    assert.ok(a.ok && b.ok);
    assert.equal(mcpServersFingerprint(a.servers), mcpServersFingerprint(b.servers));
  });
});

describe('sealing a secret to an agent', () => {
  it('opens with the agent’s key and nothing else', async () => {
    const agent = generateSecretKey();
    const sealed = await sealMcpSecret(getPublicKeyHex(agent), 'API_KEY', 'sk-live-123');
    assert.ok(isSealedMcpSecret(sealed));
    assert.ok(!sealed.includes('sk-live'));
    assert.equal(await openMcpSecret(agent, 'API_KEY', sealed), 'sk-live-123');
    await assert.rejects(openMcpSecret(generateSecretKey(), 'API_KEY', sealed));
  });

  it('does not open under another variable’s name', async () => {
    const agent = generateSecretKey();
    const sealed = await sealMcpSecret(getPublicKeyHex(agent), 'API_KEY', 'secret');
    await assert.rejects(openMcpSecret(agent, 'OTHER', sealed));
  });

  it('works for keys of either parity', async () => {
    // An x-only key drops the sign of its point; half of all agent keys are the odd lift.
    for (let i = 0; i < 8; i += 1) {
      const agent = generateSecretKey();
      const sealed = await sealMcpSecret(getPublicKeyHex(agent), 'K', `value ${i}`);
      assert.equal(await openMcpSecret(agent, 'K', sealed), `value ${i}`);
    }
  });

  it('is accepted by validation as a sealed value', async () => {
    const sealed = await sealMcpSecret(getPublicKeyHex(generateSecretKey()), 'TOKEN', 'x');
    const result = validateMcpServers([
      { name: 'gh', transport: 'stdio', command: 'gh-mcp', env: [{ name: 'TOKEN', sealed }] },
    ]);
    assert.ok(result.ok);
  });
});
