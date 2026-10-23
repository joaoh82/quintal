'use client';

import {
  sealMcpSecret,
  validateMcpServers,
  type AgentMcpServer,
  type McpServerStatus,
  type McpTransport,
  type McpVar,
} from '@quintal/shared';
import type { AgentListEntry } from '@quintal/shared/db';
import { startTransition, useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { saveAgentMcpServersAction, type SaveAgentMcpServersState } from './actions';

/**
 * The agent's own MCP servers: Slack, Linear, a local tool.
 *
 * Saved here, they reach the agent on whatever machine runs it — its runtime
 * reloads with them within seconds and keeps its conversations — so giving an
 * agent a tool no longer means a terminal on that machine.
 *
 * A secret (an API key, a token header) is sealed in this browser to the
 * agent's own public key before it is sent. The office stores ciphertext it
 * cannot read; only the agent's harness can open it. Which is also why a
 * secret cannot be shown again here: edit it by entering it anew.
 */

interface VarDraft {
  name: string;
  value: string;
  secret: boolean;
}

const EMPTY_VAR: VarDraft = { name: '', value: '', secret: true };

export function AgentMcpForm({ agent }: { agent: AgentListEntry }) {
  const [state, formAction, pending] = useActionState(saveAgentMcpServersAction, {
    ok: false,
  } as SaveAgentMcpServersState);
  const mine = state.agentId === agent.id;
  const [localError, setLocalError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sealing, setSealing] = useState(false);

  const [transport, setTransport] = useState<McpTransport>('http');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [vars, setVars] = useState<VarDraft[]>([]);

  const canSeal = agent.pubkey !== null;
  const busy = pending || sealing;
  const status = new Map(agent.mcpStatus.map((entry) => [entry.name, entry]));

  function save(servers: AgentMcpServer[]): boolean {
    const checked = validateMcpServers(servers);
    if (!checked.ok) {
      setLocalError(checked.error);
      return false;
    }
    setLocalError(null);
    const form = new FormData();
    form.set('agentId', agent.id);
    form.set('servers', JSON.stringify(checked.servers));
    startTransition(() => formAction(form));
    return true;
  }

  function remove(server: string) {
    save(agent.mcpServers.filter((entry) => entry.name !== server));
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setSealing(true);
    try {
      const filled = vars.filter((entry) => entry.name.trim().length > 0);
      const sealed: McpVar[] = [];
      for (const entry of filled) {
        const varName = entry.name.trim();
        sealed.push(
          entry.secret && agent.pubkey
            ? { name: varName, sealed: await sealMcpSecret(agent.pubkey, varName, entry.value) }
            : { name: varName, value: entry.value },
        );
      }
      const server: AgentMcpServer =
        transport === 'http'
          ? { name: name.trim(), transport, url: url.trim(), ...(sealed.length ? { headers: sealed } : {}) }
          : {
              name: name.trim(),
              transport,
              command: command.trim(),
              ...(args.trim() ? { args: args.split('\n').map((arg) => arg.trim()).filter(Boolean) } : {}),
              ...(sealed.length ? { env: sealed } : {}),
            };
      if (save([...agent.mcpServers, server])) {
        setAdding(false);
        setName('');
        setUrl('');
        setCommand('');
        setArgs('');
        setVars([]);
      }
    } catch (error: unknown) {
      setLocalError(error instanceof Error ? error.message : 'Could not seal that value.');
    } finally {
      setSealing(false);
    }
  }

  const error = localError ?? (mine ? state.error : undefined);

  return (
    <div className="mt-2 flex flex-col gap-3">
      {agent.mcpServers.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No MCP servers yet. Add one and {agent.name} has it within seconds, on whichever machine runs it.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {agent.mcpServers.map((server) => (
            <li key={server.name} className="flex flex-col gap-1 rounded border px-2 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{server.name}</span>
                <span className="text-muted-foreground truncate font-mono">
                  {server.transport === 'http' ? server.url : [server.command, ...(server.args ?? [])].join(' ')}
                </span>
                <span className="ml-auto" />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => remove(server.name)}
                >
                  Remove
                </Button>
              </div>
              <ServerStatus status={status.get(server.name)} />
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form onSubmit={add} className="flex flex-col gap-2 rounded border px-2 py-2">
          <fieldset className="flex gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input type="radio" checked={transport === 'http'} onChange={() => setTransport('http')} />
              Hosted (URL)
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={transport === 'stdio'} onChange={() => setTransport('stdio')} />
              Local command
            </label>
          </fieldset>
          <Input placeholder="name, e.g. slack" value={name} onChange={(event) => setName(event.target.value)} />
          {transport === 'http' ? (
            <>
              <Input
                placeholder="https://mcp.slack.com/mcp"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Most hosted servers sign in with OAuth: the link appears here once {agent.name} starts it. A
                server that wants a token instead takes it as a header below.
              </p>
            </>
          ) : (
            <>
              <Input
                placeholder="command, e.g. npx"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
              <textarea
                className="border-input min-h-16 rounded-md border bg-transparent px-3 py-1.5 font-mono text-xs"
                placeholder={'arguments, one per line\n-y\n@modelcontextprotocol/server-github'}
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
              {agent.scopes.includes('run') ? null : (
                <p className="text-xs text-amber-600">
                  A local server runs a program on {agent.name}&rsquo;s machine, so it is started only once{' '}
                  {agent.name} has the <span className="font-mono">run</span> scope.
                </p>
              )}
            </>
          )}

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">
              {transport === 'http' ? 'Headers' : 'Environment variables'}
            </span>
            {vars.map((entry, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <Input
                  className="font-mono"
                  placeholder={transport === 'http' ? 'Authorization' : 'API_KEY'}
                  value={entry.name}
                  onChange={(event) =>
                    setVars(vars.map((other, at) => (at === index ? { ...other, name: event.target.value } : other)))
                  }
                />
                <Input
                  type={entry.secret ? 'password' : 'text'}
                  placeholder="value"
                  value={entry.value}
                  onChange={(event) =>
                    setVars(vars.map((other, at) => (at === index ? { ...other, value: event.target.value } : other)))
                  }
                />
                <label className="flex items-center gap-1 text-xs" title={canSeal ? '' : 'Register a key for this agent first'}>
                  <input
                    type="checkbox"
                    checked={entry.secret && canSeal}
                    disabled={!canSeal}
                    onChange={(event) =>
                      setVars(vars.map((other, at) => (at === index ? { ...other, secret: event.target.checked } : other)))
                    }
                  />
                  secret
                </label>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setVars([...vars, { ...EMPTY_VAR, secret: canSeal }])}
            >
              + {transport === 'http' ? 'header' : 'variable'}
            </Button>
            <p className="text-muted-foreground text-xs">
              {canSeal
                ? `A secret is sealed in this browser to ${agent.name}’s own key: the office stores what only ${agent.name} can open, and it cannot be shown here again.`
                : `${agent.name} has no key of its own yet, so values are stored as written. Register a key to keep secrets sealed.`}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
              {busy ? 'Saving…' : 'Add server'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => setAdding(true)}>
          Add an MCP server
        </Button>
      )}

      {mine && state.ok && !localError ? (
        <span className="text-xs text-emerald-600">Saved — {agent.name} reloads with it within seconds.</span>
      ) : null}
      {error ? (
        <span className="text-destructive text-xs" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** What the agent's harness last said about one server. */
function ServerStatus({ status }: { status: McpServerStatus | undefined }) {
  if (!status) {
    return <span className="text-muted-foreground">Not picked up yet — the agent is offline, or about to reload.</span>;
  }
  if (status.state === 'ready') return <span className="text-emerald-600">Handed to the agent&rsquo;s runtime.</span>;
  if (status.state === 'skipped') return <span className="text-amber-600">Left out: {status.reason}</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-amber-600">Waiting for you to sign in.</span>
      {status.signInUrl ? (
        <a
          href={status.signInUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium underline underline-offset-2"
        >
          Sign in
        </a>
      ) : null}
      <span className="text-muted-foreground">
        Open it on the machine that runs the agent: the sign-in finishes there.
      </span>
    </span>
  );
}
