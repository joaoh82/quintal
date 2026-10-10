import { agentTaskFields, type AgentTask, type AgentTaskFields } from '@quintal/shared';

/**
 * Put an agent's task on its player, or take it off with `null`.
 *
 * Field by field, and only where a value changed: every assignment to a schema
 * field is a patch to every client in the room, and a harness says the same
 * task again on every reconnect. Returns whether anything changed, so the
 * caller only records what did.
 */
export function applyAgentTask(player: AgentTaskFields, task: AgentTask | null): boolean {
  const next = agentTaskFields(task);
  let changed = false;
  for (const key of Object.keys(next) as (keyof AgentTaskFields)[]) {
    if (player[key] !== next[key]) {
      (player as unknown as Record<string, unknown>)[key] = next[key];
      changed = true;
    }
  }
  return changed;
}
