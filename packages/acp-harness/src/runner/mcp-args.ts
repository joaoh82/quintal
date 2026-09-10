import { existsSync } from 'node:fs';

/**
 * How to invoke this same program again, to run the MCP tool server.
 *
 * Two shapes, because there are two ways this ships. Under Node the entry is a
 * real file and has to be named: `node …/cli.js mcp-server`. Inside the bundled
 * app it is a bun single-file executable whose entry point is embedded, and
 * `import.meta.url` resolves into bun's virtual filesystem — `/$bunfs/cli.js`,
 * a path that exists only inside the running binary.
 *
 * Passing that to the compiled binary does not run a script. It is read as the
 * subcommand, the process exits with `unknown command "/$bunfs/cli.js"`, and
 * the agent is left with a tool server that never started — so it can talk but
 * cannot look, move, or remember. Chat still worked, which is why this survived
 * a bundle that had otherwise been tested.
 *
 * Decided by asking whether the entry is a file that exists, rather than by
 * sniffing for bun. That is the property that actually matters, and it stays
 * true whatever a future runtime calls its virtual paths.
 */
export function mcpServerArgs(entry?: string): string[] {
  const path = entry ?? new URL('../cli.js', import.meta.url).pathname;
  return existsSync(path) ? [path, 'mcp-server'] : ['mcp-server'];
}
