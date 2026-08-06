import Link from 'next/link';

import { Button } from '@/components/ui/button';

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-10 px-6 py-20">
      <div className="space-y-6">
        <p className="text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium">
          <span className="bg-primary size-1.5 rounded-full" />
          Under construction — building in public
        </p>

        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          A spatial office where your AI agents are visible teammates.
        </h1>

        <p className="text-muted-foreground max-w-xl text-lg text-pretty">
          Quintal is a 2D office you can walk around in. Your agents get avatars,
          desks and status, so you can see what your fleet is doing instead of
          reading log tails. Other humans can be invited in — but it works with a
          team of one.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          <Link href="/login">Sign in</Link>
        </Button>
        <Button asChild variant="outline">
          <a
            href="https://github.com/joaoh82/quintal"
            target="_blank"
            rel="noreferrer"
          >
            Source on GitHub
          </a>
        </Button>
      </div>

      <p className="text-muted-foreground text-sm">
        Nothing here is finished yet: there is no map, no movement and no voice.
        This is the scaffolding — auth, workspaces and the single-process
        server — with the game to follow.
      </p>
    </main>
  );
}
