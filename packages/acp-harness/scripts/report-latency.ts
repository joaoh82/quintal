/** Summarize or compare bounded artifacts; never accepts raw prompt/runtime logs. */
import { readFileSync, writeFileSync } from 'node:fs';
import { summarizeLatency, compareLatency, type LatencyRun } from '../src/runner/latency-report.js';
const [beforePath, afterPath, budgetsPath, outputPath] = process.argv.slice(2);
if (!beforePath) throw new Error('Usage: report-latency.ts BEFORE [AFTER BUDGETS OUTPUT]');
const read = (path: string): LatencyRun => {
  const value = JSON.parse(readFileSync(path, 'utf8')) as LatencyRun | { run: LatencyRun };
  return 'run' in value ? value.run : value;
};
const result = afterPath && budgetsPath
  ? compareLatency(read(beforePath), read(afterPath), JSON.parse(readFileSync(budgetsPath, 'utf8')) as Record<string, number>)
  : summarizeLatency(read(beforePath));
const json = JSON.stringify(result, null, 2) + '\n';
if (outputPath) writeFileSync(outputPath, json, { mode: 0o600 });
else process.stdout.write(json);
