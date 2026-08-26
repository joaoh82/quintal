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

/**
 * Forget a machine's report.
 *
 * Reports arrive whenever a harness connects and nothing ever removed one, so a
 * machine that changed name — or a laptop somebody stopped using — stayed in the
 * office forever with no way to clear it. Scoped to the workspace and to the
 * person who reported it, because a report says what somebody's computer has on
 * it and is theirs to withdraw.
 *
 * Returns whether anything was removed, so a caller can tell "gone" from "was
 * never yours".
 */
export async function forgetHostReport(
  db: Database,
  input: { workspaceId: string; ownerUserId: string; label: string },
): Promise<boolean> {
  const rows = await db
    .select({ id: agentHosts.id })
    .from(agentHosts)
    .where(
      and(
        eq(agentHosts.workspaceId, input.workspaceId),
        eq(agentHosts.ownerUserId, input.ownerUserId),
        eq(agentHosts.label, input.label),
      ),
    );

  if (rows.length === 0) return false;
  for (const row of rows) {
    await db.delete(agentHosts).where(eq(agentHosts.id, row.id));
  }
  return true;
}
