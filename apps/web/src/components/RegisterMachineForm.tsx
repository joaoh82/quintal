'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { registerThisMachine, type KnownMachine } from '@/lib/machine';

/**
 * Name this computer and keep the token the office issues.
 *
 * Shared by the first-run banner, the fleet controls, and the Machines
 * list: those are three doors into the same action, and a second copy of
 * the form would drift. The caller decides the chrome; this is the name
 * field, the names already taken, and the claim.
 *
 * ## Why the other names are buttons
 *
 * Agents are pinned to a machine *by label*, so the name is not decoration —
 * it is the only thing that says which machine an agent is waiting on. A
 * person who registers this computer under a fresh name while four agents
 * point at the old one has lost their computer, and nothing about the screen
 * told them that was the choice they were making.
 *
 * So every name the office already knows is one click away, annotated with
 * what is waiting on it. Retyping `DPR010_Office` exactly, from memory, into
 * a field helpfully pre-filled with `Joaos-MacBook-Pro-2` is not a recovery
 * path — it is a trivia question standing between somebody and their agents.
 */
export function RegisterMachineForm({
  suggested,
  known,
  knownAs = null,
  onRegistered,
}: {
  suggested: string;
  /** Names this office already knows machines by. */
  known: KnownMachine[];
  /** What this machine last registered as here, if the app still remembers. */
  knownAs?: string | null;
  onRegistered?: () => void;
}) {
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setName(suggested);
  }, [suggested]);

  const trimmed = name.trim();
  const adopting = known.find((machine) => machine.label === trimmed) ?? null;
  // Somewhere else to go: the names that are not already in the field.
  const others = known.filter((machine) => machine.label !== trimmed);

  async function claim() {
    setBusy(true);
    setProblem(null);
    const outcome = await registerThisMachine(trimmed);
    setBusy(false);

    if (outcome.kind === 'registered') {
      onRegistered?.();
      window.location.reload();
      return;
    }
    if (outcome.kind === 'not-hosted') return;
    setProblem(outcome.reason);
  }

  return (
    <div>
      <div className="mt-3 flex gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Machine name"
          placeholder={suggested}
          disabled={busy}
        />
        <Button onClick={() => void claim()} disabled={busy || trimmed.length === 0}>
          {busy ? 'Saving…' : adopting || trimmed === knownAs ? 'Take it back' : 'Use this name'}
        </Button>
      </div>

      {adopting ? (
        <p className="text-muted-foreground mt-2 text-xs">
          This office already knows a machine called <strong>{trimmed}</strong>.
          Using that name moves it onto this computer
          {adopting.agents > 0
            ? `, and the ${countOf(adopting.agents)} assigned to it keep working`
            : ''}
          .
        </p>
      ) : knownAs !== null && trimmed === knownAs ? (
        <p className="text-muted-foreground mt-2 text-xs">
          This computer was registered here as <strong>{knownAs}</strong>.
          Registering under that name again takes it back.
        </p>
      ) : known.length > 0 ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          <strong>{trimmed}</strong> is a new machine. Agents are assigned to a
          machine by name, so anything pinned to another name will not run here.
        </p>
      ) : null}

      {others.length > 0 ? (
        <div className="mt-2">
          <p className="text-muted-foreground text-xs">
            {adopting ? 'Other machines here:' : 'Is this one of these?'}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {others.map((machine) => (
              <button
                key={machine.label}
                type="button"
                disabled={busy}
                onClick={() => setName(machine.label)}
                className="hover:bg-accent rounded-md border px-2 py-1 text-xs disabled:opacity-50"
              >
                {machine.label}
                <span className="text-muted-foreground ml-1">
                  {describe(machine)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {problem ? <p className="mt-2 text-xs text-red-600">{problem}</p> : null}
    </div>
  );
}

/**
 * What is behind a name, in the fewest words that change a decision.
 *
 * The agent count is the load-bearing half: "4 agents" is what tells somebody
 * that this is the machine they are looking for. "registered" earns its place
 * only because taking over a name that is currently live is a different act
 * from reclaiming one that is not.
 */
function describe(machine: KnownMachine): string {
  const parts: string[] = [];
  if (machine.agents > 0) parts.push(countOf(machine.agents));
  if (machine.registered) parts.push('registered');
  return parts.length > 0 ? `· ${parts.join(' · ')}` : '';
}

function countOf(agents: number): string {
  return agents === 1 ? '1 agent' : `${agents} agents`;
}
