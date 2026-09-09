'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describeHostFailure } from '@/lib/host';
import { useHost } from '@/lib/use-host';

/**
 * The key that talks while some other window has the keyboard.
 *
 * Only in the app: a browser tab cannot hear a key it does not have. Written
 * the way the system names chords — `CommandOrControl+Shift+Space`,
 * `Alt+Space` — and refused, unchanged, when the system will not register
 * it. Empty puts the default back.
 */
export function PushToTalkField() {
  const { host, ready } = useHost();
  const [chord, setChord] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!host) return;
    void host
      .pushToTalkChord()
      .then((current) => {
        setChord(current);
        setSaved(current);
      })
      .catch(() => setSaved(null));
  }, [host]);

  if (!ready || !host) return null;

  async function save() {
    if (!host) return;
    setBusy(true);
    setProblem(null);
    try {
      const stored = await host.setPushToTalkChord(chord);
      setChord(stored);
      setSaved(stored);
    } catch (error: unknown) {
      setProblem(describeHostFailure(error));
    }
    setBusy(false);
  }

  return (
    <section className="space-y-2 rounded-lg border p-4">
      <h2 className="text-sm font-medium">Push-to-talk, anywhere</h2>
      <p className="text-muted-foreground text-xs">
        Hold this while another window has the keyboard and the office hears you,
        the same as holding Space in it. Written the way the system names keys:{' '}
        <code className="font-mono">CommandOrControl+Shift+Space</code>,{' '}
        <code className="font-mono">Alt+Space</code>. Leave it empty for the default.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={chord}
          onChange={(event) => setChord(event.target.value)}
          placeholder="CommandOrControl+Shift+Space"
          className="w-72 font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {saved !== null && saved === chord && !problem ? (
          <span className="text-muted-foreground text-xs">In force: {saved}</span>
        ) : null}
        {problem ? (
          <span className="text-destructive text-xs" role="alert">
            {problem}
          </span>
        ) : null}
      </div>
    </section>
  );
}
