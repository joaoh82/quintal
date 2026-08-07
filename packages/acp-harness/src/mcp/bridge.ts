import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';

import type { GatewayClient } from '../gateway/client.js';

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
  gateway: GatewayClient,
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

async function dispatch(gateway: GatewayClient, call: BridgeCall): Promise<unknown> {
  switch (call.tool) {
    case 'look_around':
      return gateway.lookAround();

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
      const scope = call.args.scope === 'zone' ? 'zone' : 'nearby';
      const n = Math.min(Math.max(Number(call.args.n) || 20, 1), 50);
      return gateway.messagesGet(scope, n);
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
