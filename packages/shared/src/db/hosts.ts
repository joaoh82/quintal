import { randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { normaliseHostReport, type HostReport } from '../runtimes.js';
import { agentHosts } from './schema.js';
import type { Database } from './client.js';

/**
 * Record what a machine says it can run.
 *
 * Upsert by (workspace, label) rather than insert: a fleet of eight agents on
 * one laptop reports the same machine eight times, and eight rows saying the
 * same thing would be a worse answer than one.
 */
export async function recordHost(
  db: Database,
  input: { workspaceId: string; ownerUserId: string; report: unknown },
): Promise<HostReport | null> {
  const report = normaliseHostReport(input.report);
  if (!report) return null;

  const existing = await db
    .select({ id: agentHosts.id })
    .from(agentHosts)
    .where(
      and(eq(agentHosts.workspaceId, input.workspaceId), eq(agentHosts.label, report.label)),
    )
    .limit(1);

  // Omitting the runtime list leaves the stored one alone: every agent of a
  // fleet reports its machine, but only the first one scans PATH. Writing
  // `[]` for the other seven would erase the answer seconds after getting it.
  const row = {
    reposDir: report.reposDir,
    lastSeenAt: new Date(),
    ...(report.runtimes ? { runtimes: report.runtimes } : {}),
  };

  if (existing[0]) {
    await db.update(agentHosts).set(row).where(eq(agentHosts.id, existing[0].id));
  } else {
    await db.insert(agentHosts).values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      label: report.label,
      runtimes: [],
      ...row,
    });
  }

  return report;
}

export async function listHostsForWorkspace(db: Database, workspaceId: string) {
  return db
    .select()
    .from(agentHosts)
    .where(eq(agentHosts.workspaceId, workspaceId))
    .orderBy(desc(agentHosts.lastSeenAt));
}
