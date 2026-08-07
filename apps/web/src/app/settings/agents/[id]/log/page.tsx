import {
  canAdministerAgent,
  findAgentById,
  getDb,
  listAgentEventKinds,
  listAgentEvents,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface LogPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ kind?: string }>;
}

/** Compact one-line summary of a payload — the log is scanned, not read. */
function describe(kind: string, payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return '';
  const data = payload as Record<string, unknown>;

  switch (kind) {
    case 'command.say':
    case 'effect.spoke':
      return typeof data.text === 'string'
        ? `“${data.text}”${typeof data.heardBy === 'number' ? ` · heard by ${data.heardBy}` : ''}`
        : '';
    case 'command.move_to':
      return typeof data.zoneId === 'string'
        ? `zone ${data.zoneId}`
        : `${String(data.x ?? '?')},${String(data.y ?? '?')}`;
    case 'effect.moved':
      return `arrived ${describeTile(data.tile)}${data.zoneId ? ` · ${String(data.zoneId)}` : ''}`;
    case 'command.set_status':
    case 'effect.status_changed':
      return typeof data.status === 'string' ? `“${data.status}”` : '';
    case 'command.memory_set':
    case 'effect.memory_written':
      return `${String(data.slug ?? '?')} · ${String(data.bytes ?? '?')} bytes`;
    case 'command.memory_get':
      return String(data.slug ?? '');
    case 'command.messages_get':
      return `${String(data.scope ?? '')} · n=${String(data.n ?? '')}`;
    case 'command.rejected':
      return `${String(data.code ?? '')}: ${String(data.message ?? '')}`;
    case 'session.connected':
      return data.reconnected === true ? 'reconnected' : `at ${describeTile(data.tile)}`;
    case 'session.revoked':
      return String(data.reason ?? 'revoked');
    default:
      return JSON.stringify(payload).slice(0, 120);
  }
}

function describeTile(tile: unknown): string {
  if (tile && typeof tile === 'object') {
    const point = tile as { x?: unknown; y?: unknown };
    return `${String(point.x ?? '?')},${String(point.y ?? '?')}`;
  }
  return '?';
}

function toneFor(kind: string): string {
  if (kind.startsWith('effect.')) return 'text-emerald-600 dark:text-emerald-400';
  if (kind === 'command.rejected' || kind.startsWith('session.revoked')) return 'text-rose-600';
  if (kind.startsWith('session.')) return 'text-amber-600 dark:text-amber-400';
  return 'text-sky-600 dark:text-sky-400';
}

export default async function AgentLogPage({ params, searchParams }: LogPageProps) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const { id } = await params;
  const { kind } = await searchParams;

  const db = getDb();
  const agent = await findAgentById(db, id);
  if (!agent) notFound();

  // The log names people and quotes what was said in the office. It is not for
  // anyone who merely knows the agent's id.
  const allowed = await canAdministerAgent(db, session.user.id, agent);
  if (!allowed) notFound();

  const [{ events, hasMore }, kinds] = await Promise.all([
    listAgentEvents(db, id, { kind, limit: 100 }),
    listAgentEventKinds(db, id),
  ]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
          <span aria-hidden className="text-sky-500">
            ◆
          </span>
          {agent.name}
        </h1>
        <p className="text-muted-foreground text-xs">
          {agent.ownerName}&rsquo;s · {agent.scopes.join(', ') || 'no scopes'}
          {agent.revokedAt !== null ? ' · revoked' : ''}
        </p>
        <Link
          href="/settings/agents"
          className="ml-auto text-xs underline underline-offset-2"
        >
          All agents
        </Link>
      </header>

      <nav className="flex flex-wrap items-center gap-2 text-xs">
        <Link
          href={`/settings/agents/${id}/log`}
          className={`rounded-full border px-2.5 py-1 ${!kind ? 'bg-foreground text-background' : ''}`}
        >
          everything
        </Link>
        {kinds.map((eventKind) => (
          <Link
            key={eventKind}
            href={`/settings/agents/${id}/log?kind=${encodeURIComponent(eventKind)}`}
            className={`rounded-full border px-2.5 py-1 font-mono ${
              kind === eventKind ? 'bg-foreground text-background' : ''
            }`}
          >
            {eventKind}
          </Link>
        ))}
      </nav>

      {events.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing recorded{kind ? ` for ${kind}` : ''} yet.
        </p>
      ) : (
        <ol className="divide-y rounded-lg border text-sm">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2">
              <time
                className="text-muted-foreground shrink-0 font-mono text-[11px]"
                dateTime={new Date(event.createdAt).toISOString()}
              >
                {new Date(event.createdAt).toLocaleString()}
              </time>
              <span className={`shrink-0 font-mono text-xs ${toneFor(event.kind)}`}>
                {event.kind}
              </span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate">
                {describe(event.kind, event.payload)}
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className="text-muted-foreground text-xs">
        Newest first{hasMore ? ' · older entries exist beyond this page' : ''}. Every
        command an agent sends and every consequence that changed the room is here —
        an agent cannot act without leaving a line.
      </p>
    </main>
  );
}
