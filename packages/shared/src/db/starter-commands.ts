import { randomBytes } from 'node:crypto';

import {
  normaliseOfficeCommandArgumentHint,
  normaliseOfficeCommandInstructions,
  normaliseOfficeCommandName,
  normaliseOfficeCommandSummary,
} from '../office-command.js';
import type { Database } from './client.js';
import { officeCommands } from './schema.js';

/**
 * The commands a new office starts with.
 *
 * Useful on day one — most offices put agents to engineering work, and a PR
 * review is the brief people would otherwise retype — and an example of what
 * a command is for. They are ordinary rows once written: anyone may change
 * or delete them, and an office that deletes one does not get it back, since
 * they are written only when the office is made.
 *
 * No default target, because a new office has no agents or teams to aim at;
 * `!review @engineering <link>` names one. Nobody made them, so no member is
 * credited with the brief.
 */
export interface StarterOfficeCommand {
  name: string;
  summary: string;
  argumentHint: string;
  instructions: string;
}

export const STARTER_OFFICE_COMMANDS: readonly StarterOfficeCommand[] = [
  {
    name: 'review',
    summary: 'Review a pull request',
    argumentHint: '<pull request link>',
    instructions: [
    'Perform a thorough code review or re-review of the current GitHub pull request.',
    '',
    '**Scope & Baseline**',
    '- Identify the active PR and its target branch. Compare changes against the merge base.',
    '- Review all introduced changes, including relevant surrounding code and dependencies.',
    '- If previous reviews exist, verify whether their findings were correctly addressed.',
    '- For re-reviews, evaluate the entire latest code state for regressions, incomplete fixes, and new issues.',
    '- Do not repeat resolved findings or report pre-existing issues unless worsened.',
    '',
    '**Review Focus**',
    '- **Correctness:** Bugs, logic errors, and edge cases.',
    '- **Security:** Vulnerabilities and unsafe practices.',
    '- **Performance:** Bottlenecks and inefficiencies.',
    '- **Maintainability:** Architecture, complexity, and code quality.',
    '- **Testing:** Missing coverage and unhandled scenarios.',
    '',
    '**Findings**',
    '- Prioritize by severity: Critical, High, Medium, Low.',
    '- Include file paths, line numbers, impact, and suggested fixes.',
    '- For re-reviews, classify previous findings as **Resolved, Partially Resolved, or Unresolved**.',
    '- Report only concrete, actionable issues. Avoid speculation, nitpicks, and duplicates.',
    '',
    '**Human Escalation**',
    '- Use the GitHub label `human-review-required` when a finding requires human judgment, authorization, or approval.',
    '- Escalate critical security vulnerabilities, irreversible or destructive operations, sensitive data exposure, significant architectural decisions, and changes with substantial production or business risk.',
    '- Clearly explain why human intervention is necessary and what decision or approval is required.',
    '- Submit **REQUEST_CHANGES** for blocking issues and explicitly state that automated agents must not approve or merge the PR until a human has reviewed it.',
    '- Do not apply the label for ordinary bugs or issues that agents can safely resolve.',
    "- On re-review, preserve the label until human approval is explicitly confirmed. Do not treat an agent's approval as human authorization.",
    '',
    '**GitHub Review Submission**',
    '- **You MUST publish the review directly on the GitHub pull request.**',
    "- Use GitHub's PR review API or available GitHub tools.",
    '- Post actionable findings as inline comments on relevant changed lines whenever possible.',
    "- Include a concise overall summary, severity breakdown, previous findings' status, and any human escalation requirements.",
    '- Submit **REQUEST_CHANGES** for blocking issues, **COMMENT** for non-blocking findings, or **APPROVE** when no actionable issues remain and no human approval is pending.',
    '- Never approve a PR with unresolved blocking issues or pending human escalation.',
    '- Avoid duplicate comments on re-reviews.',
    '- Apply or remove the `human-review-required` label only according to the escalation rules and verified human approval.',
    '- Verify successful publication and provide the PR URL.',
    '',
    '**Do not modify code, create commits, push changes, or merge the PR. The task is complete only after the review has been successfully submitted to GitHub.**',
    ].join('\n'),
  },
];

/** Write the starter commands into an office that has just been made. */
export async function addStarterOfficeCommands(db: Database, workspaceId: string): Promise<void> {
  await db.insert(officeCommands).values(
    STARTER_OFFICE_COMMANDS.map((command) => ({
      id: randomBytes(16).toString('hex'),
      workspaceId,
      name: normaliseOfficeCommandName(command.name),
      summary: normaliseOfficeCommandSummary(command.summary),
      argumentHint: normaliseOfficeCommandArgumentHint(command.argumentHint),
      instructions: normaliseOfficeCommandInstructions(command.instructions),
      createdBy: null,
    })),
  );
}
