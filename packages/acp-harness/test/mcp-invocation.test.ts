import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { mcpServerArgs } from '../src/runner/AgentRunner.js';

/**
 * How the agent is told to start its tool server.
 *
 * Two shapes, because there are two ways this ships, and getting it wrong is
 * invisible from the office: the agent connects, chats, and answers — it simply
 * cannot look, move, or remember, because the tool server exited before it
 * spoke. Asked to walk over, it apologises and explains that the office tools
 * server is refusing the connection.
 *
 * Under Node the entry is a real file and must be named. Inside the bundled app
 * it is a bun single-file executable whose entry is embedded, and
 * `import.meta.url` points into bun's virtual filesystem — `/$bunfs/cli.js`,
 * which exists only inside the running binary. Passing that does not run a
 * script; it is read as the subcommand, and the process dies with
 * `unknown command "/$bunfs/cli.js"`.
 */

describe('starting the tool server', () => {
  it('names the entry when it is a real file', () => {
    // This test file is one, which is all the check cares about.
    const real = fileURLToPath(import.meta.url);
    assert.deepEqual(mcpServerArgs(real), [real, 'mcp-server']);
  });

  it('passes only the subcommand when the entry is not on disk', () => {
    // What a bun single-file executable reports for its own entry point.
    assert.deepEqual(mcpServerArgs('/$bunfs/cli.js'), ['mcp-server']);
  });

  it('does not pass a path that would be read as a subcommand', () => {
    // The specific failure: `/$bunfs/cli.js` arriving as positional[0].
    const args = mcpServerArgs('/$bunfs/cli.js');
    assert.equal(args[0], 'mcp-server', 'the first argument has to be the verb');
    assert.ok(!args.some((arg) => arg.includes('$bunfs')));
  });
});
