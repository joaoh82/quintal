import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAgent,
  findAgentById,
  listAgentsForWorkspace,
  readAgentMcp,
  setAgentMcpServers,
  setAgentMcpStatus,
} from './agents.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * An agent's MCP servers are its owner's business.
 *
 * The agent list is sent to every member's browser — the agents page, the
 * channel and team pickers — so it must not carry them: a pending sign-in
 * URL lets whoever opens it decide whose account the agent acts with, and a
 * plain header or variable is the owner's configuration. They are read apart,
 * for the agents the viewer administers.
 */
describe('an agent’s MCP servers stay out of the shared agent list', () => {
  it('lists agents without them, and reads them only when asked', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Josh');
    const agent = await createAgent(db, {
      workspaceId: owner.workspaceId,
      ownerUserId: owner.id,
      name: 'marvin',
      spriteKey: 'slate',
    });
    await setAgentMcpServers(
      db,
      agent.id,
      [{ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', headers: [{ name: 'X-Team', value: 'plain' }] }],
      owner.id,
    );
    await setAgentMcpStatus(db, agent.id, [
      { name: 'linear', state: 'sign_in', signInUrl: 'https://mcp.linear.app/authorize?state=s', at: 1 },
    ]);

    const [listed] = await listAgentsForWorkspace(db, owner.workspaceId);
    const found = await findAgentById(db, agent.id);
    for (const entry of [listed, found]) {
      assert.ok(entry);
      assert.ok(!('mcpServers' in entry) && !('mcpStatus' in entry), 'the shared list must not carry them');
      assert.ok(!JSON.stringify(entry).includes('authorize'));
    }

    const mcp = (await readAgentMcp(db, [agent.id])).get(agent.id);
    assert.equal(mcp?.servers[0]?.name, 'linear');
    assert.equal(mcp?.status[0]?.signInUrl, 'https://mcp.linear.app/authorize?state=s');
    assert.equal((await readAgentMcp(db, [])).size, 0);
  });
});
