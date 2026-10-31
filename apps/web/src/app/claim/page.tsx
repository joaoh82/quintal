import { displayName, npubEncode, personalMode } from '@quintal/shared';
import { checkClaimToken, getDb, type ClaimCheck } from '@quintal/shared/db';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CLAIM_REFUSALS } from '@/lib/auth/keypair';
import { requestSession } from '@/lib/session';

import { claimAsSignedIn } from './actions';

// Whether a link still works is a fact about right now; never prerender it.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Claim this office · Quintal' };

/**
 * `/claim?t=…` — where the link a fresh server prints on boot lands.
 *
 * Looked up here so a dead link says so before anybody signs anything. The
 * claim itself happens with the signature (`claimToken` on sign-in) or, for
 * somebody already signed in, through `claimAsSignedIn` — both redeem the link
 * atomically, so this check is for the words on the page, not the gate.
 */
export default async function ClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { t } = await searchParams;
  const token = typeof t === 'string' ? t : '';
  const check: ClaimCheck | { ok: false; reason: 'personal' } = personalMode()
    ? { ok: false, reason: 'personal' }
    : await checkClaimToken(getDb(), token);
  const session = check.ok ? await requestSession() : null;
  const member = session && !session.session.isGuest ? session.user : null;
  const signInHref = `/login?claim=${encodeURIComponent(token)}`;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <Card>
        {check.ok ? (
          <>
            <CardHeader>
              <CardTitle>Claim this office</CardTitle>
              <CardDescription>
                Nobody runs this server yet. Whoever claims it becomes its
                admin: they name it and change its instance-wide settings.
                The link works once.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {member ? (
                <>
                  <p className="text-sm">
                    You are signed in as <strong>{displayName(member)}</strong>
                  </p>
                  <p className="text-muted-foreground font-mono text-xs break-all">
                    {npubEncode(member.pubkey)}
                  </p>
                  <form action={claimAsSignedIn.bind(null, token)}>
                    <Button type="submit" className="w-full">
                      Claim it with this key
                    </Button>
                  </form>
                  <Button asChild variant="outline" className="w-full">
                    <Link href={signInHref}>Use a different key</Link>
                  </Button>
                </>
              ) : (
                <Button asChild className="w-full">
                  <Link href={signInHref}>Sign in to claim it</Link>
                </Button>
              )}
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <CardTitle>This link doesn&apos;t work</CardTitle>
              <CardDescription>{CLAIM_REFUSALS[check.reason]}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/login" className="text-sm underline underline-offset-4">
                Sign in
              </Link>
            </CardContent>
          </>
        )}
      </Card>
    </main>
  );
}
