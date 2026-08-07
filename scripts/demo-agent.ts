/**
 * The reference agent.
 *
 * This is both the worked example for `docs/GATEWAY.md` and the fixture the
 * gateway is tested against. It uses nothing private: an API key, a WebSocket,
 * and the documented messages. Anything you can write in any language that can
 * hold a socket open can do exactly this.
 *
 *   AGENT_KEY=qa_… QUINTAL_URL=http://localhost:3000 pnpm demo-agent
 *
 * What it does: idles in the Agent Bay, rotates a status line so you can see it
 * is alive, answers anyone who speaks near it, and obeys "go to <zone label>".
 * It is deliberately dull. An agent that is interesting to watch is an agent
 * that is interrupting you.
 */
import {
  AGENT_STATUS_MAX_LENGTH,
  AgentMessage,
  AgentServerMessage,
  type AgentChatEvent,
  type AgentErrorPayload,
  type AgentMentionEvent,
  type AgentReadyPayload,
  type AgentRosterEvent,
  type AgentResultPayload,
  type LookAroundResult,
} from '@quintal/shared';
import { Client, type Room } from 'colyseus.js';

const url = process.env.QUINTAL_URL ?? 'http://localhost:3000';
const agentKey = process.env.AGENT_KEY;
const mapId = process.env.QUINTAL_MAP ?? 'hq';

if (!agentKey) {
  console.error('AGENT_KEY is required. Create an agent at /settings/agents.');
  process.exit(1);
}

const log = (...parts: unknown[]) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);

/** Statuses to cycle through, so the office can see the agent is alive. */
const IDLE_STATUSES = [
  'idle · waiting for work',
  'watching the room',
  'reading the backlog',
  'thinking about tests',
];

/**
 * Canned replies. A real agent would call a model here; the point of the demo
 * is the gateway, not the intelligence behind it.
 */
function answer(text: string): string {
  const asked = text.toLowerCase();
  if (asked.includes('hello') || asked.includes('hi ')) return 'Hello — I am here and idle.';
  if (asked.includes('status')) return 'Idle in the Agent Bay. Ask me to go somewhere.';
  if (asked.includes('help')) return 'Try: "go to Focus Room", or ask me my status.';
  if (asked.includes('?')) return 'I only know canned answers — I am the demo agent.';
  return 'Noted.';
}

/** "go to the focus room" -> "Focus Room". Matched against real zone labels. */
function parseGoTo(text: string, labels: Map<string, string>): string | null {
  const match = /\bgo\s+to\s+(?:the\s+)?(.+?)\s*[.!?]?$/i.exec(text.trim());
  if (!match) return null;
  const wanted = match[1]?.toLowerCase().trim();
  if (!wanted) return null;

  for (const [label, zoneId] of labels) {
    if (label === wanted || label.replace(/\s+/g, '') === wanted.replace(/\s+/g, '')) {
      return zoneId;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const client = new Client(new URL('/colyseus', url).toString());
  const room: Room = await client.joinOrCreate('office', { agentKey, mapId });
  log(`connected to room ${room.roomId} as session ${room.sessionId}`);

  /** Zone label (lowercased) -> zone id, learned from the roster. */
  const zones = new Map<string, string>();
  let me = 'agent';
  let statusIndex = 0;
  /** Pending request/response calls, keyed by requestId. */
  const pending = new Map<string, (result: AgentResultPayload) => void>();
  let nextRequest = 0;

  const request = <T>(type: string, payload: Record<string, unknown>): Promise<T> => {
    const requestId = `r${(nextRequest += 1)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${type} timed out`));
      }, 5000);

      pending.set(requestId, (result) => {
        clearTimeout(timer);
        pending.delete(requestId);
        if (result.ok) resolve(result.data as T);
        else reject(new Error(`${result.error.code}: ${result.error.message}`));
      });

      room.send(type, { ...payload, requestId });
    });
  };

  room.onMessage(AgentServerMessage.Ready, (ready: AgentReadyPayload) => {
    me = ready.name;
    // The office tells us what places exist; that is how "go to the Focus Room"
    // becomes a zone id we can actually send.
    for (const zone of ready.zones) {
      zones.set(zone.label.toLowerCase(), zone.id);
      zones.set(zone.id.toLowerCase(), zone.id);
    }
    log(
      `ready: ${ready.name} (${ready.ownerName}'s) at ${ready.tile.x},${ready.tile.y}` +
        ` in ${ready.zoneId ?? 'the open floor'} · scopes ${ready.scopes.join(',')}`,
    );
    log(
      `limits: chat every ${ready.limits.chatIntervalMs}ms, move every ${ready.limits.moveIntervalMs}ms`,
    );
    room.send(AgentMessage.SetStatus, { status: IDLE_STATUSES[0] });
  });

  room.onMessage(AgentServerMessage.Roster, (roster: AgentRosterEvent) => {
    if (roster.zone) zones.set(roster.zone.label.toLowerCase(), roster.zone.id);
    const who = roster.occupants
      .map((o) => `${o.name}${o.kind === 'agent' ? '◆' : ''}@${o.distance}`)
      .join(' ');
    log(`roster: ${roster.occupants.length} nearby${who ? ` — ${who}` : ''}`);
  });

  room.onMessage(AgentServerMessage.NearbyChat, (message: AgentChatEvent) => {
    // Never answer yourself, and never answer another agent: two bots in a
    // corner talking to each other is the single worst failure mode here.
    if (message.from === room.sessionId || message.fromKind === 'agent') return;
    log(`heard ${message.fromName} (${message.distance} tiles): "${message.text}"`);
    handle(message.text, message.fromName);
  });

  room.onMessage(AgentServerMessage.Mention, (message: AgentMentionEvent) => {
    log(`mentioned by ${message.fromName} from across the map: "${message.text}"`);
    handle(message.text, message.fromName);
  });

  room.onMessage(AgentServerMessage.Result, (result: AgentResultPayload) => {
    pending.get(result.requestId)?.(result);
  });

  room.onMessage(AgentServerMessage.Error, (error: AgentErrorPayload) => {
    log(`server refused: [${error.code}] ${error.message}`);
    if (error.message.includes('revoked')) {
      log('key revoked — shutting down');
      setTimeout(() => process.exit(0), 100);
    }
  });

  room.onMessage(AgentServerMessage.Heartbeat, () => {
    // Proof of life; nothing to do with it beyond knowing the socket is real.
  });

  room.onLeave((code) => {
    log(`disconnected (code ${code})`);
    process.exit(code === 1000 || code === 4000 ? 0 : 1);
  });

  function handle(text: string, from: string): void {
    const zoneId = parseGoTo(text, zones);
    if (zoneId) {
      log(`walking to zone "${zoneId}" because ${from} asked`);
      room.send(AgentMessage.MoveTo, { zoneId });
      room.send(AgentMessage.SetStatus, { status: `walking to ${zoneId}`.slice(0, AGENT_STATUS_MAX_LENGTH) });
      room.send(AgentMessage.Say, { text: `On my way to the ${zoneId}.` });
      return;
    }
    room.send(AgentMessage.Say, { text: answer(text) });
  }

  // Rotate the status line so the room can see the agent is alive without it
  // having to say anything. Quiet by default is the whole posture.
  setInterval(() => {
    statusIndex = (statusIndex + 1) % IDLE_STATUSES.length;
    room.send(AgentMessage.SetStatus, { status: IDLE_STATUSES[statusIndex] });
  }, 20_000);

  // Periodically look around, which is also a live check of the query path.
  setInterval(() => {
    void request<LookAroundResult>(AgentMessage.LookAround, {})
      .then((result) => {
        const humans = result.occupants.filter((o) => o.kind === 'human').length;
        log(`look_around: in ${result.zone?.label ?? 'the open floor'}, ${humans} human(s) about`);
      })
      .catch((error: unknown) => log('look_around failed:', error));
  }, 30_000);

  log(`${me} is idling. Walk up and say hello, or try "go to Focus Room".`);
}

main().catch((error: unknown) => {
  console.error('demo agent failed:', error);
  process.exit(1);
});
