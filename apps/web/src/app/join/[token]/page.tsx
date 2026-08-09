import { checkInviteLink, getDb, type InviteRejection } from '@quintal/shared/db';
import Link from 'next/link';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import { GuestEntry } from './GuestEntry';

// A link's validity is a fact about right now; never prerender it.
export const dynamic = 'force-dynamic';

const REFUSALS: Record<InviteRejection, string> = {
  unknown: 'This link is not one of ours, or it has been deleted.',
  revoked: 'This link was revoked by whoever created it.',
  expired: 'This link has expired. Ask for a fresh one.',
  exhausted: 'This link has already been used as many times as it allows.',
};

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const check = await checkInviteLink(getDb(), token);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <Card>
        {check.ok ? (
          <>
            <CardHeader>
              <CardTitle>You&apos;ve been invited</CardTitle>
              <CardDescription>
                Walk in as a guest. We&apos;ll mint a key for this visit — it
                lives in this tab and nowhere else, and you can trade it for a
                real identity later.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/*
                The token is handed to the client so it can be presented with
                the signature: one redemption, at the moment a guest actually
                arrives, rather than one here and another on the way in.
              */}
              <GuestEntry token={token} />
            </CardContent>
          </>
        ) : (
          <>
            <CardHeader>
              <CardTitle>This link doesn&apos;t work</CardTitle>
              <CardDescription>{REFUSALS[check.reason]}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                href="/login"
                className="text-sm underline underline-offset-4"
              >
                Sign in with a key instead
              </Link>
            </CardContent>
          </>
        )}
      </Card>
    </main>
  );
}
