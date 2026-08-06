'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { signIn } from '@/lib/auth-client';

type Status = 'idle' | 'sending' | 'sent' | 'error';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('sending');
    setMessage('');

    const { error } = await signIn.magicLink({
      email,
      callbackURL: '/office',
    });

    if (error) {
      setStatus('error');
      setMessage(error.message ?? 'Could not send the link. Try again.');
      return;
    }

    setStatus('sent');
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <Card>
        <CardHeader>
          <CardTitle>Sign in to Quintal</CardTitle>
          <CardDescription>
            We&apos;ll email you a one-time link. No password to remember.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {status === 'sent' ? (
            <div className="space-y-3 text-sm">
              <p className="font-medium">Check your inbox.</p>
              <p className="text-muted-foreground">
                We sent a sign-in link to <span className="font-medium">{email}</span>.
                Self-hosting without an email provider? The link is printed in the
                server console.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStatus('idle');
                  setMessage('');
                }}
              >
                Use a different email
              </Button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-3">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={status === 'sending'}
              />
              <Button
                type="submit"
                className="w-full"
                disabled={status === 'sending' || email.length === 0}
              >
                {status === 'sending' ? 'Sending…' : 'Send sign-in link'}
              </Button>
              {status === 'error' ? (
                <p className="text-destructive text-sm" role="alert">
                  {message}
                </p>
              ) : null}
            </form>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-6 text-center text-sm">
        <Link href="/" className="hover:text-foreground underline-offset-4 hover:underline">
          Back to the landing page
        </Link>
      </p>
    </main>
  );
}
