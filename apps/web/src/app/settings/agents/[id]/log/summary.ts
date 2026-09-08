import { npubEncode, truncateNpub } from '@quintal/shared';

/**
 * One line per audit row. The log is scanned, not read, so each kind gets
 * the two or three words that tell it apart from its neighbours — and the
 * connect row says which credential opened the door, because that is the
 * fact an owner needs before turning the old doors off.
 */
/** Compact one-line summary of a payload — the log is scanned, not read. */
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
    case 'command.rejected':
      return `${String(data.code ?? '')}: ${String(data.message ?? '')}`;
    case 'session.connected':
      // Which door it came through matters more than the tile: it is how an
      // owner can see, agent by agent, what is left to migrate before turning
      // legacy credentials off.
      return data.reconnected === true
        ? 'reconnected'
        : `at ${describeTile(data.tile)}${describeCredential(data.credential)}`;
    case 'agent.credential_registered':
      return `${shortKey(data.pubkey)} · by ${data.via === 'host' ? 'this machine' : 'its owner'}`;
    case 'session.revoked':
      return String(data.reason ?? 'revoked');
    default:
      return JSON.stringify(payload).slice(0, 120);
  }
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

function shortKey(pubkey: unknown): string {
  if (typeof pubkey !== 'string') return '?';
  try {
    return truncateNpub(npubEncode(pubkey));
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
