import { runtimeById, type RosterEntry } from '@quintal/shared';

/** The two lines the agent card prints about what an agent is running on. */
export interface RuntimeLines {
  /** The runtime's catalogue label, or its bare id when the catalogue lost it. */
  runtime: string;
  /** The model by the runtime's own id, or `default` for the runtime's own. */
  model: string;
}

/**
 * What an agent is running on, as its card should read it — or null when the
 * office has no honest answer.
 *
 * Null is the case for an agent the office does not define: one made before
 * fleet definitions existed, or one launched by hand with its own key. The
 * card leaves both rows out rather than printing `unknown`, because the office
 * genuinely does not know — it never told anybody what to launch.
 *
 * An empty model is different, and is not null: it means the runtime's own
 * default, which is a choice its owner can make and unmake, so it gets said.
 *
 * The model is the runtime's raw id and not the label the runtime gives it:
 * that label lives in what a *host* reported (`RuntimeModels.choices`), and
 * resolving it would mean a lookup per occupant on every roster publish. The
 * agents list in settings prints the raw id for the same reason.
 */
export function runtimeLines(entry: RosterEntry): RuntimeLines | null {
  if (entry.kind !== 'agent' || entry.runtimeId.length === 0) return null;
  return {
    runtime: runtimeById(entry.runtimeId)?.label ?? entry.runtimeId,
    model: entry.modelId.length > 0 ? entry.modelId : 'default',
  };
}
