import type { AgentTask } from '@quintal/shared';
import { GitBranch } from 'lucide-react';

/**
 * The roster's mark for an agent on a task: a branch, drawn rather than typed.
 * The `⎇` character falls back to a font where, at roster size, it is a smudge.
 */
export function TaskGlyph({ task }: { task: AgentTask }) {
  return (
    <span
      className="shrink-0 self-center text-emerald-300/80"
      title={taskSummary(task)}
      aria-label={taskSummary(task)}
      role="img"
    >
      <GitBranch size={11} strokeWidth={2.25} aria-hidden />
    </span>
  );
}

/** The task in one line, for a tooltip and for whoever cannot see the glyph. */
export function taskSummary(task: AgentTask): string {
  const pr = task.pr ? ` · PR #${task.pr.number} (${task.pr.state})` : '';
  return `On: ${task.title} · ${task.branch}${pr}`;
}

/**
 * What an agent is on, as a row of its card: the task, its branch, and its
 * pull request as a link. Nothing at all when it is on no task — an empty row
 * would read as a task with no name.
 *
 * The link is safe to draw because the office only keeps `http:` and `https:`
 * ones (`parseAgentTask`), and `agentTaskOf` checks again on the way out.
 */
export function AgentTaskRow({ task }: { task: AgentTask | null }) {
  if (!task) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-white/40">on</dt>
      <dd className="min-w-0 text-white/85">
        {task.title}
        {' · '}
        {/* A branch has nowhere to break, so say it may break anywhere. */}
        <span className="font-mono break-all text-white/65">{task.branch}</span>
        {task.pr ? (
          <>
            {' · '}
            <a
              href={task.pr.url}
              target="_blank"
              rel="noreferrer"
              className="text-sky-200 underline-offset-2 hover:underline"
            >
              PR #{task.pr.number}
            </a>{' '}
            <span className="text-white/50">({task.pr.state})</span>
          </>
        ) : null}
      </dd>
    </div>
  );
}
