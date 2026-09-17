/** Run the selected real harness in a disposable local office seeded by smoke-activity.mts. */
import { appendFileSync, readFileSync } from 'node:fs';
import type { AgentConfig } from '../src/config.js';
const entry = '../dist/index.js';
const { AgentRunner } = await import(entry) as typeof import('../src/index.js');
const [configPath, seedPath, outputPath] = process.argv.slice(2);
if (!configPath || !seedPath || !outputPath) throw new Error('Usage: observe-office-latency.ts CONFIG SEED OUTPUT.jsonl');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as AgentConfig;
const url = new URL(config.url);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '3000') throw new Error('Use a disposable local office outside port 3000');
const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as { workspaceId: string; a: { key: string } };
const runner = new AgentRunner({ ...config, workspaceId: seed.workspaceId, key: seed.a.key });
runner.on('latency', sample => {
  appendFileSync(outputPath, JSON.stringify(sample) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ requestId: sample.requestId, outcome: sample.outcome }) + '\n');
});
const stop = async () => { await runner.stop(); process.exit(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await runner.start();
process.stdout.write('Observer ready\n');
