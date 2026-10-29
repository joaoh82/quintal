'use client';

import type { OfficeGithubRef } from '@quintal/shared';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { removeGithubTokenAction, saveGithubTokenAction, type GithubState } from './github-actions';

/**
 * The office's GitHub, on the settings page.
 *
 * One token for the office, held by the server: it polls the ledger's pull
 * requests with it and acts on them when a member presses a button on the
 * board. The page never sees the token again — it shows whose it is, who
 * put it there, and whether GitHub still accepts it. A member who is not an
 * owner or admin reads this and changes nothing.
 */
export function GithubCard({ github, canManage }: { github: OfficeGithubRef; canManage: boolean }) {
  const [saved, save, saving] = useActionState(saveGithubTokenAction, { ok: false } satisfies GithubState);
  const [removed, remove, removing] = useActionState(removeGithubTokenAction, { ok: false } satisfies GithubState);
  const current = removed.github ?? saved.github ?? github;
  const error = saving || removing ? null : (saved.error ?? removed.error ?? null);

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-sm font-semibold">GitHub</h2>
      <p className="text-muted-foreground mt-1 max-w-2xl text-xs">
        A token the office uses to check the ledger’s pull requests — checks, mergeability, the
        review — and to merge, update or close them from the board. One per office, kept on the
        server, never shown again. A fine-grained token with <em>Pull requests: read and write</em>{' '}
        and <em>Contents: read and write</em> on the repositories your agents work in is enough;
        what each member may do with it is what GitHub lets the token do.
      </p>

      <div className="mt-3 flex flex-col gap-1 border-t py-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="sm:w-64 sm:shrink-0">
          <p className="text-sm font-medium">Connected as</p>
          <p className="text-muted-foreground mt-0.5 text-xs">Whose token this is, as GitHub said when it was saved.</p>
        </div>
        <div className="text-sm">
          {current.connected ? (
            <>
              <p>
                <span className="font-mono">@{current.login}</span>
                {current.setByName ? <span className="text-muted-foreground text-xs"> — put here by {current.setByName}</span> : null}
              </p>
              {current.lastError ? (
                <p className="mt-1 text-xs text-red-600">GitHub last refused it: {current.lastError}</p>
              ) : (
                <p className="text-muted-foreground mt-1 text-xs">
                  {current.lastCheckedAt ? 'Working, as of the office’s last look.' : 'Not tried by the office yet.'}
                </p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">Not connected. The board shows what agents report, and nothing can be merged from it.</p>
          )}
        </div>
      </div>

      {canManage ? (
        <div className="flex flex-col gap-1 border-t py-4 sm:flex-row sm:items-start sm:gap-6">
          <div className="sm:w-64 sm:shrink-0">
            <label htmlFor="github-token" className="text-sm font-medium">
              {current.connected ? 'Replace the token' : 'Token'}
            </label>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Tried against GitHub before it is kept. The office starts using it within a minute.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <form action={save} className="flex flex-wrap items-center gap-2">
              <Input
                id="github-token"
                name="token"
                type="password"
                autoComplete="off"
                placeholder="github_pat_…"
                required
                className="w-72 font-mono"
              />
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? 'Checking…' : current.connected ? 'Replace' : 'Connect'}
              </Button>
              {current.connected ? (
                <Button type="submit" size="sm" variant="outline" formAction={remove} disabled={removing}>
                  {removing ? 'Removing…' : 'Remove'}
                </Button>
              ) : null}
            </form>
            {error ? <p className="text-xs text-red-600">{error}</p> : null}
            {!error && (saved.ok || removed.ok) ? (
              <p className="text-muted-foreground text-xs">{current.connected ? `Saved. Connected as @${current.login}.` : 'Removed. The office checks nothing with GitHub now.'}</p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground border-t pt-4 text-xs">The office’s owner or an admin connects or replaces the token.</p>
      )}
    </section>
  );
}
