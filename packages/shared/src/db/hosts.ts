import { randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { normaliseHostReport, type HostReport } from '../runtimes.js';
import { agentHosts, agents, users } from './schema.js';
import type { Database } from './client.js';

/**
 * Record what a machine says it can run.
 *
 * Upsert by (workspace, owner, label) rather than insert: a fleet of eight
 * agents on one laptop reports the same machine eight times, and eight rows
 * saying the same thing would be a worse answer than one. The owner is part
 * of the key because a label defaults to a hostname and everybody calls
 * their laptop "laptop": a report is one person's machine, and must never
 * update a colleague's row of the same name.
 */
export async function recordHost(
  db: Database,
  input: { workspaceId: string; ownerUserId: string; report: unknown },
): Promise<HostReport | null> {
  const report = normaliseHostReport(input.report);
  if (!report) return null;

  // Omitting the runtime list leaves the stored one alone: every agent of a
  // fleet reports its machine, but only the first one scans PATH. Writing
  // `[]` for the other seven would erase the answer seconds after getting it.
  // The checkouts the same.
  const row = {
    reposDir: report.reposDir,
    lastSeenAt: new Date(),
    ...(report.runtimes ? { runtimes: report.runtimes } : {}),
    ...(report.checkouts ? { checkouts: report.checkouts } : {}),
  };

  // One statement, on the unique key: two agents of a fleet make a machine's
  // first report in the same instant, and a select-then-insert had the
  // second one fail on the index — and that agent then knew no machine.
  await db
    .insert(agentHosts)
    .values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      label: report.label,
      runtimes: [],
      ...row,
    })
    .onConflictDoUpdate({
      target: [agentHosts.workspaceId, agentHosts.ownerUserId, agentHosts.label],
      set: row,
    });

  return report;
}

/** Every machine reported into the office, newest report first, with whose it is. */
export async function listHostsForWorkspace(db: Database, workspaceId: string) {
  const rows = await db
    .select({ host: agentHosts, ownerName: users.name })
    .from(agentHosts)
    .leftJoin(users, eq(users.id, agentHosts.ownerUserId))
    .where(eq(agentHosts.workspaceId, workspaceId))
    .orderBy(desc(agentHosts.lastSeenAt));
  return rows.map(({ host, ownerName }) => ({ ...host, ownerName: ownerName ?? '' }));
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
  // Nothing of this person's now reports from a machine the office has
  // forgotten: an agent's row would otherwise name a machine with no row.
  await db
    .update(agents)
    .set({ reportedHostLabel: null })
    .where(
      and(
        eq(agents.workspaceId, input.workspaceId),
        eq(agents.ownerUserId, input.ownerUserId),
        eq(agents.reportedHostLabel, input.label),
      ),
    );
  return true;
}
