import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';

import type { AgentZone } from '@quintal/shared';

import type { Gateway } from '../gateway/client.js';

/**
 * The link between the MCP tool server and the office.
 *
 * The shape of the problem: ACP hands the agent a list of MCP servers to spawn,
 * and those run as their own processes. But the office connection lives *here*,
 * in the harness — and it must stay here, because a second connection with the
 * same agent key would put a second copy of the agent in the room.
 *
 * So the harness runs a tiny loopback HTTP server, and the MCP process is given
 * its address plus a one-time token. Bound to 127.0.0.1 and gated on a random
 * token, because "the agent's senses" is a capability worth not leaving open to
 * anything else on the machine.
 */

export interface BridgeCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface BridgeHandle {
  url: string;
  token: string;
  close: () => Promise<void>;
}

export async function startBridge(
  gateway: Gateway,
  onCall?: (tool: string, args: Record<string, unknown>) => void,
): Promise<BridgeHandle> {
  const token = randomBytes(24).toString('base64url');

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.headers['x-quintal-token'] !== token) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);

      let call: BridgeCall;
      try {
        call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BridgeCall;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }

      onCall?.(call.tool, call.args ?? {});

      try {
        const result = await dispatch(gateway, call);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (error: unknown) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : 'tool failed',
          }),
        );
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Turn "the focus room" into a zone id.
 *
 * Zone ids are stable and human labels are not, so the office hands out both.
 * An agent asked to "come to the focus room" has the label and nothing else,
 * and making it guess the id is how you get `move_to("Focus Room")` failing
 * silently forever.
 */
export function resolveZone(zones: readonly AgentZone[], wanted: string): string {
  const needle = wanted.trim().toLowerCase();
  if (needle.length === 0) throw new Error('move_to needs a zone');

  const match =
    zones.find((zone) => zone.id.toLowerCase() === needle) ??
    zones.find((zone) => zone.label.toLowerCase() === needle) ??
    zones.find((zone) => zone.label.toLowerCase().includes(needle));

  if (!match) {
    const known = zones.map((zone) => `${zone.id} (${zone.label})`).join(', ');
    throw new Error(`no zone matching "${wanted}". This office has: ${known || 'none'}`);
  }
  return match.id;
}

async function dispatch(gateway: Gateway, call: BridgeCall): Promise<unknown> {
  switch (call.tool) {
    case 'look_around': {
      // The zone list rides along: "look at the room" reasonably includes what
      // other rooms exist, and an agent that can walk needs somewhere to aim.
      const around = await gateway.lookAround();
      return { ...around, zones: gateway.ready?.zones ?? [] };
    }

    case 'move_to': {
      const scopes = gateway.ready?.scopes ?? [];
      if (!scopes.includes('move')) {
        // Fail here rather than on the wire: `move_to` is fire-and-forget, so a
        // server-side refusal would arrive long after the tool returned "sure".
        throw new Error(
          'you do not have the "move" scope, so you cannot walk. Say so plainly and ask to be moved.',
        );
      }
      const note =
        'You walk at human speed along a real path — you are not there yet. Carry on; the room will show you arriving.';

      // A person wins over a zone when both are given. "Come to me, I am in the
      // Focus Room" names a room only as a hint about where the person is, and
      // walking to the room while they move away is the wrong reading.
      const person = String(call.args.person ?? '').trim();
      if (person.length > 0) {
        gateway.moveToPerson(person);
        return { walking_to: person, note };
      }

      const zoneId = resolveZone(gateway.ready?.zones ?? [], String(call.args.zone ?? ''));
      gateway.moveToZone(zoneId);
      return { walking_to: zoneId, note };
    }

    case 'set_status': {
      const scopes = gateway.ready?.scopes ?? [];
      if (!scopes.includes('status')) throw new Error('you do not have the "status" scope');
      const status = String(call.args.status ?? '').trim();
      gateway.setStatus(status);
      return { status };
    }

    case 'who_is_here': {
      // Derived from look_around rather than a second round trip: the office
      // already told us, and an agent asking "who is here" twice a second
      // should not cost two messages.
      const around = await gateway.lookAround();
      return {
        zone: around.zone,
        occupants: around.occupants.map((occupant) => ({
          name: occupant.name,
          kind: occupant.kind,
          status: occupant.status,
          distance: occupant.distance,
        })),
      };
    }

    case 'messages_get': {
      const scope =
        call.args.scope === 'zone' || call.args.scope === 'mentions' ? call.args.scope : 'nearby';
      const n = Math.min(Math.max(Number(call.args.n) || 20, 1), 50);
      const before = Number(call.args.before);
      return gateway.messagesGet({
        scope,
        n,
        ...(typeof call.args.zone === 'string' && call.args.zone.length > 0
          ? { zoneId: call.args.zone }
          : {}),
        ...(Number.isFinite(before) && before > 0 ? { before } : {}),
      });
    }

    case 'memory_get':
      return gateway.memoryGet(String(call.args.slug ?? 'core'));

    case 'memory_set':
      return gateway.memorySet(
        String(call.args.slug ?? ''),
        String(call.args.content ?? ''),
      );

    default:
      throw new Error(`unknown tool "${call.tool}"`);
  }
}
