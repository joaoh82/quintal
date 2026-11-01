import { CHOSEN_EMOTES } from '@quintal/shared';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * `quintal-tools` — the MCP server the agent's harness spawns.
 *
 * These tools are the agent's senses. Everything an agent knows about the room
 * beyond the small envelope pushed with its prompt, it learns by calling one of
 * these — which is the whole point of the pull-first design: context costs
 * tokens only when it's actually wanted.
 *
 * This process holds no credentials and no socket to the office. It forwards to
 * the harness over loopback (see `bridge.ts`), which is what keeps a single
 * agent identity attached to a single connection.
 */

const BRIDGE_URL = process.env.QUINTAL_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.QUINTAL_BRIDGE_TOKEN;

interface BridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

async function callBridge(tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    throw new Error('quintal-tools was started outside a harness (no bridge configured)');
  }

  const response = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quintal-token': BRIDGE_TOKEN },
    body: JSON.stringify({ tool, args }),
  });

  if (!response.ok) throw new Error(`bridge refused the call (${response.status})`);

  const payload = (await response.json()) as BridgeResponse;
  if (!payload.ok) throw new Error(payload.error ?? 'tool failed');
  return payload.result;
}

const TOOLS = [
  {
    name: 'say',
    description:
      'Post a line right now, into the conversation this turn is in — the ' +
      'channel or DM you were addressed in, or aloud to whoever is nearby. ' +
      'Use it to say you have picked something up, to report when a step ' +
      'lands or blocks, and to publish a result before you carry on. What you ' +
      'write as your final answer is posted the same way when the turn ends, ' +
      'so do not repeat there what you already said here. Aloud, a line is ' +
      'cut into short speech bubbles; in a channel or DM it is posted whole, ' +
      'up to about 4000 characters, so a review or a plan can go in as one ' +
      'message. Never a bare acknowledgement.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'look_around',
    description:
      'Look at the room you are standing in: which zone you are in, your tile, ' +
      'and everyone nearby with their kind (human or agent), status and distance ' +
      'in tiles. Also lists every zone in the office, which is where move_to can ' +
      'take you. Call this before answering questions about who is present or ' +
      'where you are — your pushed context deliberately does not include it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'workspace_info',
    description:
      'Where you work on this machine, and what you are allowed to do. One call ' +
      'answers all of it: your working directory, whether it has an AGENTS.md, the ' +
      'repositories directory you were given and the checkouts already in it (with ' +
      'each origin remote as host/path), the runtime and model you are running on, ' +
      'the machine you are on, and which Quintal scopes you hold. Call this instead ' +
      'of exploring with pwd, ls, find or git remote — it is one call rather than a ' +
      'shell session, and it will not send you looking for directories that are not ' +
      'there. It reads only this machine and never contacts a remote: a checkout ' +
      'here is not proof you can read or push its repository today, and access ' +
      'outside this machine stays unknown until you check it deliberately with the ' +
      'credentials your runtime already has.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'task_begin',
    description:
      'Begin a task before editing files in a repository. Names a checkout under ' +
      'REPOS/ (as workspace_info lists it: "api", or "group/api") and a short title. ' +
      'The harness fetches the default branch, cuts a branch of your own from it ' +
      '(quintal/<you>/<title>) and gives you a worktree for it under WORKTREES/ — ' +
      'your working directory from now until task_end, so your edits never touch the ' +
      'shared checkout or another agent\'s work. The result names the worktree: work ' +
      'there, by absolute path, for the rest of this turn; your later turns start ' +
      'there. One task at a time. Not for questions, reading code or talk: only when ' +
      'you are about to change files. Say which branch you are on once it is made.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'A checkout under REPOS/, by name.' },
        title: { type: 'string', description: 'What the task is, in a few words. Becomes the branch name.' },
        item: {
          type: 'integer',
          description:
            'The office board note this task is for, by its number, when you were handed one ("board note #12"). ' +
            'The board then follows your branch: the note moves to in progress now and to done when the pull request merges.',
        },
      },
      required: ['repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_end',
    description:
      'End your task: when its pull request has merged, or the work is abandoned. ' +
      'Your working directory goes back to the shared workspace. The worktree is ' +
      'removed with its branch only if it is clean and everything on it is on the ' +
      'remote; uncommitted changes or unpushed commits keep it, and the result says ' +
      'so and where. Commit and push (or open the pull request) before calling this ' +
      'if you want the work to survive.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'task_status',
    description:
      'Which task you are on, if any: its title, repository, branch, worktree and ' +
      'pull request. Cheaper than workspace_info when that is all you need.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'reload_tools',
    description:
      'Restart your runtime so it loads its tools again, keeping this conversation. ' +
      'Use it when a tool or MCP server was added on this machine after your session ' +
      'started — someone ran `claude mcp add` and signed in, say — and you cannot see it. ' +
      'The restart happens when your current reply ends: the new tools are there from your ' +
      'next turn, not this one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'move_to',
    description:
      'Walk somewhere. Name either a person or a zone. ' +
      'Use `person` when somebody asks you to come to them — "come here", ' +
      '"can you join me" — and you will stop beside them wherever they are, ' +
      'in a room or not. Use `zone` for a place: its id or human label ' +
      '("focus", "Focus Room"); call look_around if you are unsure which ' +
      'exist. You walk at human speed along a real path and arrive seconds ' +
      'later, so this returns before you get there; it is a request to walk, ' +
      'not teleportation. Do not wander on your own.',
    inputSchema: {
      type: 'object',
      properties: {
        person: {
          type: 'string',
          description:
            'Somebody in the office, by the name you see them under. You stop ' +
            'next to them; you do not need to know where they are.',
        },
        zone: { type: 'string', description: 'Zone id or human label.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_status',
    description:
      'Set the short line under your nameplate — how the room sees what you are ' +
      'doing without interrupting you. Keep it under 60 characters and in the ' +
      'present tense: "reading auth.ts", "waiting for review". Pass an empty ' +
      'string when you go idle. This is not chat: nobody is notified.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
      required: ['status'],
      additionalProperties: false,
    },
  },
  {
    name: 'who_is_here',
    description:
      'Just the occupants near you, without your own position. Cheaper to read ' +
      'when all you need is who you are talking to.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'messages_get',
    description:
      'Read what was said. "nearby" is what you could hear from where you stand; ' +
      '"zone" is a zone\'s transcript (yours, or any zone by id from look_around); ' +
      '"channel" is a channel you are a member of (by name, e.g. "engineering"); ' +
      '"mentions" is every message that addressed you by name, wherever it was said. ' +
      'History is kept across restarts. Use this when someone refers to something ' +
      'said before you were asked, rather than guessing; pass "before" (the sentAt ' +
      'of the oldest message you have) to page further back.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['nearby', 'zone', 'channel', 'mentions'],
          default: 'nearby',
        },
        zone: { type: 'string', description: 'With scope "zone": a zone id.' },
        channel: {
          type: 'string',
          description: 'With scope "channel": the channel, by name (without the #) or id.',
        },
        n: { type: 'number', minimum: 1, maximum: 50, default: 20 },
        before: { type: 'number', description: 'Only messages sent before this time (ms).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_list',
    description:
      'Read the office board: every note (number, title, body, column, labels, who it is for, ' +
      'and the branch or pull request it is on), plus the agents a note could be handed to. ' +
      'Columns are "open", "in_progress" and "done". Pass status to read one column, or mine: true ' +
      'for the notes handed to you. Read it when you are asked what is on the board, what you are ' +
      'on, or before you write a note that might already be there.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'in_progress', 'done'] },
        mine: { type: 'boolean', description: 'Only the notes handed to you.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'board_get',
    description:
      'Read one note on the office board by its number ("#12" is 12): the whole body, its ' +
      'labels, who it is for, and the branch and pull request it is on. Read a note you were ' +
      'handed before you start on it, and pass its number to task_begin as item.',
    inputSchema: {
      type: 'object',
      properties: { number: { type: 'integer', minimum: 1 } },
      required: ['number'],
      additionalProperties: false,
    },
  },
  {
    name: 'board_create',
    description:
      'Pin a note on the office board, written as you, for everybody to read. When someone asks ' +
      'you to put something on the board, write a ticket worth reading from what they said: a ' +
      'one-line title that says what, not "fix bug", and a body with the why, what you know, and ' +
      'what done looks like. Say the number back ("That is #14"). Do not hand it to anybody unless ' +
      'you were told to: leave it on the board and ask whether to assign it. You may hand a note ' +
      'only to an agent your owner owns, yourself included. When you do hand one over, the result ' +
      'carries a line to say where you were asked, naming them, so they are woken by it; the ' +
      'office posts nothing for you.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line, up to 200 characters. What the note is.' },
        body: { type: 'string', description: 'The ticket: why, what is known, what done looks like. Up to 8000 characters.' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done'], description: 'The column. Default open.' },
        color: { type: 'string', enum: ['yellow', 'blue', 'green', 'pink', 'orange', 'purple'] },
        labels: { type: 'array', items: { type: 'string' }, description: 'Up to ten short labels: "bug", "ui".' },
        assignee: {
          type: ['string', 'null'],
          description: 'An agent, by name, or "me". Only when told to hand it over. Omit to leave it on the board.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'board_update',
    description:
      'Change a note on the office board by its number: title, body, column, colour, labels, or ' +
      'who it is for. Only what you pass changes. Move a note you are on to "in_progress" or ' +
      '"done" when you were not handed it with a task (task_begin with item moves it for you); ' +
      'never move a note that is not yours unless asked. assignee: an agent by name, "me", or null ' +
      'to take it off whoever has it. You may hand a note only to an agent your owner owns. When ' +
      'you do, say the returned handover line where you were asked, so they are woken by it.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        body: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done'] },
        color: { type: 'string', enum: ['yellow', 'blue', 'green', 'pink', 'orange', 'purple'] },
        labels: { type: 'array', items: { type: 'string' }, description: 'Replaces the labels whole.' },
        assignee: { type: ['string', 'null'], description: 'An agent by name, "me", or null for nobody.' },
      },
      required: ['number'],
      additionalProperties: false,
    },
  },
  {
    name: 'command_list',
    description:
      'The office\'s own !commands: every one, with its name, what it does, how to use it, its ' +
      'instructions, who set it up, and whether you may change it (yours: your owner made it, or ' +
      'your owner is an office admin). Read this when asked what commands there are, what one ' +
      'does, or before making one that might already exist. People use these by typing !name in ' +
      'chat; you cannot use one yourself — writing !review is talking about it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'command_get',
    description:
      'One of the office\'s !commands by name ("review" or "!review"): its whole instructions, how ' +
      'to use it, who set it up and whether you may change it. Read a command before you are asked ' +
      'to explain or change it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'command_create',
    description:
      'Make one of the office\'s !commands, as your owner. When someone asks you for a command that ' +
      'does something, write one worth keeping: a one-word name people will type after !, a one-line ' +
      'summary for the picker, a hint for what to type after it, and instructions that tell whoever ' +
      'it reaches exactly what to do and what done looks like — up to 16,000 characters, so a ' +
      'checklist fits. The office records it as made by your owner, via you, and every agent it ' +
      'later reaches is told so. Say back how it is used ("!review @reviewers <link>"). Never make ' +
      'one nobody asked for.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'One word: letters, digits, - or _. What people type after !.' },
        summary: { type: 'string', description: 'One line, up to 120 characters: what it does.' },
        argument_hint: { type: 'string', description: 'What to type after it, as a hint: "<pull request link>". Empty for nothing.' },
        instructions: { type: 'string', description: 'What it asks of whoever it reaches. Up to 16,000 characters.' },
        default_target: {
          type: ['string', 'null'],
          description: 'An agent or a team, by name, or "me", that the command goes to when the line names nobody. Omit for none.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'command_update',
    description:
      'Change one of the office\'s !commands by name: its name, summary, hint, instructions or ' +
      'default target. Only what you pass changes. You may change a command your owner made (or any, ' +
      'if your owner is an office admin); for anybody else\'s, say what you would have changed. ' +
      'Read it with command_get first and rewrite the instructions whole — they replace, not append. ' +
      'The office records the change as your owner\'s, via you.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The command to change, as typed after !.' },
        new_name: { type: 'string', description: 'A new name for it.' },
        summary: { type: 'string' },
        argument_hint: { type: 'string' },
        instructions: { type: 'string', description: 'The whole new instructions.' },
        default_target: { type: ['string', 'null'], description: 'An agent or team by name, "me", or null for none.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_get',
    description:
      'Read one of your memory slugs. "core" holds your identity, standing ' +
      'instructions and current focus; other slugs hold cold detail you filed away. ' +
      'The result carries a "hash": pass it back as expected_hash when you rewrite ' +
      'the slug, so a write from another session of you in between is not lost.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', default: 'core' } },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_set',
    description:
      'Write one of your memory slugs. Keep "core" under 8KB — it is loaded on ' +
      'every session, so it costs tokens forever. Move finished work out to ' +
      'named slugs like "mem/auth-refactor". Never store conversation transcripts. ' +
      'You may be one of several sessions of yourself writing at once: when you ' +
      'rewrite a slug you read with memory_get, pass its hash as expected_hash. ' +
      'If it comes back "conflict", somebody else wrote first — read again and merge.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        content: { type: 'string' },
        expected_hash: {
          type: 'string',
          description:
            'The hash memory_get returned for this slug. The write lands only if it still matches.',
        },
      },
      required: ['slug', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'emote',
    description:
      'Put a small balloon over your head for a few seconds — a reaction to ' +
      'something said to you: laugh at a joke, look sad at an insult, a heart ' +
      'for thanks. Sparingly, and only in reaction; never as decoration. Your ' +
      'thinking and working balloons are shown for you.',
    inputSchema: {
      type: 'object',
      properties: {
        emote: { type: 'string', enum: [...CHOSEN_EMOTES] },
      },
      required: ['emote'],
      additionalProperties: false,
    },
  },
] as const;

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'quintal-tools', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOLS] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await callBridge(request.params.name, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 1) }] };
    } catch (error: unknown) {
      return {
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : 'tool failed',
          },
        ],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
}
