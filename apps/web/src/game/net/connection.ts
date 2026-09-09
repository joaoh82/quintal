import { OfficeState, ROOM_OFFICE, type JoinOptions } from '@quintal/shared';
import { Client, type Room } from 'colyseus.js';

/**
 * Opening a connection to the office.
 *
 * There is no `NEXT_PUBLIC_WS_URL`: the room server always lives at
 * `${origin}/colyseus`. In production one process serves both; in development
 * `next dev` proxies that path to :2567. Same URL in both, so no environment
 * variable can be wrong in one of them.
 */

export interface JoinTicket {
  wsUrl: string;
  token: string;
  /** The office this ticket admits you to. Chosen by the server, not here. */
  workspaceId: string;
}

export class NotSignedInError extends Error {
  constructor() {
    super('Your session expired — sign in again.');
    this.name = 'NotSignedInError';
  }
}

async function fetchTicket(signal?: AbortSignal): Promise<JoinTicket> {
  const response = await fetch('/api/game/join', {
    method: 'POST',
    cache: 'no-store',
    signal,
  });

  if (response.status === 401) throw new NotSignedInError();
  if (!response.ok) throw new Error(`Could not get a join ticket (${response.status})`);

  return (await response.json()) as JoinTicket;
}

/**
 * One client per endpoint, for the life of the page. A rejoin loop that made
 * a new one per attempt would leave a trail of them behind it; there is only
 * ever one office to talk to from here.
 */
const clients = new Map<string, Client>();

function clientFor(endpoint: string): Client {
  let client = clients.get(endpoint);
  if (!client) {
    client = new Client(endpoint);
    clients.set(endpoint, client);
  }
  return client;
}

/** A live seat in the office, and the client that can get it back. */
export interface OfficeConnection {
  room: Room<OfficeState>;
  client: Client;
  /** What we joined with; the voice socket presents the same token. */
  ticket: JoinTicket;
}

/** Connect and join the office for a map. Throws if the session isn't valid. */
export async function joinOffice(
  mapId: string,
  signal?: AbortSignal,
): Promise<OfficeConnection> {
  const ticket = await fetchTicket(signal);

  // `wsUrl` is a path; resolve it against the page origin so http→ws and
  // https→wss are decided by how the page itself was served.
  const endpoint = new URL(ticket.wsUrl, window.location.origin).toString();
  const client = clientFor(endpoint);

  // `workspaceId` picks the room; the server proves you belong in it. Two
  // offices on one deployment are two rooms, and neither can see the other.
  const options: JoinOptions = {
    token: ticket.token,
    mapId,
    workspaceId: ticket.workspaceId,
  };
  const room = await client.joinOrCreate<OfficeState>(ROOM_OFFICE, options, OfficeState);
  return { room, client, ticket };
}

/**
 * Take a dropped seat back, while the server is still holding it.
 *
 * The token is the room's own (`roomId:token`), minted at join; it is the
 * one thing that says "this is the same person who was standing there", so
 * the avatar comes back where it was rather than at the door.
 */
export async function resumeOffice(
  client: Client,
  reconnectionToken: string,
): Promise<Room<OfficeState>> {
  return client.reconnect<OfficeState>(reconnectionToken, OfficeState);
}
