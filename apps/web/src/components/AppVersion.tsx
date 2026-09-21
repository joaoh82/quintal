'use client';

import { HEALTH_PATH } from '@quintal/shared';
import { useEffect, useState } from 'react';

import { useHost } from '@/lib/use-host';
import { versionParts } from '@/lib/version';

/**
 * Which version this is.
 *
 * Quintal never used to say. The number is in every manifest and in the release
 * tag, and the only way to read it off a running copy was Finder → Get Info —
 * which is a poor thing to ask of somebody reporting a bug, and impossible to
 * ask of somebody deciding whether to update.
 *
 * Two numbers, because there are two programs: the app, installed once from a
 * DMG, and the office, a server that may be older and may not be theirs. They
 * are shown together only when they differ; `lib/version.ts` holds that rule
 * and is where it is tested.
 *
 * Renders nothing until it knows, and nothing at all if it never finds out. A
 * version line is furniture — it must never become the thing that reports an
 * error, and a flash of "unknown" would be worse than the silence.
 */
export function AppVersion({ className }: { className?: string }) {
  const { host, ready } = useHost();
  const [app, setApp] = useState<string | null>(null);
  const [server, setServer] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    let live = true;

    // A browser has no host and so has no app version. That is the answer, not
    // a failure — `useHost` waiting for `ready` is what keeps it from being
    // asked before we know which case we are in.
    void host
      ?.appVersion()
      .then((version) => {
        if (live) setApp(version);
      })
      // Swallowed on purpose. The office could be running against a host too
      // old to answer `app_version`, which is exactly the situation where the
      // rest of the screen still has to work.
      .catch(() => {});

    void fetch(HEALTH_PATH, { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<{ version?: string }>) : null))
      .then((body) => {
        if (live && typeof body?.version === 'string') setServer(body.version);
      })
      .catch(() => {});

    return () => {
      live = false;
    };
  }, [host, ready]);

  const parts = versionParts(app, server);
  if (parts.length === 0) return null;

  return (
    <p className={className ?? 'text-muted-foreground text-xs'}>
      {parts.map((part, index) => (
        <span key={part.label ?? 'only'}>
          {index > 0 ? <span className="mx-1 opacity-60">·</span> : null}
          {part.label ? <span className="mr-1">{part.label}</span> : null}
          <span className="font-mono">{part.version}</span>
        </span>
      ))}
    </p>
  );
}
