'use client';

import {
  attestationTag,
  buildAttestationPreimage,
  generateSecretKey,
  getPublicKeyHex,
  npubEncode,
  nsecEncode,
  parsePubkey,
  truncateNpub,
} from '@quintal/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { identityFromNsec, resolveSigner, signPayload, type Identity } from '@/lib/keys';

/**
 * Give an agent a key of its own, vouched for by you.
 *
 * Everything that matters happens in this browser: the agent's keypair is
 * generated here, the attestation is signed here with whatever signs you in,
 * and the office receives the public half and the signature. The secret is
 * shown once, like a `qa_` key, and then it is gone — the office never had
 * it, so it cannot show it again. Rotating is the same ceremony; the old key
 * stops working when the new one is registered.
 */
export function RegisterKey({
  agentId,
  agentName,
  ownerPubkey,
  currentPubkey,
}: {
  agentId: string;
  agentName: string;
  /** The owner's key, which the attestation must be signed with. */
  ownerPubkey: string;
  /** What is registered now, if anything. */
  currentPubkey: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [needsKey, setNeedsKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nsec, setNsec] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // A key made elsewhere — `quintal-acp keygen`, a keychain — arrives as its
  // npub. Then there is nothing to generate and nothing to show once: the
  // secret was never here.
  const [existing, setExisting] = useState('');
  const [bringOwn, setBringOwn] = useState(false);
  const [registered, setRegistered] = useState<string | null>(null);

  async function register(signer: Identity) {
    if (signer.pubkey !== ownerPubkey) {
      setError(
        `This page can sign as ${truncateNpub(npubEncode(signer.pubkey))}, but ${agentName} belongs to ${truncateNpub(npubEncode(ownerPubkey))}. Sign in with the owner's key to vouch for it.`,
      );
      return;
    }
    const provided = bringOwn ? parsePubkey(existing) : null;
    if (bringOwn && provided === null) {
      setError('That is not an npub or a 64-character hex public key.');
      return;
    }
    const secretKey = provided ? null : generateSecretKey();
    const agentPubkey = provided ?? getPublicKeyHex(secretKey!);
    if (agentPubkey === ownerPubkey) {
      setError('That is your own key. An agent needs one of its own.');
      return;
    }
    const sig = await signPayload(signer, buildAttestationPreimage(agentPubkey));
    const attestation = attestationTag({ ownerPubkey: signer.pubkey, conditions: '', sig });

    const response = await fetch(`/api/agents/${agentId}/credential`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ agentPubkey, attestation }),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        data && typeof data === 'object' && 'error' in data
          ? String((data as { error: unknown }).error)
          : 'Registering the key failed.';
      throw new Error(message);
    }
    if (secretKey) setNsec(nsecEncode(secretKey));
    else setRegistered(npubEncode(agentPubkey));
    setNeedsKey(false);
    setExisting('');
    router.refresh();
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const signer = pasted.trim() ? identityFromNsec(pasted) : await resolveSigner();
      if (!signer) {
        setNeedsKey(true);
        return;
      }
      await register(signer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Registering the key failed.');
    } finally {
      setBusy(false);
      setPasted('');
    }
  }

  if (nsec) {
    return (
      <div className="order-last w-full rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
        <p className="text-sm font-semibold">{agentName} has a key — here is its secret</p>
        <p className="text-muted-foreground mt-1 text-xs">
          This is the only time it will ever be shown. The office holds the public
          half and your signature; the secret exists only here. Put it where{' '}
          {agentName} runs (<code className="font-mono">key</code> in the fleet file,
          or an env var named by <code className="font-mono">keyEnv</code>).
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="bg-background flex-1 overflow-x-auto rounded border px-3 py-2 font-mono text-xs">
            {nsec}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(nsec);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setNsec(null)}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  if (registered) {
    return (
      <span className="order-last w-full text-xs text-emerald-600">
        {agentName} now joins with {truncateNpub(registered)}. Its secret stays where it
        was made.{' '}
        <button type="button" className="underline underline-offset-2" onClick={() => setRegistered(null)}>
          Done
        </button>
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="text-xs underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >
        {currentPubkey ? 'Rotate key' : 'Register a key'}
      </button>
    );
  }

  return (
    <div className="order-last flex w-full flex-wrap items-center gap-2 pt-1">
      <span className="text-muted-foreground text-xs">
        {bringOwn
          ? `${agentName}'s existing key, vouched for by yours.${currentPubkey ? ' The current one stops working.' : ''}`
          : currentPubkey
            ? `A new keypair for ${agentName}; the current one stops working.`
            : `A keypair for ${agentName}, generated here and vouched for by your key.`}
      </span>
      {bringOwn ? (
        <Input
          value={existing}
          onChange={(event) => setExisting(event.target.value)}
          placeholder="npub1… — the key it already has"
          className="h-7 w-72 font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <button
          type="button"
          className="text-muted-foreground text-xs underline-offset-2 hover:underline"
          onClick={() => setBringOwn(true)}
        >
          I already have a key
        </button>
      )}
      {needsKey ? (
        <Input
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          placeholder="nsec1… — your key, to sign the attestation"
          className="h-7 w-72 font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
      ) : null}
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void start()}>
        {busy
          ? 'Signing…'
          : needsKey
            ? 'Sign and register'
            : bringOwn
              ? 'Register this key'
              : 'Generate and register'}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {needsKey && !error ? (
        <span className="text-muted-foreground w-full text-xs">
          Nothing on this page can sign as you. Paste your nsec to sign once; it is
          not kept.
        </span>
      ) : null}
      {error ? (
        <span className="text-destructive w-full text-xs" role="alert">
          {error} If the office registered the key before this failed, the secret is
          gone with it — rotate to get a new one.
        </span>
      ) : null}
    </div>
  );
}
