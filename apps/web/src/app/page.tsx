import Link from 'next/link';

import { ExternalLink } from '@/components/ExternalLink';
import { Button } from '@/components/ui/button';
import { WhichServer } from '@/components/WhichServer';
import { Wordmark } from '@/components/Wordmark';

const REPO = 'https://github.com/joaoh82/quintal';

/**
 * The first page of an instance, before anybody has signed in.
 *
 * Says what this is in the words the website uses, and which server this
 * is — somebody arriving at a URL has to recognise the place. Nothing here
 * needs a session, and nothing here is a feature: the office is behind the
 * sign-in.
 */
export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col px-6 py-8">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Wordmark size="md" />
        <nav className="text-muted-foreground flex items-center gap-5 text-sm">
          <ExternalLink className="hover:text-foreground" href="https://quintal.sh/docs/">
            Docs
          </ExternalLink>
          <ExternalLink className="hover:text-foreground" href={REPO}>
            GitHub ↗
          </ExternalLink>
        </nav>
        <WhichServer className="text-muted-foreground ml-auto text-xs" />
      </header>

      <section className="flex flex-1 flex-col justify-center gap-8 py-16">
        <p className="eyebrow">
          <span aria-hidden="true">◆</span> An open source spatial office
        </p>
        <h1 className="max-w-3xl text-5xl leading-[1.02] font-medium tracking-[-0.05em] text-balance sm:text-7xl">
          Your agents.
          <br />
          In the <span className="text-primary">same room.</span>
        </h1>
        <p className="text-muted-foreground max-w-md text-lg text-pretty">
          A place to see your coding agents, walk up and talk, and get back to
          building.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <Button asChild size="lg">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <ExternalLink href="https://quintal.sh/docs/getting-started/">Get started</ExternalLink>
          </Button>
        </div>

        <dl className="text-muted-foreground grid max-w-2xl gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-foreground font-medium">Agents as members</dt>
            <dd>Claude Code, Codex, Goose and anything that speaks ACP, with a body in the room.</dd>
          </div>
          <div>
            <dt className="text-foreground font-medium">Your key, your identity</dt>
            <dd>No accounts, no email, no passwords. Sign in by signing a challenge.</dd>
          </div>
          <div>
            <dt className="text-foreground font-medium">One process to run</dt>
            <dd>Node, one port, one SQLite file. Open source, AGPL, built in public.</dd>
          </div>
        </dl>
      </section>

      <footer className="text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-2 border-t pt-4 text-xs">
        <span>Open source. Built in public.</span>
        <ExternalLink className="hover:text-foreground" href="https://quintal.sh">
          quintal.sh
        </ExternalLink>
        <ExternalLink className="hover:text-foreground" href={`${REPO}/blob/main/SELF_HOSTING.md`}>
          Self-hosting
        </ExternalLink>
        <ExternalLink className="hover:text-foreground" href={`${REPO}/blob/main/LICENSE-FAQ.md`}>
          AGPL-3.0
        </ExternalLink>
      </footer>
    </main>
  );
}
