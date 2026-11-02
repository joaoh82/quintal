import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';

import { CHOSEN_EMOTES, isBoardColor, type AgentZone, type BoardColor } from '@quintal/shared';

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

/**
 * What the runner knows and the gateway does not.
 *
 * `say` posts into the conversation the current turn is in, and only the
 * runner knows which that is — the gateway sees a socket, not a turn. Without
 * the hook a `say` is spoken aloud, which is right for a bridge started on
 * its own and wrong for one inside a channel turn.
 */
export interface BridgeHooks {
  say?: (text: string) => unknown;
  /**
   * `set_status` from the model, routed through the runner so the line lands
   * on the turn that set it. Sent straight to the office it would say where
   * the work is for nobody — and blank out every other turn's conversation.
   */
  setStatus?: (status: string) => unknown;
  /**
   * `memory_set`, routed through the runner so the sessions that did not
   * write can be told their standing instructions moved.
   */
  memorySet?: (slug: string, content: string, expectedHash?: string) => Promise<unknown>;
  /**
   * `workspace_info`. Only the runner knows the agent's working directory,
   * which runtime it is on and what this machine reported about itself — the
   * bridge process's own `cwd` is the harness's, not the agent's, so there is
   * deliberately no fallback here. A bridge without the hook says so rather
   * than answering about the wrong directory.
   */
  workspaceInfo?: () => unknown;
  /**
   * `task_begin`, `task_end`, `task_status`: a git worktree per task. The
   * runner owns the book and the agent's working directory, so these go
   * through it — see `runner/tasks.ts`.
   */
  taskBegin?: (repo: string, title: string, item?: number) => Promise<unknown>;
  taskEnd?: () => Promise<unknown>;
  taskStatus?: () => unknown;
  /**
   * `reload_tools`: restart the runtime so it reads its configuration again,
   * keeping the conversation. Only the runner can — it owns the processes.
   */
  reloadTools?: () => unknown;
}

export async function startBridge(
  gateway: Gateway,
  onCall?: (tool: string, args: Record<string, unknown>) => void,
  hooks: BridgeHooks = {},
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
        const result = await dispatch(gateway, call, hooks);
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

/**
 * The board is one scope, reads included. The office refuses without it too;
 * refusing here as well saves a round trip and says where the scope is set.
 */
function needBoardScope(gateway: Gateway, tool: string): void {
  if (gateway.ready?.scopes?.includes('board')) return;
  throw new Error(
    `${tool}: this agent has no "board" scope. Its owner grants it under Settings → Agents. ` +
      'Until then, say what you would have written and leave the board to them.',
  );
}

/** The commands are one scope, reads included, as the board is. */
function needCommandsScope(gateway: Gateway, tool: string): void {
  if (gateway.ready?.scopes?.includes('commands')) return;
  throw new Error(
    `${tool}: this agent has no "commands" scope. Its owner grants it under Settings → Agents. ` +
      'Until then, say what the command would be and leave making it to them.',
  );
}

/** The routines are one scope, reads included, as the commands are. */
function needRoutinesScope(gateway: Gateway, tool: string): void {
  if (gateway.ready?.scopes?.includes('routines')) return;
  throw new Error(
    `${tool}: this agent has no "routines" scope. Its owner grants it under Settings → Agents. ` +
      'Until then, say what the routine would be and leave making it to them, under Settings → Routines.',
  );
}

/** A routine's name or id, as `routine_list` shows it. */
export function routineName(value: unknown): string {
  const name = String(value ?? '').trim();
  if (name.length === 0) throw new Error('name the routine, as routine_list shows it');
  return name;
}

/** The schedule as the model wrote it; the office reads the phrase. */
function whenArg(value: unknown): string {
  const when = String(value ?? '').trim();
  if (when.length === 0) throw new Error('say when: "every hour", "weekdays at 9", "in 45 minutes", or a cron line of five fields');
  return when;
}

/** `"@Marvin"`, `"Marvin"`, `"me"`: the agent a routine is on, as the model names it; absent for the caller. */
function agentField(args: Record<string, unknown>): { agent?: string } {
  if (typeof args.agent !== 'string') return {};
  const agent = args.agent.trim().replace(/^@/, '');
  return agent.length > 0 ? { agent } : {};
}

/**
 * The zone a schedule is read in: this machine's, since an agent usually
 * runs on its owner's computer and "9" means nine where they sit. UTC when
 * the runtime cannot say.
 */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The fields a routine create and update share, only those given. `command: null` is "its own words only". */
function routineFields(args: Record<string, unknown>): { instructions?: string; command?: string | null; args?: string } {
  return {
    ...(typeof args.instructions === 'string' ? { instructions: args.instructions } : {}),
    ...(args.command === null ? { command: null } : typeof args.command === 'string' ? { command: commandName(args.command) } : {}),
    ...(typeof args.args === 'string' ? { args: args.args } : {}),
  };
}

/** `"review"`, `"!review"` or `" Review "`: a command's name as people write it. */
export function commandName(value: unknown): string {
  const name = String(value ?? '').trim().replace(/^!/, '').toLowerCase();
  if (name.length === 0) throw new Error('name the command, as it is typed after !');
  return name;
}

/** `"@reviewers"`, `"reviewers"`, `"me"`; `null`, `""` or `"nobody"` is none. */
function targetArg(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const name = String(value).trim().replace(/^@/, '');
  return name.length === 0 || name.toLowerCase() === 'nobody' ? null : name;
}

/** The fields a command create and update share, only those given. */
function commandFields(args: Record<string, unknown>): {
  summary?: string;
  argumentHint?: string;
  instructions?: string;
} {
  return {
    ...(typeof args.summary === 'string' ? { summary: args.summary } : {}),
    ...(typeof args.argument_hint === 'string' ? { argumentHint: args.argument_hint } : {}),
    ...(typeof args.instructions === 'string' ? { instructions: args.instructions } : {}),
  };
}

/** `12`, `"12"` or `"#12"`: the note's number as people write it. */
export function noteNumber(value: unknown): number {
  const text = String(value ?? '').trim().replace(/^#/, '');
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`"${String(value ?? '')}" is not a note number; notes are #1, #2 … as board_list shows them`);
  }
  return number;
}

/** `"bug, ui"` or `["bug", "ui"]`: labels as the model is likely to write them. */
function labelsArg(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((label) => String(label));
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
  }
  return undefined;
}

/** `"Marvin"`, `"@Marvin"`, `"me"`; `null` or `""` is nobody. */
function assigneeArg(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const name = String(value).trim().replace(/^@/, '');
  return name.length === 0 || name.toLowerCase() === 'nobody' ? null : name;
}

/** The fields a create and an update share, only those given. */
function noteFields(args: Record<string, unknown>): {
  body?: string;
  status?: 'open' | 'in_progress' | 'done';
  color?: BoardColor;
  labels?: string[];
} {
  const labels = labelsArg(args.labels);
  const status = args.status;
  const color = typeof args.color === 'string' ? args.color.trim().toLowerCase() : undefined;
  if (color !== undefined && !isBoardColor(color)) {
    throw new Error(`"${String(args.color)}" is not a colour the board has; it has yellow, blue, green, pink, orange and purple`);
  }
  return {
    ...(typeof args.body === 'string' ? { body: args.body } : {}),
    ...(status === 'open' || status === 'in_progress' || status === 'done' ? { status } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(labels !== undefined ? { labels } : {}),
  };
}

async function dispatch(
  gateway: Gateway,
  call: BridgeCall,
  hooks: BridgeHooks,
): Promise<unknown> {
  switch (call.tool) {
    case 'say': {
      const scopes = gateway.ready?.scopes ?? [];
      if (!scopes.includes('chat')) {
        throw new Error('you do not have the "chat" scope, so you cannot speak or post');
      }
      const text = String(call.args.text ?? '').trim();
      if (text.length === 0) throw new Error('say needs some text');
      if (hooks.say) return hooks.say(text);
      gateway.say(text);
      return { posted_to: 'aloud, to whoever is nearby', parts: 1 };
    }

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
      if (hooks.setStatus) hooks.setStatus(status);
      else gateway.setStatus(status);
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
        call.args.scope === 'zone' ||
        call.args.scope === 'mentions' ||
        call.args.scope === 'channel'
          ? call.args.scope
          : 'nearby';
      const n = Math.min(Math.max(Number(call.args.n) || 20, 1), 50);
      const before = Number(call.args.before);
      // The model knows channels by name — that is what the envelope shows it —
      // and the office by id. Accept either; resolve the name here. A DM has
      // no slug and is known by the other party's name.
      const wanted = typeof call.args.channel === 'string' ? call.args.channel.trim() : '';
      const slug = wanted.replace(/^#/, '').toLowerCase();
      const channelId =
        gateway
          .channels()
          .find(
            (channel) =>
              channel.id === wanted ||
              (channel.kind === 'channel' && channel.slug === slug) ||
              (channel.kind === 'dm' && channel.name.toLowerCase() === slug),
          )?.id ?? wanted;
      return gateway.messagesGet({
        scope,
        n,
        ...(typeof call.args.zone === 'string' && call.args.zone.length > 0
          ? { zoneId: call.args.zone }
          : {}),
        ...(channelId.length > 0 ? { channelId } : {}),
        ...(Number.isFinite(before) && before > 0 ? { before } : {}),
      });
    }

    case 'board_list': {
      needBoardScope(gateway, call.tool);
      const status = call.args.status;
      return gateway.boardList({
        ...(status === 'open' || status === 'in_progress' || status === 'done' ? { status } : {}),
        ...(call.args.mine === true ? { mine: true } : {}),
      });
    }

    case 'board_get': {
      needBoardScope(gateway, call.tool);
      return gateway.boardGet(noteNumber(call.args.number));
    }

    case 'board_create': {
      needBoardScope(gateway, call.tool);
      const title = String(call.args.title ?? '').trim();
      if (title.length === 0) throw new Error('board_create needs a title');
      return gateway.boardCreate({
        title,
        ...noteFields(call.args),
        ...('assignee' in call.args ? { assignee: assigneeArg(call.args.assignee) } : {}),
      });
    }

    case 'board_update': {
      needBoardScope(gateway, call.tool);
      const number = noteNumber(call.args.number);
      const patch = {
        ...(typeof call.args.title === 'string' ? { title: call.args.title } : {}),
        ...noteFields(call.args),
        ...('assignee' in call.args ? { assignee: assigneeArg(call.args.assignee) } : {}),
      };
      if (Object.keys(patch).length === 0) throw new Error(`board_update #${number}: say what changes`);
      return gateway.boardUpdate({ number, ...patch });
    }

    case 'command_list': {
      needCommandsScope(gateway, call.tool);
      return gateway.commandList();
    }

    case 'command_get': {
      needCommandsScope(gateway, call.tool);
      return gateway.commandGet(commandName(call.args.name));
    }

    case 'command_create': {
      needCommandsScope(gateway, call.tool);
      return gateway.commandCreate({
        name: commandName(call.args.name),
        ...commandFields(call.args),
        ...('default_target' in call.args ? { defaultTarget: targetArg(call.args.default_target) } : {}),
      });
    }

    case 'command_update': {
      needCommandsScope(gateway, call.tool);
      const name = commandName(call.args.name);
      const patch = {
        ...(typeof call.args.new_name === 'string' ? { newName: commandName(call.args.new_name) } : {}),
        ...commandFields(call.args),
        ...('default_target' in call.args ? { defaultTarget: targetArg(call.args.default_target) } : {}),
      };
      if (Object.keys(patch).length === 0) throw new Error(`command_update !${name}: say what changes`);
      return gateway.commandUpdate({ name, ...patch });
    }

    case 'routine_list': {
      needRoutinesScope(gateway, call.tool);
      return gateway.routineList(agentField(call.args));
    }

    case 'routine_get': {
      needRoutinesScope(gateway, call.tool);
      return gateway.routineGet({ routine: routineName(call.args.routine), ...agentField(call.args) });
    }

    case 'routine_create': {
      needRoutinesScope(gateway, call.tool);
      return gateway.routineCreate({
        name: routineName(call.args.name),
        when: whenArg(call.args.when),
        tz: localZone(),
        ...agentField(call.args),
        ...routineFields(call.args),
      });
    }

    case 'routine_update': {
      needRoutinesScope(gateway, call.tool);
      const routine = routineName(call.args.routine);
      const patch = {
        ...(typeof call.args.new_name === 'string' ? { newName: routineName(call.args.new_name) } : {}),
        ...(typeof call.args.when === 'string' ? { when: whenArg(call.args.when), tz: localZone() } : {}),
        ...routineFields(call.args),
        ...(typeof call.args.paused === 'boolean' ? { paused: call.args.paused } : {}),
      };
      if (Object.keys(patch).length === 0) throw new Error(`routine_update "${routine}": say what changes`);
      return gateway.routineUpdate({ routine, ...agentField(call.args), ...patch });
    }

    case 'routine_delete': {
      needRoutinesScope(gateway, call.tool);
      return gateway.routineDelete({ routine: routineName(call.args.routine), ...agentField(call.args) });
    }

    case 'workspace_info': {
      if (!hooks.workspaceInfo) {
        throw new Error(
          'workspace_info is answered by the harness running this agent, and this tool ' +
            'server was started without one',
        );
      }
      return hooks.workspaceInfo();
    }

    case 'task_begin': {
      if (!hooks.taskBegin) throw new Error('task_begin is answered by the harness running this agent, and this tool server was started without one');
      const item = call.args.item;
      return hooks.taskBegin(
        String(call.args.repo ?? ''),
        String(call.args.title ?? ''),
        typeof item === 'number' && Number.isSafeInteger(item) && item > 0 ? item : undefined,
      );
    }

    case 'task_end': {
      if (!hooks.taskEnd) throw new Error('task_end is answered by the harness running this agent, and this tool server was started without one');
      return hooks.taskEnd();
    }

    case 'task_status': {
      if (!hooks.taskStatus) throw new Error('task_status is answered by the harness running this agent, and this tool server was started without one');
      return hooks.taskStatus();
    }

    case 'reload_tools': {
      if (!hooks.reloadTools) throw new Error('reload_tools is answered by the harness running this agent, and this tool server was started without one');
      return hooks.reloadTools();
    }

    case 'memory_get':
      return gateway.memoryGet(String(call.args.slug ?? 'core'));

    case 'memory_set': {
      const slug = String(call.args.slug ?? '');
      const content = String(call.args.content ?? '');
      const expected =
        typeof call.args.expected_hash === 'string' && call.args.expected_hash.length > 0
          ? call.args.expected_hash
          : undefined;
      if (hooks.memorySet) return hooks.memorySet(slug, content, expected);
      return gateway.memorySet(slug, content, expected);
    }

    case 'emote': {
      const emote = String(call.args.emote ?? '');
      if (!(CHOSEN_EMOTES as readonly string[]).includes(emote)) {
        throw new Error(`"${emote}" is not an emote you can choose`);
      }
      // No ttl: the office's default for a reaction.
      gateway.emote(emote);
      return { ok: true };
    }

    default:
      throw new Error(`unknown tool "${call.tool}"`);
  }
}
