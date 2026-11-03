import { existsSync, writeFileSync } from 'node:fs';

import { taskShelf } from '../../src/runner/tasks.js';

/**
 * One harness process claiming a shelf, for the test of several doing it at
 * once. It says it is ready, then spins on a file so that every process reads
 * the shelves in the same instant rather than one after another: starting a
 * process takes far longer than the race it is here to catch.
 */
const [nest, agentId, name, go, ready] = process.argv.slice(2) as [string, string, string, string, string];

writeFileSync(ready, '');
while (!existsSync(go)) {
  // Deliberately not a timer: a wake-up on the next tick would spread them out.
}
process.stdout.write(taskShelf(nest, agentId, name, { claim: true }));
