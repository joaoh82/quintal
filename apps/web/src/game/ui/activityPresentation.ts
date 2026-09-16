import {
  activityTerminal,
  type ActivityDetailLevel,
  type ActivityItem,
  type PublicActivity,
  type StepState,
} from '@quintal/shared';

const FINISHED: StepState[] = ['success', 'failed', 'unknown', 'cancelled', 'interrupted'];
const PROBLEMS: StepState[] = ['failed', 'cancelled', 'interrupted'];

export interface ActivityPresentation {
  tools: ActivityItem[];
  messages: ActivityItem[];
  current?: ActivityItem;
  problems: ActivityItem[];
  finalMessage?: ActivityItem;
  outcomeSummary: string;
}

/** Display-only projections. The retained activity object is never filtered or rewritten. */
export function activityPresentation(activity: PublicActivity): ActivityPresentation {
  const tools = activity.items.filter((item) => item.kind === 'tool');
  const messages = activity.items.filter((item) => item.kind === 'message');
  const current = [...tools]
    .reverse()
    .find((item) => item.state === 'pending' || item.state === 'running');
  const problems = tools.filter((item) => PROBLEMS.includes(item.state));
  const count = (state: StepState) => tools.filter((item) => item.state === state).length;
  const finished = tools.filter((item) => FINISHED.includes(item.state)).length;
  const extras = [
    count('cancelled') ? `${count('cancelled')} cancelled` : '',
    count('interrupted') ? `${count('interrupted')} interrupted` : '',
  ].filter(Boolean);
  const outcomeSummary =
    finished === 0
      ? ''
      : [
          `${finished} completed`,
          `${count('success')} succeeded`,
          `${count('failed')} failed`,
          `${count('unknown')} unknown`,
          ...extras,
        ].join(' · ');

  return {
    tools,
    messages,
    current,
    problems,
    finalMessage: activityTerminal(activity.state) ? messages.at(-1) : undefined,
    outcomeSummary,
  };
}

export function collapsedActivityItems(
  activity: PublicActivity,
  detailLevel: ActivityDetailLevel,
  view = activityPresentation(activity),
): ActivityItem[] {
  if (detailLevel === 'detailed') return [];
  const visibleIds = new Set<string>();
  if (detailLevel === 'low' && view.finalMessage) visibleIds.add(view.finalMessage.id);
  if (detailLevel === 'balanced') {
    for (const message of view.messages) visibleIds.add(message.id);
    if (view.current) visibleIds.add(view.current.id);
  }
  for (const problem of view.problems) visibleIds.add(problem.id);
  return activity.items.filter((item) => !visibleIds.has(item.id));
}
