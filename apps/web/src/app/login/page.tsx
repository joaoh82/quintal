'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  getHost,
  hostPromptFor,
  isHostError,
  type IdentityState,
} from '@/lib/host';
import {
  createIdentity,
  forgetSavedNsec,
  identityFromHost,
  hasExtension,
  identityFromExtension,
  identityFromNsec,
  loadSavedNsec,
  npubFor,
  saveNsec,
  signIn,
  storageActionFor,
  type Identity,
} from '@/lib/keys';

type Mode = 'choose' | 'created' | 'import';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('choose');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [nsecInput, setNsecInput] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [extension, setExtension] = useState(false);
  /** Null while we are still asking the host, or when there is no host. */
  const [hostKey, setHostKey] = useState<IdentityState | null>(null);
  /** Set when the host did not answer at all — distinct from a bad answer. */
  const [hostError, setHostError] = useState<string | null>(null);
  const [asking, setAsking] = useState(true);
  const [askedAt, setAskedAt] = useState(0);
  // Only true for a key we loaded back out of storage — a key generated a
  // moment ago has nothing to forget yet.
  const [wasSaved, setWasSaved] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);

  // `window.nostr` is injected by an extension, which may not have run by the
  // time this component first renders — so it is checked after mount, not
  // during it.
  useEffect(() => {
    setExtension(hasExtension());
  }, []);

  // Inside the app, the key on this machine is the way in. Asked once on mount
  // rather than assumed, because "the app is hosting" and "the app can reach
  // its keychain" are different questions and the second has three answers.
  useEffect(() => {
    const host = getHost();
    if (!host) {
      setAsking(false);
      return;
    }
    let live = true;
    setAsking(true);
    void host
      .hasIdentity()
      .then((state) => {
        if (!live) return;
        setHostKey(state);
        setHostError(null);
      })
      .catch((cause: unknown) => {
        // NOT `locked`. `has_identity` cannot fail on the host side — it
        // returns a state, not a result — so a rejection means the question
        // never arrived. Calling that a locked keychain states something
        // false and disables the only button that gets anyone moving.
        if (!live) return;
        setHostKey(null);
        setHostError(
          cause instanceof Error ? cause.message : 'This computer did not answer.',
        );
      })
      .finally(() => {
        if (live) setAsking(false);
      });
    return () => {
      live = false;
    };
  }, [askedAt]);

  // Somebody who saved a key here last time should not have to paste it again.
  //
  // Skipped inside the app: the host holds a better copy of a key than
  // localStorage does, and restoring one here would hide it behind the tier it
  // exists to retire.
  useEffect(() => {
    if (getHost()) return;
    const saved = loadSavedNsec();
    if (!saved) return;
    try {
      setIdentity(identityFromNsec(saved));
      setMode('created');
      setRemember(true);
      setWasSaved(true);
    } catch {
      // A corrupted entry is not worth surfacing; the choices below still work.
    }
  }, []);

  async function enter(withIdentity: Identity, persist: boolean) {
    setBusy(true);
    setError('');
    try {
      // See `storageActionFor` — unticking must remove the key it describes,
      // and must not touch one belonging to a different identity.
      const action = storageActionFor({
        identity: withIdentity,
        persist,
        saved: loadSavedNsec(),
      });
      if (action === 'save' && withIdentity.kind === 'local') {
        saveNsec(withIdentity.nsec);
      } else if (action === 'forget') {
        forgetSavedNsec();
      }
      await signIn(withIdentity);
      router.push('/office');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in.');
      setBusy(false);
    }
  }

  function onCreate() {
    setIdentity(createIdentity());
    setMode('created');
    setError('');
  }

  async function onUseHostKey() {
    setError('');
    setBusy(true);
    try {
      await signIn(await identityFromHost());
      router.push('/office');
    } catch (cause: unknown) {
      setError(
        isHostError(cause) && cause.code === 'locked'
          ? 'This computer holds your key but the keychain is locked. Unlock it and try again — do not create a new identity, or you will lose this one.'
          : cause instanceof Error
            ? cause.message
            : 'Could not use this computer\'s key.',
      );
      setBusy(false);
    }
  }

  async function onUseExtension() {
    setError('');
    try {
      await enter(await identityFromExtension(), false);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : 'The extension refused.',
      );
    }
  }

  async function onImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    let imported: Identity;
    try {
      imported = identityFromNsec(nsecInput);
    } catch {
      setError('That does not look like an nsec. It starts with “nsec1”.');
      return;
    }
    // Inside the app the key belongs in the keychain, not in this page and
    // certainly not in localStorage. Hand it to the host and sign in with it.
    const host = getHost();
    if (host) {
      setBusy(true);
      try {
        await host.importIdentity(nsecInput.trim());
        await signIn(await identityFromHost());
        router.push('/office');
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : 'Could not import that key.');
        setBusy(false);
      }
      return;
    }

    await enter(imported, remember);
  }

  const prompt = hostPromptFor({
    hosted: Boolean(getHost()),
    asking,
    state: hostKey,
    error: hostError,
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
      <Card>
        <CardHeader>
          <CardTitle>Sign in to Quintal</CardTitle>
          <CardDescription>
            Your identity is a key you hold, not an account we keep. There is
            nothing to remember and no address to verify.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {mode === 'choose' ? (
            <div className="space-y-3">
              {prompt.kind === 'locked' ? (
                <div className="border-destructive/40 bg-destructive/5 space-y-2 rounded-md border p-3">
                  <p className="text-sm font-medium">Your keychain is locked.</p>
                  <p className="text-muted-foreground text-xs">
                    This computer is holding your key and cannot open it. Unlock
                    the keychain and reopen Quintal.{' '}
                    <strong>Do not create a new identity</strong> — it would be a
                    different person, and this one would be gone.
                  </p>
                </div>
              ) : null}

              {prompt.kind === 'unreachable' ? (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-sm font-medium">
                    This computer didn&apos;t answer.
                  </p>
                  <p className="text-muted-foreground text-xs">
                    We couldn&apos;t ask about the key it holds, so we don&apos;t
                    know whether there is one. That is different from your
                    keychain being locked, and it is usually worth another try.
                  </p>
                  <p className="text-muted-foreground font-mono text-[11px] break-all">
                    {prompt.message}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setAskedAt(Date.now())}
                  >
                    Try again
                  </Button>
                </div>
              ) : null}

              {prompt.kind === 'ready' || prompt.kind === 'create' ? (
                <Button className="w-full" onClick={onUseHostKey} disabled={busy}>
                  {busy
                    ? 'Signing in…'
                    : prompt.kind === 'ready'
                      ? "Continue with this computer's key"
                      : 'Create identity on this computer'}
                </Button>
              ) : null}

              <Button
                className="w-full"
                variant={prompt.kind === 'browser' ? 'default' : 'outline'}
                onClick={onCreate}
                // Blocked only while the host is still being asked, or when it
                // has actually said `locked`. An unanswered question leaves
                // this open on purpose: stuck behind a guess is worse than a
                // second identity somebody can sign out of.
                disabled={busy || prompt.kind === 'locked' || prompt.kind === 'asking'}
              >
                Create identity{prompt.kind === 'browser' ? '' : ' in this window instead'}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setMode('import')}
                disabled={busy}
              >
                I have a key
              </Button>
              {extension ? (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={onUseExtension}
                  disabled={busy}
                >
                  Use my signing extension
                </Button>
              ) : null}
            </div>
          ) : null}

          {mode === 'created' && identity ? (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">This is you.</p>
                <p className="text-muted-foreground font-mono text-xs break-all">
                  {npubFor(identity)}
                </p>
              </div>

              {identity.kind === 'local' ? (
                <details className="rounded-md border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">
                    Show secret key (nsec)
                  </summary>
                  <p className="text-muted-foreground mt-2 text-xs">
                    Anyone with this can be you. Put it in a password manager.
                    We cannot reset it, because we never had it.
                  </p>
                  <p className="mt-2 font-mono text-xs break-all">
                    {identity.nsec}
                  </p>
                </details>
              ) : null}

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                  disabled={busy}
                />
                <span>
                  Save this key to this browser
                  <span className="text-muted-foreground block text-xs">
                    Low security: stored in this browser&apos;s localStorage,
                    where any script running on this site could read it. It is
                    here so you can come back tomorrow. The desktop app will
                    hold keys properly.
                  </span>
                </span>
              </label>

              <Button
                className="w-full"
                onClick={() => void enter(identity, remember)}
                disabled={busy}
              >
                {busy ? 'Signing in…' : 'Enter the office'}
              </Button>

              {wasSaved ? (
                <div className="border-t pt-3">
                  {confirmForget ? (
                    <div className="space-y-2">
                      <p className="text-destructive text-sm font-medium">
                        Forget this key?
                      </p>
                      <p className="text-muted-foreground text-xs">
                        This browser holds the only copy we know of. If you
                        haven&apos;t saved the nsec somewhere else, this
                        identity — and the office behind it — is gone for good.
                        We cannot reissue it.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            forgetSavedNsec();
                            setIdentity(null);
                            setWasSaved(false);
                            setConfirmForget(false);
                            setRemember(false);
                            setMode('choose');
                          }}
                        >
                          Forget it
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmForget(false)}
                        >
                          Keep it
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmForget(true)}
                      disabled={busy}
                    >
                      Use a different identity
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {mode === 'import' ? (
            <form onSubmit={onImport} className="space-y-3">
              <label htmlFor="nsec" className="text-sm font-medium">
                Secret key
              </label>
              <Input
                id="nsec"
                type="password"
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="nsec1…"
                value={nsecInput}
                onChange={(event) => setNsecInput(event.target.value)}
                disabled={busy}
              />
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                  disabled={busy}
                />
                <span>
                  Save this key to this browser
                  <span className="text-muted-foreground block text-xs">
                    Low security — see above. Leave it off on a shared machine.
                  </span>
                </span>
              </label>
              <Button
                type="submit"
                className="w-full"
                disabled={busy || nsecInput.length === 0}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
              {extension ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={onUseExtension}
                  disabled={busy}
                >
                  Use my signing extension instead
                </Button>
              ) : null}
            </form>
          ) : null}

          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}

          {mode !== 'choose' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMode('choose');
                setError('');
              }}
              disabled={busy}
            >
              ← Other ways in
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <p className="text-muted-foreground mt-6 text-center text-sm">
        <Link
          href="/"
          className="hover:text-foreground underline-offset-4 hover:underline"
        >
          Back to the landing page
        </Link>
      </p>
    </main>
  );
}
