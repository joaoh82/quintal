import { displayNameFromPubkey } from '@quintal/shared';

/**
 * One line per audit row. The log is scanned, not read, so each kind gets
 * the two or three words that tell it apart from its neighbours — and the
 * connect row says which credential opened the door, because that is the
 * fact an owner needs before turning the old doors off.
 */
export function describe(kind: string, payload: unknown): string {
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
    case 'command.board_list':
      return `${typeof data.status === 'string' ? data.status : 'every column'}${data.mine === true ? ' · mine' : ''}`;
    case 'command.board_get':
      return `#${String(data.number ?? '?')}`;
    case 'command.board_create':
      return `#${String(data.number ?? '?')} “${String(data.title ?? '')}”${
        typeof data.assignee === 'string' ? ` · for ${data.assignee}` : ''
      }`;
    case 'command.board_update':
      return `#${String(data.number ?? '?')} · ${asList(data.changed).join(', ') || 'no change'}${
        'assignee' in data ? ` · for ${typeof data.assignee === 'string' ? data.assignee : 'nobody'}` : ''
      }`;
    case 'command.command_list':
      return 'every command';
    case 'command.command_get':
      return `!${String(data.name ?? '?')}`;
    case 'command.command_create':
      return `!${String(data.name ?? '?')}${typeof data.defaultTarget === 'string' ? ` · for ${data.defaultTarget}` : ''}`;
    case 'command.command_update':
      return `!${String(data.name ?? '?')} · ${asList(data.fields).join(', ') || 'no change'}`;
    case 'routine.fired':
    case 'routine.made_up':
    case 'routine.missed':
    case 'routine.skipped':
      return `“${String(data.name ?? '?')}” · due ${typeof data.dueAt === 'number' ? new Date(data.dueAt).toLocaleString() : '?'}${
        typeof data.reason === 'string' ? ` · ${data.reason}` : ''
      }`;
    case 'effect.task_changed':
      if (typeof data.branch !== 'string') return 'no task';
      return `“${String(data.title ?? '')}” · ${data.branch}${
        typeof data.pr === 'number' ? ` · PR #${data.pr} (${String(data.prState ?? '?')})` : ''
      }`;
    case 'command.rejected':
      return `${String(data.code ?? '')}: ${String(data.message ?? '')}`;
    case 'session.connected':
      // Which door it came through matters more than the tile: it is how an
      // owner can see, agent by agent, what is left to migrate before turning
      // legacy credentials off.
      return `${data.reconnected === true ? 'reconnected' : `at ${describeTile(data.tile)}`}${describeCredential(data.credential)}`;
    case 'agent.memory_edited':
      return `${String(data.slug ?? '?')} · ${data.cleared === true ? 'cleared' : `${String(data.bytes ?? '?')} bytes`} · by its owner`;
    case 'agent.scopes_changed': {
      // What moved, not what it ended as: a log is read to find the change.
      const moved = [
        ...asList(data.added).map((scope) => `+${scope}`),
        ...asList(data.removed).map((scope) => `-${scope}`),
      ];
      return moved.length > 0 ? moved.join(' ') : 'no change';
    }
    case 'agent.mcp_servers_changed': {
      const before = asList(data.before);
      const after = asList(data.after);
      const moved = [
        ...after.filter((server) => !before.includes(server)).map((server) => `+${server}`),
        ...before.filter((server) => !after.includes(server)).map((server) => `-${server}`),
      ];
      return moved.length > 0 ? moved.join(' ') : 'edited';
    }
    case 'agent.credential_registered':
      return `${shortKey(data.pubkey)}${describeRegistrar(data.via)}`;
    case 'session.revoked':
      return String(data.reason ?? 'revoked');
    default:
      return JSON.stringify(payload).slice(0, 120);
  }
}

/** The scope names in a row, ignoring anything that is not one. */
function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** `· own key` / `· host token` / `· agent key`, or nothing for a row from before doors were recorded. */
function describeCredential(credential: unknown): string {
  switch (credential) {
    case 'v2':
      return ' · own key';
    case 'host':
      return ' · host token';
    case 'key':
      return ' · agent key';
    default:
      return '';
  }
}

/**
 * Who handed the office the key. An audit line says nothing rather than the
 * wrong actor: a `via` this code does not know is not "its owner".
 */
function describeRegistrar(via: unknown): string {
  switch (via) {
    case 'host':
      return ' · by this machine';
    case 'session':
      return ' · by its owner';
    default:
      return '';
  }
}

/** The npub, the way every card shows it; a key that will not encode is shown as its first bytes. */
function shortKey(pubkey: unknown): string {
  if (typeof pubkey !== 'string') return '?';
  try {
    return displayNameFromPubkey(pubkey);
  } catch {
    return pubkey.slice(0, 12);
  }
}

function describeTile(tile: unknown): string {
  if (tile && typeof tile === 'object') {
    const point = tile as { x?: unknown; y?: unknown };
    return `${String(point.x ?? '?')},${String(point.y ?? '?')}`;
  }
  return '?';
}
