import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { scrubbedEnv } from '../secrets.js';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type Client,
} from '@agentclientprotocol/sdk';
import type * as schema from '@agentclientprotocol/sdk';

/**
 * One ACP agent, running as a child process.
 *
 * We are the *client* in ACP terms: we spawn the agent (Claude Code behind its
 * adapter, Goose, Codex, anything) and speak newline-delimited JSON-RPC to it
 * over stdio. The agent's own loop stays entirely inside that process — Quintal
 * never runs model calls, which is what keeps this package small and the trust
 * story simple.
 */

export interface AgentProcessOptions {
  command: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Called for every `session/update` notification. */
  onUpdate: (params: schema.SessionNotification) => void;
  /** Called when the agent asks the user to approve a tool call. */
  onPermission: (
    params: schema.RequestPermissionRequest,
  ) => Promise<schema.RequestPermissionResponse>;
  /**
   * The agent wants the user to open a URL — an MCP server's sign-in, the
   * one kind Quintal answers. Without it the client does not offer URL
   * elicitation, and the runtime keeps a server that needs sign-in signed out.
   */
  onUrlElicitation?: (params: { sessionId?: string; elicitationId: string; url: string; message: string }) => Promise<'accept' | 'decline'>;
  /** The URL flow finished on the runtime's side: the sign-in landed. */
  onElicitationComplete?: (elicitationId: string) => void;
  /** Anything the agent writes to stderr — harness diagnostics, not chat. */
  onStderr?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class AgentProcess {
  #child: ChildProcessWithoutNullStreams | null = null;
  #connection: ClientSideConnection | null = null;
  #initialize: schema.InitializeResponse | null = null;

  constructor(private readonly options: AgentProcessOptions) {}

  get initialized(): schema.InitializeResponse | null {
    return this.#initialize;
  }

  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null;
  }

  /** Spawn the agent and complete the ACP handshake. */
  async start(): Promise<schema.InitializeResponse> {
    const [command, ...args] = this.options.command;
    if (!command) throw new Error('empty agent command');

    const child = spawn(command, args, {
      cwd: this.options.cwd,
      // The runtime is a model with a shell. It gets our environment minus
      // every credential we were handed — a key it could print is a key it
      // could be talked into printing.
      env: { ...scrubbedEnv(process.env), ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;

    child.stderr.setEncoding('utf8');
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length > 0) this.options.onStderr?.(line);
      }
    });

    child.on('exit', (code, signal) => {
      this.#child = null;
      this.#connection = null;
      this.options.onExit?.(code, signal);
    });

    // The SDK wants web streams; Node gives us node streams.
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    // `readTextFile`/`writeTextFile` are optional on Client and deliberately
    // not implemented: the agent has its own cwd and its own file tools, and
    // Quintal staying out of the agent's file operations is the trust boundary
    // this whole design rests on.
    const client: Client = {
      sessionUpdate: (params: schema.SessionNotification) => {
        this.options.onUpdate(params);
      },
      requestPermission: (params: schema.RequestPermissionRequest) =>
        this.options.onPermission(params),
      unstable_createElicitation: async (params: schema.CreateElicitationRequest) => {
        const request = params as { mode?: string; url?: string; elicitationId?: string; sessionId?: string; message?: string };
        // A form is a question for the user mid-turn; the office has cards
        // for tool approvals and nothing for free-form forms yet.
        if (request.mode !== 'url' || !request.url || !request.elicitationId || !this.options.onUrlElicitation) {
          return { action: 'decline' } as schema.CreateElicitationResponse;
        }
        const action = await this.options.onUrlElicitation({
          elicitationId: request.elicitationId,
          url: request.url,
          message: request.message ?? '',
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        });
        return { action } as schema.CreateElicitationResponse;
      },
      unstable_completeElicitation: (params: schema.CompleteElicitationNotification) => {
        this.options.onElicitationComplete?.(params.elicitationId);
      },
    };

    const connection = new ClientSideConnection(() => client, stream);
    this.#connection = connection;

    const initialize = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        // Unstable in ACP, and not in the SDK's type yet; claude-agent-acp reads
        // it to decide whether to hand an MCP server's sign-in URL over at all.
        ...(this.options.onUrlElicitation ? { elicitation: { url: {} } } : {}),
      },
      clientInfo: { name: 'quintal-acp', version: '0.0.1' },
    } as schema.InitializeRequest);

    this.#initialize = initialize;
    return initialize;
  }

  async newSession(params: schema.NewSessionRequest): Promise<schema.NewSessionResponse> {
    return this.#requireConnection().newSession(params);
  }

  /**
   * Reattach a session the agent stored, without replaying it to us.
   * Only for an agent that advertised `sessionCapabilities.resume`.
   */
  async resumeSession(params: schema.ResumeSessionRequest): Promise<schema.ResumeSessionResponse> {
    const connection = this.#requireConnection();
    if (typeof connection.resumeSession !== 'function') {
      throw new Error('this ACP connection does not support session/resume');
    }
    return connection.resumeSession(params);
  }

  /**
   * Reattach a session the agent stored, the older way: the agent replays
   * the conversation as `session/update`s first. Only for an agent that
   * advertised `loadSession`.
   */
  async loadSession(params: schema.LoadSessionRequest): Promise<schema.LoadSessionResponse> {
    const connection = this.#requireConnection();
    if (typeof connection.loadSession !== 'function') {
      throw new Error('this ACP connection does not support session/load');
    }
    return (await connection.loadSession(params)) ?? {};
  }

  async prompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    return this.#requireConnection().prompt(params);
  }

  /** Choose one of the options the agent advertised at `session/new`. */
  async setSessionConfigOption(
    params: schema.SetSessionConfigOptionRequest,
  ): Promise<schema.SetSessionConfigOptionResponse> {
    const connection = this.#requireConnection();
    // Optional in the SDK's eyes; an agent that advertised options and then
    // cannot be asked to pick one is a protocol bug worth naming, not a
    // silent fallback to the default.
    if (typeof connection.setSessionConfigOption !== 'function') {
      throw new Error('this ACP connection does not support session/set_config_option');
    }
    return connection.setSessionConfigOption(params);
  }

  /**
   * Switch a session's mode — how the runtime decides what it may run.
   *
   * Standard ACP (`session/set_mode`, from the `modes` a session advertises),
   * unlike the config-option path above. An adapter that offered modes and
   * then cannot be asked to pick one is a protocol bug worth naming.
   */
  async setSessionMode(params: schema.SetSessionModeRequest): Promise<void> {
    const connection = this.#requireConnection();
    if (typeof connection.setSessionMode !== 'function') {
      throw new Error('this ACP connection does not support session/set_mode');
    }
    // The reply carries nothing we act on; what matters is that it resolved.
    await connection.setSessionMode(params);
  }

  /** Fire-and-forget: ACP cancellation is a notification, not a request. */
  cancel(sessionId: string): void {
    void this.#connection?.cancel({ sessionId }).catch(() => {
      // The agent may already have finished; nothing to recover.
    });
  }

  stop(): void {
    const child = this.#child;
    this.#child = null;
    this.#connection = null;
    if (!child) return;

    child.kill('SIGTERM');
    // Escalate if the agent ignores SIGTERM — a stuck subprocess would keep the
    // whole fleet alive after ctrl-c.
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    timer.unref();
  }

  #requireConnection(): Agent {
    if (!this.#connection) throw new Error('agent process is not running');
    return this.#connection;
  }
}
