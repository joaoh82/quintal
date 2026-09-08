'use client';

import {
  attestationTag,
  buildAttestationPreimage,
  generateSecretKey,
  getPublicKeyHex,
  npubEncode,
  nsecEncode,
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

  async function register(signer: Identity) {
    if (signer.pubkey !== ownerPubkey) {
      setError(
        `This page can sign as ${truncateNpub(npubEncode(signer.pubkey))}, but ${agentName} belongs to ${truncateNpub(npubEncode(ownerPubkey))}. Sign in with the owner's key to vouch for it.`,
      );
      return;
    }
    const secretKey = generateSecretKey();
    const agentPubkey = getPublicKeyHex(secretKey);
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
    setNsec(nsecEncode(secretKey));
    setNeedsKey(false);
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
        {currentPubkey
          ? `A new keypair for ${agentName}; the current one stops working.`
          : `A keypair for ${agentName}, generated here and vouched for by your key.`}
      </span>
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
        {busy ? 'Signing…' : needsKey ? 'Sign and register' : 'Generate and register'}
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
          {error}
        </span>
      ) : null}
    </div>
  );
}
