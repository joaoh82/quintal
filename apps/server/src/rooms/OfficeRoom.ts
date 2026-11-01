import { latencyRequestId } from '@quintal/shared';
import { activityTerminal, parseActivity, type PublicActivity } from '@quintal/shared';
import {
  APPROVAL_MAX_PER_AGENT,
  APPROVAL_MAX_PER_ROOM,
  parseApprovalDecide,
  parseApprovalRequest,
  parseApprovalResolved,
  type AgentApprovalDecisionEvent,
  type ApprovalDecidePayload,
  type ApprovalResolved,
  type PublicApprovalRequest,
  type PublicApprovalResolved,
} from '@quintal/shared';
import {
  canSeeApproval,
  expiredApprovals,
  forgettableApprovals,
  judgeDecision,
  needsPrivateCopy,
  resumableApproval,
  type TrackedApproval,
} from './approvals.js';
import { keepActivity, readActivity, findActivity } from '@quintal/shared/db';
import { ErrorCode, Room, ServerError, type Client, logger } from '@colyseus/core';
import {
  AGENT_BOARD_WRITE_WINDOW_MS,
  AGENT_BOARD_WRITES_PER_WINDOW,
  AGENT_CHAT_INTERVAL_MS,
  AGENT_CORE_MEMORY_MAX_BYTES,
  AGENT_HEARTBEAT_MS,
  AGENT_MEMORY_MAX_BYTES,
  AGENT_MOVE_INTERVAL_MS,
  AGENT_PARALLELISM_MAX,
  AGENT_REVOCATION_POLL_MS,
  AGENT_STATUS_MAX_LENGTH,
  BOARD_LEDGER_ENDED_MAX,
  BOARD_LEDGER_ENDED_PER_AGENT_MAX,
  AgentMessage,
  AgentServerMessage,
  CHAT_LOG_LIMIT,
  CHANNEL_POST_MAX_LENGTH,
  CHAT_MAX_LENGTH,
  ClientMessage,
  DEFAULT_OFFICE_SETTINGS,
  EMOTE_TTL_DEFAULT_MS,
  EMOTE_TTL_MAX_MS,
  FLOOR_ZONE_ID,
  MESSAGES_GET_MAX,
  isEmote,
  OfficePlayer,
  OfficeState,
  READ_RATE_LIMIT,
  READ_RATE_WINDOW_MS,
  RECONNECTION_SECONDS,
  ServerMessage,
  TICK_MS,
  createPlayer,
  directionFromIntent,
  findPath,
  followPath,
  memoryLimitFor,
  nearestWalkable,
  normalize,
  spawnFor,
  stepMovement,
  tileCentre,
  toTile,
  isAddressed,
  channelLabel,
  addressedNames,
  messageMaxLength,
  zoneAt,
  type AgentBanterEvent,
  type AgentChannelChatEvent,
  type AgentCommandCall,
  type AgentTeam,
  type AgentChannelsEvent,
  type AgentChatEvent,
  type AgentMentionEvent,
  type AgentEmotePayload,
  type AgentErrorPayload,
  type AgentLookAroundPayload,
  type AgentMemoryGetPayload,
  type AgentHostReportPayload,
  type AgentMemorySetPayload,
  type AgentMessagesGetPayload,
  type AgentRequest,
  type AgentBoardCreatePayload,
  type AgentBoardGetPayload,
  type AgentBoardListPayload,
  type AgentBoardUpdatePayload,
  type BoardGetResult,
  type BoardListResult,
  type BoardWriteResult,
  type AgentCommandCreatePayload,
  type AgentCommandGetPayload,
  type AgentCommandListPayload,
  type AgentCommandRef,
  type AgentCommandUpdatePayload,
  type CommandGetResult,
  type CommandListResult,
  type CommandWriteResult,
  type AgentMoveToPayload,
  type AgentOccupant,
  type AgentReadyPayload,
  type AgentResultPayload,
  type AgentRosterEvent,
  type AgentSayPayload,
  type AgentSetStatusPayload,
  mayAddToChannel,
  mayOpenDm,
  type ChannelActor,
  type ChannelChatPayload,
  type ChannelChatSendPayload,
  type ChannelJoinPayload,
  type EarshotPayload,
  type ChannelLeavePayload,
  type ReadPayload,
  type ChannelRef,
  type ChannelSubject,
  type ChannelsPayload,
  type DmOpenPayload,
  type DmOpenedPayload,
  type FollowZonePayload,
  type MembershipRole,
  type ZoneChatPayload,
  type ChatBroadcastPayload,
  type ChatSendPayload,
  type Direction,
  type ErrorPayload,
  type NoticePayload,
  type HistoryGetPayload,
  type HistoryPayload,
  type InputPayload,
  type LookAroundResult,
  type MapZone,
  type MemoryGetResult,
  type MemorySetResult,
  type MessagesGetResult,
  type MoveIntent,
  type OfficeMap,
  type OfficeSettings,
  type StatusPayload,
  type TilePoint,
  type WalkToPayload,
  WORKING_IN_ZONE,
  agentTaskOf,
  parseAgentTask,
  isBoardStatus,
  isPullRequestAction,
  mayAssignBoardItem,
  mayCreateOfficeCommands,
  mayEditOfficeCommand,
  mayManageRoutine,
  normaliseOfficeCommandName,
  officeCommandAuthorLabel,
  officeCommandUsage,
  mayDeleteBoardItem,
  mayWriteBoard,
  noteForTask,
  parseBoardCreate,
  parseBoardUpdate,
  type AgentTask,
  type BoardAgentRef,
  type BoardDeletePayload,
  type BoardGithubRef,
  type BoardPullActionPayload,
  type BoardPullRefreshPayload,
  type BoardPullReviewPayload,
  type PullRequestStatusRef,
  type RepoPullsRef,
  NO_REPO_PULLS,
  type BoardItemRef,
  type BoardMessagePayload,
  type BoardTaskRef,
  type BoardPullReviewRef,
} from '@quintal/shared';
import {
  BoardItemError,
  createBoardItem,
  deleteBoardItem,
  endAgentTasks,
  findBoardItemByNumber,
  findUnlinkedItemForAgent,
  listAgentTasksForWorkspace,
  getBoardItem,
  boardGithubOf,
  describeOfficeGithub,
  pullRequestStatusesForWorkspace,
  listPullReviewRequests,
  BOARD_PULL_REVIEWS_MAX,
  recordBoardEvent,
  type RecordBoardEventInput,
  noteAgentTask,
  listBoardAgentsForWorkspace,
  listBoardItemsForWorkspace,
  updateBoardItem,
  MemoryConflictError,
  MemoryLimitError,
  MemorySlugError,
  memoryHash,
  addChannelMember,
  channelMembershipForWorkspace,
  ensureZoneConversations,
  findAgentById,
  findMembership,
  getAgentMemory,
  latestMessageAtByConversation,
  markRead,
  readCursorsForMember,
  listAgentsForWorkspace,
  listTeamsForWorkspace,
  teamRef,
  type TeamSummary,
  listOfficeCommandsForWorkspace,
  officeCommandRef,
  OfficeCommandError,
  createOfficeCommand,
  updateOfficeCommand,
  claimRoutineRun,
  getRoutine,
  listDueRoutines,
  markRoutineRan,
  missedRoutineRuns,
  settleRoutineRun,
  updateRoutine,
  type RoutineRunRef,
  type RoutineSummary,
  type OfficeCommandSummary,
  type OfficeCommandTargetInput,
  listPeopleForWorkspace,
  removeChannelMember,
  getDb,
  getOfficeSettings,
  mcpServersForAgents,
  setAgentMcpStatus,
  mentionsOf,
  openDm,
  recentMessages,
  recentMessagesNear,
  recordMessage,
  setAgentMemory,
  type AgentIdentity,
  type ChannelMember,
  type MessagePage,
  type StoredMessage,
} from '@quintal/shared/db';
import { loadOfficeMap } from '@quintal/shared/maps';
import {
  EarshotTracker,
  parseMcpStatus,
  tileBeside,
  withSeatOpen,
  type AgentCredentialKind,
  type AgentMcpServer,
  type AgentMcpServersEvent,
  type EarshotPlayer,
  type MapSeat,
  type Pose,
} from '@quintal/shared';

import { agentBelongsToOffice, mayEnterOffice } from '../auth/office.js';

import {
  allowChat,
  allowEmote,
  allowMove,
  audit,
  authenticateAgent,
  authenticateHostAgent,
  findRevoked,
  hasScope,
  markSeen,
  persistHostReport,
  persistStatus,
  type AgentSession,
} from '../agents/gateway.js';
import { authenticateAgentKeypair } from '../agents/keypair.js';
import {
  SentChannelLists,
  agentTeamsSignature,
  channelListSignature,
  officeCommandsSignature,
} from './channel-list.js';
import { SPATIAL, WakeHops, hopOf, mayWake } from './hops.js';
import { LatestRead } from './latest-read.js';
import { absentNotice, resolveMentions, type Addressable, type TeamRoster } from './mentions.js';
import {
  commandCallFor,
  commandReach,
  commandTaken,
  readCommandLine,
  unheardNotice,
} from './commands.js';
import { workingSinceAfter } from './working-since.js';
import { applyAgentTask } from './agent-task.js';
import { assignmentBrief, assignmentLine, boardStatusAfterTask, handoverLine, reviewBrief, reviewLine, reviewTargetOf } from './board-brief.js';
import { ROUTINE_TICK_MS, decideSlot, routineBrief, routineLine, shouldMakeUp } from './routine-brief.js';

/** Where a routine speaks and whether its agent is there: see `OfficeRoom#routineWhere`. */
interface RoutineWhere {
  actor: ChannelActor;
  channel: (ChannelRef & { members: ReadonlyMap<string, ChannelMember> }) | null;
  sessionId: string | null;
  agent: { present: boolean; busyHere: boolean };
}
import { boardAgentsOf, boardForRole, boardSignatureOf, type BoardView } from './board-view.js';
import { PULL_POLL_MS, PullActionError, PullRequestWatch, REPO_PULLS_REFRESH_MIN_MS } from '../github/pulls.js';
import { voiceRelay } from '../voice/index.js';
import { config } from '../config.js';
import { displayNameFor, verifySessionToken } from '../auth/session.js';
import { ChatRateLimiter } from './chat-limiter.js';
import {
  BANTER_STAGE_MS,
  SMALL_TALK_MS,
  SMALL_TALK_REPLY_MS,
  banterOver,
  between,
  idleCapable,
  mayBanter,
  newBanterLedger,
  newIdleRecord,
  noteBanter,
  pickSmallTalk,
  stepIdle,
  touch,
  wake,
  wanderTarget,
  zoneIdAt,
  type Banter,
  type BanterLedger,
  type IdleRecord,
} from './idle-life.js';
import { SeatBook, seated, wantedPose } from './seating.js';

interface OfficeRoomOptions {
  mapId?: unknown;
  /**
   * Which office this room is. Routing only — `filterBy` puts callers asking
   * for the same value in the same room, and nothing more. It is not a
   * permission: a caller can ask for any workspace id it likes, so `onAuth`
   * proves the claim before anybody is let in.
   */
  workspaceId?: unknown;
  token?: unknown;
  agentKey?: unknown;
  /** A machine's credential, used with `agentId` instead of an agent key. */
  hostToken?: unknown;
  agentId?: unknown;
  /** Credentials v2: the agent's own key, a signed challenge. See `agents/keypair.ts`. */
  agentPubkey?: unknown;
  sig?: unknown;
  nonce?: unknown;
  timestamp?: unknown;
}

/** What `onAuth` hands to `onJoin`. Humans and agents come through one door. */
type JoinAuth =
  | {
      kind: 'human';
      userId: string;
      name: string;
      isGuest: boolean;
      description: string;
      pubkey: string;
      avatar: string;
    }
  | { kind: 'agent'; identity: AgentIdentity; credential: AgentCredentialKind };

interface PlayerSim {
  intent: MoveIntent;
  path: TilePoint[];
  away: boolean;
  /** Set for agents; absent for humans. */
  agent?: AgentSession;
  /**
   * The walk in progress is the office's idea, not the agent's — a wander,
   * or stepping over for a chat. Not audited, not reported back, and the
   * first thing cancelled when anything real happens.
   */
  idleWalk?: boolean;
  /**
   * The walk in progress is to the agent's own desk, to sit down on arrival.
   * Like `idleWalk`, the office's idea: not audited, and replaced by any walk
   * somebody meant.
   */
  seatWalk?: boolean;
  /**
   * The pose the office last arranged for this session (see `seating.ts`):
   * recorded when it walked the agent to its desk, sat it down or got it up,
   * and left alone when it could not — a desk wanted and not had is asked
   * about again. Kept so the walk to the desk happens on the change — a turn
   * starting, a task taken — and not every second: an agent its model has
   * walked across the room mid-turn stays where it was sent, standing, until
   * the next change.
   */
  arranged?: Pose;
  /**
   * The last movement command read, not yet published as `inputSeq`. Held
   * until the tick that acts on it, so the count never reaches the browser
   * in a patch whose position the command has not produced yet.
   */
  pendingSeq?: number;
}

const STATUS_MAX_LENGTH = 60;
/** How often earshot is recomputed for voice, in ms. */
const EARSHOT_SWEEP_MS = 250;

/** Tiles of clearance an arriving agent tries to leave around everyone else. */
const AGENT_SPAWN_GAP_TILES = 4;

/**
 * The office.
 *
 * Authoritative: clients send *intent* and the server decides where anybody
 * actually is. That applies identically to humans and agents — an agent asks to
 * walk somewhere and the server walks it, at human speed, along a real path.
 * There is no message in either protocol that sets a position, so nothing can
 * teleport and nothing can outrun a person.
 *
 * Agents are first-class occupants and deliberately conspicuous ones: they hold
 * the same kind of slot in room state as a human, carry `kind: "agent"` so every
 * consumer can mark them, and are attributed to an owner everywhere they appear.
 */
export class OfficeRoom extends Room<OfficeState> {
  override maxClients = 64;

  #map!: OfficeMap;
  readonly #sims = new Map<string, PlayerSim>();
  readonly #chatLimiter = new ChatRateLimiter();
  /**
   * The same limiter, for read cursors. Its own window rather than chat's:
   * a read is not speech, and a person catching up across a dozen channels
   * must not find their next sentence refused for it.
   */
  readonly #readLimiter = new ChatRateLimiter(READ_RATE_LIMIT, READ_RATE_WINDOW_MS);
  /**
   * Board writes by agents, per agent, over a sliding window. Speech and
   * movement are paced per verb; the board is paced as a whole, because a
   * note written and a note changed cost the room the same: a re-read of
   * the board and a copy to everybody in it.
   */
  readonly #boardPace = new ChatRateLimiter(AGENT_BOARD_WRITES_PER_WINDOW, AGENT_BOARD_WRITE_WINDOW_MS);
  /** Command writes, paced like board writes and counted apart from them. */
  readonly #commandPace = new ChatRateLimiter(AGENT_BOARD_WRITES_PER_WINDOW, AGENT_BOARD_WRITE_WINDOW_MS);
  /**
   * zoneId -> conversation id, for every zone on this map in this office.
   *
   * A promise because it is filled from the database when the room opens and
   * the first message can arrive before that returns. Anything that needs a
   * conversation awaits it; nothing else waits on it.
   */
  #conversations: Promise<ReadonlyMap<string, string>> = Promise.resolve(new Map());

  /**
   * Every channel in this office and who is in it, refreshed on the settings
   * cadence. Membership is changed from the settings page, in another
   * process in development, so this polls like everything else that is.
   */
  #channels: ReadonlyMap<string, ChannelRef & { members: ReadonlyMap<string, ChannelMember> }> =
    new Map();
  /**
   * conversation id -> when the newest line in it was said. Read with the
   * channels and kept current from every line delivered here, so a client
   * that arrives can tell a channel with news from one without before it
   * has opened either.
   */
  readonly #lastMessageAt = new Map<string, number>();
  /**
   * member id -> conversation id -> when they last looked.
   *
   * Keyed by member rather than by session, because the whole point of
   * keeping this in the office is that a person's two devices are one
   * reader: the laptop marking a channel read is the phone's news too.
   * Loaded when they arrive and dropped when their last session goes.
   */
  readonly #readCursors = new Map<string, Map<string, number>>();
  /**
   * The office's teams, refreshed with the channels. A mention resolves
   * against them; an agent is told which it is on when it connects.
   */
  #teams: readonly TeamSummary[] = [];
  /**
   * The office's own `!` commands, refreshed with the channels. A line that
   * is one carries its instructions to the agents it reaches; a person is
   * sent the list for the picker.
   */
  #commands: readonly OfficeCommandSummary[] = [];
  /**
   * The office board, refreshed with the channels and after every change
   * made here. Sent whole: it is a wall of notes, not a feed.
   */
  #boardItems: readonly BoardItemRef[] = [];
  #boardAgents: readonly BoardAgentRef[] = [];
  #boardTasks: readonly BoardTaskRef[] = [];
  /** Whether the office has a GitHub token, and whose. The token itself never comes up here. */
  #boardGithub: BoardGithubRef = { connected: false, login: null, repos: [] };
  /** What GitHub last said about each ledger line's pull request, by task id. */
  #pullStatuses: ReadonlyMap<string, PullRequestStatusRef> = new Map();
  /** Every pull request of the repositories on the office's list, as last listed. */
  #repoPulls: RepoPullsRef = NO_REPO_PULLS;
  /** Who was asked from the board to review which pull request, newest first. */
  #boardReviews: readonly BoardPullReviewRef[] = [];
  /** The office's eye on GitHub. Made with the room; the token is read as needed. */
  #pulls!: PullRequestWatch;
  #pullTimer: NodeJS.Timeout | null = null;
  #routineTimer: NodeJS.Timeout | null = null;
  /** One tick at a time: a slow database must not stack ticks that each claim the same slots. */
  #routineTicking = false;
  /** What the board looked like when it was last sent, so an unchanged one is not sent again. */
  #boardSignature = '';
  /** The first read of the board, so a `board_get` that beats it still gets an answer. */
  #boardLoaded: Promise<void> | null = null;
  /** Reads of the board may overlap; only the newest started may land. */
  readonly #boardReads = new LatestRead();
  /**
   * sessionId -> a person's role in the office, as last read. The board is
   * sent with "where you stand" so the panel can hide what the office would
   * refuse, and that must not cost a query per send. It is a hint for the
   * panel only: every write reads the membership afresh, and corrects this.
   */
  readonly #roles = new Map<string, MembershipRole | null>();
  /**
   * Per agent, per conversation: the hop of the line that last woke it, so
   * its reply can be stamped one further and a chain of agents naming each
   * other stops where `AGENT_MENTION_MAX_HOPS` says. See `hops.ts`.
   */
  readonly #wakeHops = new WakeHops();
  /**
   * The channel list last sent to each session, so a change is sent once —
   * and a request is answered whatever was sent before it. See `channel-list.ts`.
   */
  readonly #channelsSent = new SentChannelLists();
  /** The MCP server list each connected agent was last given, by fingerprint. */
  readonly #mcpSent = new Map<string, string>();
  /**
   * sessionId -> the zone they are reading live from elsewhere. One per
   * person: a transcript you have open, not a wiretap on the office.
   */
  readonly #followed = new Map<string, string>();
  readonly #activity = new Map<string, { value: PublicActivity; owner: string; conversationId: string; x: number; y: number }>();
  readonly #activityPending = new Map<string, Map<string, unknown>>();
  readonly #activityBusy = new Set<string>();
  /**
   * Tool approvals waiting on their owners, by the harness's request id.
   *
   * The id is the whole routing rule: an answer names one, and only its
   * owner's may land. Two agents asking about `Bash` in two conversations
   * are two entries here and can never be confused for each other.
   */
  readonly #approvals = new Map<string, TrackedApproval>();

  #nextEmoteSweep = 0;
  /** sessionId -> a balloon asked for inside the flicker interval, applied when it is up. */
  readonly #emoteLater = new Map<
    string,
    { timer: NodeJS.Timeout; wanted: { emote: string; ttlMs: number; chosen: boolean } }
  >();
  /** sessionId -> agent identity, for everyone in the room who isn't a person. */
  readonly #agents = new Map<string, AgentIdentity>();
  /**
   * Which door each agent session came through, kept so a reconnect can say
   * so too. A resumed session opened no new door, but an owner reading the
   * log for what is left on a host token should not find rows that go quiet.
   */
  readonly #credentials = new Map<string, AgentCredentialKind>();
  /**
   * Who can hear whom, for voice. Computed here, from positions, on the
   * tick — never by the relay and never by a client. Agents never enter it.
   */
  readonly #earshot = new EarshotTracker();
  #nextEarshotSweep = 0;
  /** sessionId -> what an agent with nothing to do is up to. See `idle-life.ts`. */
  readonly #idle = new Map<string, IdleRecord>();
  /** Which agent holds which desk. See `seating.ts`. */
  #seats!: SeatBook;
  /** seat id -> the map with that one chair open, built once each. */
  readonly #seatMaps = new Map<string, OfficeMap>();
  /** zoneId -> when the next small talk may start there. */
  readonly #nextTalkAt = new Map<string, number>();
  /** What banter has cost today, and who has had their turn. */
  readonly #banter: BanterLedger = newBanterLedger();
  #heartbeatTimer?: NodeJS.Timeout;
  #revocationTimer?: NodeJS.Timeout;
  #settingsTimer?: NodeJS.Timeout;

  /** Refreshed from the database, so a change in /settings takes effect live. */
  #settings: OfficeSettings = { ...DEFAULT_OFFICE_SETTINGS };

  /**
   * Who addressed whom from out of earshot, and when.
   *
   * Being reachable by name across the map is only half a conversation: without
   * this, an agent summoned from the far side of the office answers into empty
   * air, because its reply travels by normal proximity. Keyed
   * `speaker -> [listeners]`, short-lived, so a reply finds the person who
   * asked and nobody else.
   */
  readonly #awaitingReply = new Map<string, Map<string, number>>();

  override onCreate(options: OfficeRoomOptions): void {
    // Set here rather than on the first join: the room *is* one office, and its
    // settings are read before anybody has authenticated. `filterBy` guarantees
    // every later join carries the same value, and `onAuth` refuses one that
    // does not.
    this.#workspaceId = typeof options.workspaceId === 'string' ? options.workspaceId : '';
    const mapId = typeof options.mapId === 'string' ? options.mapId : 'hq';
    this.#map = loadOfficeMap(mapId);
    this.#seats = new SeatBook(this.#map.seats.map((seat) => seat.id));

    const state = new OfficeState();
    state.mapId = mapId;
    this.state = state;

    this.#conversations = this.#openConversations(mapId);

    this.setPatchRate(TICK_MS);
    this.setSimulationInterval((deltaMs) => this.#tick(deltaMs), TICK_MS);

    // The relay learns of this office from the office, not the other way
    // round: it asks the room who a session is, and the room tells it what
    // changed. A room is the only thing that knows both.
    voiceRelay.registerRoom({
      roomId: this.roomId,
      workspaceId: this.#workspaceId,
      human: (sessionId) => this.#voiceHuman(sessionId),
    });

    // --- human protocol ---
    this.onMessage(ClientMessage.Input, (client, payload: InputPayload) =>
      this.#onInput(client, payload),
    );
    this.onMessage(ClientMessage.WalkTo, (client, payload: WalkToPayload) =>
      this.#onWalkTo(client, payload),
    );
    this.onMessage(ClientMessage.Chat, (client, payload: ChatSendPayload) =>
      this.#onChat(client, payload?.text, latencyRequestId(payload?.requestId)),
    );
    this.onMessage(ClientMessage.SetStatus, (client, payload: StatusPayload) =>
      this.#onStatus(client, payload?.status),
    );
    this.onMessage(ClientMessage.HistoryGet, (client, payload: HistoryGetPayload) =>
      void this.#onHistoryGet(client, payload),
    );
    this.onMessage(ClientMessage.ChannelChat, (client, payload: ChannelChatSendPayload) =>
      this.#onChannelChat(client, payload),
    );
    this.onMessage(ClientMessage.ChannelsGet, (client) => {
      // Asked, so answered: a list pushed before the browser was listening —
      // the one that follows a join — was dropped on the floor, and the
      // answer must not be skipped for matching it.
      this.#channelsSent.asked(client.sessionId);
      this.#sendChannels(client.sessionId);
    });
    // For the voice client's own arithmetic — how loud somebody is by
    // distance, whether a second person is close enough to open a socket
    // for. Asked for, not pushed at join: a message sent before the scene
    // has its handlers is sent to nobody. Receipt of audio is decided here.
    this.onMessage(ClientMessage.EarshotGet, (client) => this.#sendEarshot(client));
    this.onMessage(ClientMessage.DmOpen, (client, payload: DmOpenPayload) =>
      void this.#onDmOpen(client, payload),
    );
    this.onMessage(ClientMessage.FollowZone, (client, payload: FollowZonePayload) =>
      this.#onFollowZone(client, payload),
    );
    this.onMessage(ClientMessage.ChannelJoin, (client, payload: ChannelJoinPayload) =>
      void this.#onChannelJoin(client, payload),
    );
    this.onMessage(ClientMessage.Read, (client, payload: ReadPayload) =>
      this.#onRead(client, payload),
    );
    this.onMessage(ClientMessage.ChannelLeave, (client, payload: ChannelLeavePayload) =>
      void this.#onChannelLeave(client, payload),
    );
    this.onMessage(ClientMessage.ApprovalDecide, (client, payload: unknown) =>
      this.#onApprovalDecide(client, payload),
    );
    this.onMessage(ClientMessage.BoardGet, (client) => void this.#onBoardGet(client));
    this.onMessage(ClientMessage.BoardCreate, (client, payload: unknown) =>
      void this.#onBoardCreate(client, payload),
    );
    this.onMessage(ClientMessage.BoardUpdate, (client, payload: unknown) =>
      void this.#onBoardUpdate(client, payload),
    );
    this.onMessage(ClientMessage.BoardDelete, (client, payload: BoardDeletePayload) =>
      void this.#onBoardDelete(client, payload),
    );
    this.onMessage(ClientMessage.BoardPullRefresh, (client, payload: unknown) =>
      void this.#onBoardPullRefresh(client, payload),
    );
    this.onMessage(ClientMessage.BoardPullAction, (client, payload: unknown) =>
      void this.#onBoardPullAction(client, payload),
    );
    this.onMessage(ClientMessage.BoardPullReview, (client, payload: unknown) =>
      void this.#onBoardPullReview(client, payload),
    );

    // --- agent protocol (docs/GATEWAY.md) ---
    this.onMessage('agent:activity', (client, payload: unknown) => {
      if (!this.#agents.has(client.sessionId)) return;
      const value = parseActivity(payload);
      if (!value) return;
      const pending = this.#activityPending.get(client.sessionId) ?? new Map<string, unknown>();
      if (pending.size >= 128 && !pending.has(value.turnId)) return;
      const previous = pending.get(value.turnId) as PublicActivity | undefined;
      if (!previous || previous.sequence < value.sequence) pending.set(value.turnId, value);
      this.#activityPending.set(client.sessionId, pending);
      void this.#drainActivity(client);
    });
    this.onMessage(AgentMessage.ApprovalRequest, (client, payload: unknown) =>
      void this.#onApprovalRequest(client, payload),
    );
    this.onMessage(AgentMessage.ApprovalResolved, (client, payload: unknown) =>
      this.#onApprovalResolved(client, payload),
    );
    this.onMessage(AgentMessage.Say, (client, payload: AgentSayPayload) =>
      this.#onAgentSay(client, payload),
    );
    this.onMessage(AgentMessage.MoveTo, (client, payload: AgentMoveToPayload) =>
      this.#onAgentMoveTo(client, payload),
    );
    this.onMessage(AgentMessage.SetStatus, (client, payload: AgentSetStatusPayload) =>
      this.#onAgentSetStatus(client, payload),
    );
    this.onMessage(AgentMessage.Emote, (client, payload: AgentEmotePayload) =>
      this.#onAgentEmote(client, payload),
    );
    this.onMessage(AgentMessage.LookAround, (client, payload: AgentLookAroundPayload) =>
      this.#onAgentLookAround(client, payload),
    );
    this.onMessage(AgentMessage.MessagesGet, (client, payload: AgentMessagesGetPayload) =>
      this.#onAgentMessagesGet(client, payload),
    );
    this.onMessage(AgentMessage.BoardList, (client, payload: AgentBoardListPayload) =>
      void this.#onAgentBoardList(client, payload),
    );
    this.onMessage(AgentMessage.BoardGet, (client, payload: AgentBoardGetPayload) =>
      void this.#onAgentBoardGet(client, payload),
    );
    this.onMessage(AgentMessage.BoardCreate, (client, payload: AgentBoardCreatePayload) =>
      void this.#onAgentBoardCreate(client, payload),
    );
    this.onMessage(AgentMessage.BoardUpdate, (client, payload: AgentBoardUpdatePayload) =>
      void this.#onAgentBoardUpdate(client, payload),
    );
    this.onMessage(AgentMessage.CommandList, (client, payload: AgentCommandListPayload) =>
      void this.#onAgentCommandList(client, payload),
    );
    this.onMessage(AgentMessage.CommandGet, (client, payload: AgentCommandGetPayload) =>
      void this.#onAgentCommandGet(client, payload),
    );
    this.onMessage(AgentMessage.CommandCreate, (client, payload: AgentCommandCreatePayload) =>
      void this.#onAgentCommandCreate(client, payload),
    );
    this.onMessage(AgentMessage.CommandUpdate, (client, payload: AgentCommandUpdatePayload) =>
      void this.#onAgentCommandUpdate(client, payload),
    );
    this.onMessage(AgentMessage.MemoryGet, (client, payload: AgentMemoryGetPayload) =>
      void this.#onAgentMemoryGet(client, payload),
    );
    this.onMessage(AgentMessage.MemorySet, (client, payload: AgentMemorySetPayload) =>
      void this.#onAgentMemorySet(client, payload),
    );
    this.onMessage(AgentMessage.HostReport, (client, payload: AgentHostReportPayload) =>
      this.#onAgentHostReport(client, payload),
    );
    this.onMessage(AgentMessage.Task, (client, payload: unknown) =>
      this.#onAgentTask(client, payload),
    );
    this.onMessage(AgentMessage.McpStatus, (client, payload: unknown) =>
      this.#onAgentMcpStatus(client, payload),
    );

    void this.#refreshSettings();
    void this.#refreshChannels();
    this.#pulls = new PullRequestWatch({ db: getDb(), workspaceId: this.#workspaceId, apiBase: config.githubApi, webHost: config.githubWebHost });
    this.#boardLoaded = this.#refreshBoard();
    // GitHub is asked about the ledger's pull requests while somebody is here
    // to see the answer. The first look is a minute in: the board is read
    // first, and a room nobody stays in asks nothing.
    this.#pullTimer = setInterval(() => void this.#pollPulls(), PULL_POLL_MS);
    // Routines fire whether or not a person is here: the point of one is
    // that the agent works while its owner is not watching.
    this.#routineTimer = setInterval(() => void this.#tickRoutines(), ROUTINE_TICK_MS);
    this.#settingsTimer = setInterval(() => {
      void this.#refreshSettings();
      void this.#refreshChannels();
      void this.#refreshMcpServers();
      void this.#refreshBoard();
    }, 10_000);

    this.#heartbeatTimer = setInterval(() => {
      this.#sendHeartbeats();
      for (const entry of this.#activity.values()) {
        if (!activityTerminal(entry.value.state) && Date.now() - entry.value.receivedAt > 360_000) {
          this.#closeActivity(entry, 'interrupted');
        }
      }
      // A harness that died mid-question cannot say the question expired.
      // The deadline is on the card, so the office can say it instead.
      for (const requestId of expiredApprovals(this.#approvals)) {
        this.#closeApproval(requestId, 'expired');
      }
      for (const requestId of forgettableApprovals(this.#approvals)) {
        this.#approvals.delete(requestId);
      }
    }, AGENT_HEARTBEAT_MS);
    this.#revocationTimer = setInterval(
      () => void this.#kickRevokedAgents(),
      AGENT_REVOCATION_POLL_MS,
    );

    logger.info(`[office] room ${this.roomId} created on map "${mapId}"`);
  }

  /**
   * One door, four credentials. An agent presents its own key as a signed
   * challenge (`{ agentPubkey, sig, nonce, timestamp }` — credentials v2); an
   * agent may still present `{ agentKey }`, and a machine running an
   * office-defined agent `{ hostToken, agentId }`, while legacy credentials
   * are on; a human presents a Better Auth session token. Anything else is
   * turned away.
   */
  /**
   * The office this room belongs to, learned from the first join that created
   * it and identical for every later one — `filterBy` guarantees that.
   */
  #workspaceId = '';

  override async onAuth(_client: Client, options: OfficeRoomOptions): Promise<JoinAuth> {
    // An office is a workspace. One room per office, and nothing crosses:
    // agents belong to the office that defined them, people to the office they
    // are a member of. Before this, rooms were keyed by map alone, so every
    // workspace on a deployment shared one room — you could see, address and
    // talk to agents somebody else owned, in an office you had no part in.
    const workspaceId = typeof options.workspaceId === 'string' ? options.workspaceId : '';
    if (workspaceId.length === 0) {
      throw new ServerError(ErrorCode.AUTH_FAILED, 'No office was named in this join.');
    }
    // Belt and braces behind `filterBy`: if routing ever put two offices in one
    // room, this refuses rather than quietly merging them. Deliberately no
    // "adopt it if unset" fallback — the room's office is decided in `onCreate`,
    // and a line that took it from whoever joined first would let a claim
    // become the answer.
    if (workspaceId !== this.#workspaceId) {
      throw new ServerError(ErrorCode.AUTH_FAILED, 'That is not this office.');
    }

    // ServerError, not Error: a plain throw reaches the client as an empty
    // 4213 with no message, which for a documented public protocol means an
    // agent developer gets a bare number and no idea what they did wrong.
    // Credentials v2: a key the office never minted, vouched for by its owner.
    // Checked first because it is the one credential the office cannot forge.
    if (options.agentPubkey !== undefined) {
      const result = await authenticateAgentKeypair(options, workspaceId);
      if (!result.ok) throw new ServerError(ErrorCode.AUTH_FAILED, result.message);
      return { kind: 'agent', identity: result.identity, credential: 'v2' };
    }

    // The two bearer credentials. Off by a flag once every harness speaks v2;
    // refused with the flag's name so an operator who turned it off on purpose
    // and an agent that was never migrated both get told the same thing.
    if (
      !config.legacyAgentKeys &&
      (options.hostToken !== undefined || options.agentKey !== undefined)
    ) {
      throw new ServerError(
        ErrorCode.AUTH_FAILED,
        'This office no longer accepts agent keys or host-token joins (AGENT_LEGACY_KEYS=false). Register a keypair for this agent — see docs/GATEWAY.md, "Credentials v2".',
      );
    }

    // A machine acting as one of its owner's agents. Checked before the agent
    // key because it carries an explicit agent id; an agent key carries only itself.
    if (options.hostToken !== undefined) {
      const identity = await authenticateHostAgent(options.hostToken, options.agentId);
      if (!identity) {
        throw new ServerError(
          ErrorCode.AUTH_FAILED,
          'Unknown or revoked host token, or that agent is not yours. Manage machines at /settings/agents.',
        );
      }
      if (!agentBelongsToOffice(identity, workspaceId)) {
        throw new ServerError(ErrorCode.AUTH_FAILED, 'That agent belongs to another office.');
      }
      return { kind: 'agent', identity, credential: 'host' };
    }

    if (options.agentKey !== undefined) {
      const identity = await authenticateAgent(options.agentKey);
      if (!identity) {
        throw new ServerError(
          ErrorCode.AUTH_FAILED,
          'Unknown or revoked agent key. Create one at /settings/agents.',
        );
      }
      if (!agentBelongsToOffice(identity, workspaceId)) {
        throw new ServerError(ErrorCode.AUTH_FAILED, 'That agent belongs to another office.');
      }
      return { kind: 'agent', identity, credential: 'key' };
    }

    const user = await verifySessionToken(options.token);
    if (!user) {
      throw new ServerError(ErrorCode.AUTH_FAILED, 'No valid session. Sign in again.');
    }

    // A guest has no membership on purpose, so their one office is the one
    // their link was for. A member's is any they belong to. Either way the
    // claim is proved here, never taken from the join.
    if (!(await mayEnterOffice(user, workspaceId))) {
      throw new ServerError(
        ErrorCode.AUTH_FAILED,
        user.isGuest
          ? 'That guest link was for a different office.'
          : 'You are not a member of this office.',
      );
    }

    return {
      kind: 'human',
      userId: user.userId,
      name: displayNameFor(user),
      isGuest: user.isGuest,
      description: user.description,
      pubkey: user.pubkey,
      avatar: user.avatar,
    };
  }

  override async onJoin(client: Client, _options: OfficeRoomOptions, auth: JoinAuth): Promise<void> {
    if (auth.kind === 'agent') {
      // Read before `agent:ready`, so the runtime's first session already has
      // them: arriving a moment later they would cost a reload.
      const mcp = await this.#readMcpServers([auth.identity.id]);
      this.#joinAsAgent(client, auth.identity, auth.credential, mcp.get(auth.identity.id));
      return;
    }

    const spawn = spawnFor(this.#map, 'human');
    this.state.players.set(
      client.sessionId,
      createPlayer({
        userId: auth.userId,
        name: auth.name,
        x: tileCentre(spawn.x, this.#map.tileSize),
        y: tileCentre(spawn.y, this.#map.tileSize),
        kind: 'human',
        isGuest: auth.isGuest,
        description: auth.description,
        pubkey: auth.pubkey,
        avatar: auth.avatar,
      }),
    );
    this.#sims.set(client.sessionId, { intent: { x: 0, y: 0 }, path: [], away: false });

    // Where they had got to, so their first channel list is the truth rather
    // than this browser's guess. Not awaited — `onJoin` is what puts them in
    // the room, and a slow read of their cursors must not hold that up. The
    // list is sent again when it lands.
    void this.#loadReadCursors(auth.userId, client.sessionId);

    logger.info(`[office] ${auth.name} (${client.sessionId}) joined ${this.roomId}`);
    this.#broadcastRosterToAgents();
  }

  /**
   * Read where somebody is in each of their conversations, once per arrival.
   *
   * A second session for the same person reuses what is already loaded: it is
   * the same set of cursors, and re-reading it would only invite the two
   * sessions to disagree for as long as the query takes.
   */
  async #loadReadCursors(memberId: string, sessionId: string): Promise<void> {
    if (this.#readCursors.has(memberId)) {
      this.#sendChannels(sessionId);
      return;
    }
    try {
      const cursors = await readCursorsForMember(getDb(), this.#workspaceId, memberId);
      // Their last session may have gone while this was in flight; then
      // nobody is waiting for it and holding it would be a small leak.
      if (!this.#hasSessionFor(memberId)) return;
      const known = this.#readCursors.get(memberId);
      if (known) {
        // A `read` landed first. It is newer than anything on disk.
        for (const [id, at] of cursors) if ((known.get(id) ?? 0) < at) known.set(id, at);
      } else {
        this.#readCursors.set(memberId, cursors);
      }
    } catch (error: unknown) {
      logger.error('[office] could not read where somebody had got to', error);
      return;
    }
    this.#sendChannels(sessionId);
  }

  /** Is anybody still connected as this member? */
  #hasSessionFor(memberId: string): boolean {
    for (const player of this.state.players.values()) {
      if (player.userId === memberId) return true;
    }
    return false;
  }

  #joinAsAgent(
    client: Client,
    identity: AgentIdentity,
    credential: AgentCredentialKind,
    mcp: { servers: AgentMcpServer[]; fingerprint: string } | undefined,
  ): void {
    // Agents wake up in the Agent Bay, not the human lobby. Where a worker
    // stands says what it is as loudly as any badge.
    const spawn = this.#agentSpawn();

    this.state.players.set(
      client.sessionId,
      createPlayer({
        userId: identity.id,
        name: identity.name,
        x: tileCentre(spawn.x, this.#map.tileSize),
        y: tileCentre(spawn.y, this.#map.tileSize),
        kind: 'agent',
        spriteKey: identity.spriteKey,
        status: identity.status,
        description: identity.description,
        ownerName: identity.ownerName,
        ownerUserId: identity.ownerUserId,
        scopes: identity.scopes,
        runtimeId: identity.runtimeId,
        modelId: identity.modelId,
      }),
    );

    const session: AgentSession = { identity, lastChatAt: 0, lastMoveAt: 0, lastEmoteAt: 0 };
    this.#sims.set(client.sessionId, {
      intent: { x: 0, y: 0 },
      path: [],
      away: false,
      agent: session,
    });
    this.#agents.set(client.sessionId, identity);
    this.#credentials.set(client.sessionId, credential);
    this.#idle.set(client.sessionId, newIdleRecord(Date.now()));
    this.#seats.arrived(identity.id);

    audit(identity.id, 'session.connected', {
      sessionId: client.sessionId,
      roomId: this.roomId,
      tile: spawn,
      // Which door it came through. 'v2' is a key the office never minted.
      credential,
    });
    markSeen(identity.id);

    const zone = zoneAt(this.#map, spawn.x, spawn.y);
    const ready: AgentReadyPayload = {
      activityVersion: 1,
      approvalVersion: 1,
      taskVersion: 1,
      mcpVersion: 1,
      boardVersion: 1,
      commandsVersion: 1,
      mcpServers: mcp?.servers ?? [],
      agentId: identity.id,
      sessionId: client.sessionId,
      name: identity.name,
      description: identity.description,
      instructions: identity.instructions,
      ownerUserId: identity.ownerUserId,
      ownerName: identity.ownerName,
      scopes: identity.scopes,
      mapId: this.state.mapId,
      tile: spawn,
      zoneId: zone?.id ?? null,
      zones: this.#map.zones.map((z) => ({ id: z.id, label: z.label, kind: z.kind })),
      channels: this.#channelsFor(identity.id),
      teams: this.#teamsFor(identity.id),
      serverTime: Date.now(),
      limits: {
        chatIntervalMs: AGENT_CHAT_INTERVAL_MS,
        moveIntervalMs: AGENT_MOVE_INTERVAL_MS,
        statusMaxLength: AGENT_STATUS_MAX_LENGTH,
        messagesGetMax: MESSAGES_GET_MAX,
        memoryMaxBytes: AGENT_MEMORY_MAX_BYTES,
        coreMemoryMaxBytes: AGENT_CORE_MEMORY_MAX_BYTES,
        chatRadiusTiles: this.#settings.chatRadiusTiles,
        walkUpRadiusTiles: this.#settings.walkUpRadiusTiles,
        boardWritesPerWindow: AGENT_BOARD_WRITES_PER_WINDOW,
        boardWriteWindowMs: AGENT_BOARD_WRITE_WINDOW_MS,
        // Its own number, or the office's. Resolved here so a harness holding
        // only its key learns it the same way a fleet-launched one does.
        parallelism: identity.maxSessions ?? this.#settings.agentParallelism,
      },
    };
    client.send(AgentServerMessage.Ready, ready);
    if (mcp) this.#mcpSent.set(client.sessionId, mcp.fingerprint);
    this.#sendRoster(client.sessionId);

    logger.info(
      `[office] agent ${identity.name} (${identity.id}) joined ${this.roomId} for ${identity.ownerName}`,
    );
    this.#broadcastRosterToAgents();
  }

  override async onLeave(client: Client, consented?: boolean): Promise<void> {
    const sim = this.#sims.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    const agent = this.#agents.get(client.sessionId);

    // A task is only shown while there is a harness behind it, so an avatar
    // held `away` for a reconnect is on nothing in the meantime. A harness
    // that comes back on a new socket says it again; one that resumes this
    // seat gets back what it had, since nothing it said was lost.
    const heldTask = agent && player ? agentTaskOf(player) : null;
    if (agent) {
      if (player) applyAgentTask(player, null);
      this.#activityPending.delete(client.sessionId);
      for (const entry of this.#activity.values()) {
        if (entry.owner === client.sessionId && !activityTerminal(entry.value.state)) {
          this.#closeActivity(entry, 'disconnected');
        }
      }
      // The runtime holding these tools is on the other end of this socket.
      // Nothing an owner clicked now could reach it, so the cards come down.
      for (const [requestId, entry] of this.#approvals) {
        if (entry.owner === client.sessionId && entry.resolvedAt === undefined) {
          this.#closeApproval(requestId, 'interrupted');
        }
      }
      audit(agent.id, 'session.disconnected', { sessionId: client.sessionId, consented });
    }

    if (consented === true || !player || !sim) {
      this.#removePlayer(client.sessionId);
      this.#broadcastRosterToAgents();
      return;
    }

    sim.intent = { x: 0, y: 0 };
    sim.path = [];
    sim.away = true;
    player.moving = false;
    player.status = 'away';
    this.#broadcastRosterToAgents();

    try {
      await this.allowReconnection(client, RECONNECTION_SECONDS);
      sim.away = false;
      // The browser rebuilds its game on resume and counts moves from zero.
      sim.pendingSeq = undefined;
      player.inputSeq = 0;
      player.status = agent ? agent.status : '';
      if (heldTask) applyAgentTask(player, heldTask);
      if (agent) {
        audit(agent.id, 'session.connected', {
          reconnected: true,
          credential: this.#credentials.get(client.sessionId),
        });
      }
      logger.info(`[office] ${client.sessionId} reconnected to ${this.roomId}`);
    } catch {
      this.#removePlayer(client.sessionId);
      logger.info(`[office] ${client.sessionId} did not come back`);
    }
    this.#broadcastRosterToAgents();
  }

  override onDispose(): void {
    this.#activityPending.clear();
    voiceRelay.unregisterRoom(this.roomId);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#revocationTimer) clearInterval(this.#revocationTimer);
    if (this.#settingsTimer) clearInterval(this.#settingsTimer);
    if (this.#pullTimer) clearInterval(this.#pullTimer);
    if (this.#routineTimer) clearInterval(this.#routineTimer);
    logger.info(`[office] room ${this.roomId} disposed`);
  }

  // --- public API ----------------------------------------------------------

  /**
   * Route anyone to a tile. Humans reach this through click-to-move, agents
   * through `move_to` — same pathfinder, same speed, no shortcuts for either.
   */
  walkTo(sessionId: string, tileX: number, tileY: number): boolean {
    const player = this.state.players.get(sessionId);
    const sim = this.#sims.get(sessionId);
    if (!player || !sim || sim.away) return false;

    // The map with this one's own chair open, so its desk is somewhere it can
    // be routed to; everybody else's chairs stay walls to it.
    const map = this.#mapFor(sim);
    const goal = nearestWalkable(map, { x: Math.trunc(tileX), y: Math.trunc(tileY) });
    if (!goal) return false;

    const path = findPath(map, this.#tileOf(player), goal);
    if (path.length === 0) return false;

    sim.intent = { x: 0, y: 0 };
    sim.path = path;
    // Somebody meant this one. Idle life and seating set their flag back
    // after the call when the walk is their own.
    sim.idleWalk = false;
    sim.seatWalk = false;
    return true;
  }

  /** The map a player is routed on: the shared one, or with its own seat open. */
  #mapFor(sim: PlayerSim): OfficeMap {
    const seat = sim.agent ? this.#seatOf(sim.agent.identity.id) : null;
    if (!seat) return this.#map;
    let map = this.#seatMaps.get(seat.id);
    if (!map) {
      map = withSeatOpen(this.#map, seat);
      this.#seatMaps.set(seat.id, map);
    }
    return map;
  }

  #seatOf(agentId: string): MapSeat | null {
    const seatId = this.#seats.seatOf(agentId);
    return seatId === undefined ? null : this.#seatNamed(seatId);
  }

  #seatNamed(seatId: string): MapSeat | null {
    return this.#map.seats.find((seat) => seat.id === seatId) ?? null;
  }

  /** Is anybody still connected as this agent? */
  #hasAgentSession(agentId: string): boolean {
    for (const identity of this.#agents.values()) if (identity.id === agentId) return true;
    return false;
  }

  /** Walk to the middle of a named zone. The agent-facing way to say "go here". */
  /**
   * Walk to whoever this names, stopping beside them.
   *
   * Resolved here because the office is the only thing that knows where people
   * are. Matching is by display name and case-insensitive, the same rule
   * `@mentions` use — an agent told "come to Dpr010" should not have to care
   * about capitalisation any more than a person does.
   *
   * Tiles already claimed by somebody else are excluded, so two agents called
   * at once do not both aim at the same square.
   */
  walkToPerson(sessionId: string, name: string): boolean {
    const wanted = name.trim().toLowerCase();
    if (wanted.length === 0) return false;

    let target: { x: number; y: number } | null = null;
    const taken = new Set<string>();
    for (const [id, player] of this.state.players) {
      const tile = {
        x: Math.floor(player.x / this.#map.tileSize),
        y: Math.floor(player.y / this.#map.tileSize),
      };
      taken.add(`${tile.x},${tile.y}`);
      // Not the caller itself: an agent asked to come to somebody with its own
      // name would otherwise route to where it already stands and look stuck.
      if (id !== sessionId && player.name.trim().toLowerCase() === wanted) {
        target = tile;
      }
    }
    if (!target) return false;

    const beside = tileBeside(this.#map, target.x, target.y, taken);
    if (!beside) return false;
    return this.walkTo(sessionId, beside.x, beside.y);
  }

  walkToZone(sessionId: string, zoneId: string): boolean {
    const zone = this.#map.zones.find((candidate) => candidate.id === zoneId);
    if (!zone) return false;

    const centre = {
      x: zone.bounds.x + Math.floor(zone.bounds.width / 2),
      y: zone.bounds.y + Math.floor(zone.bounds.height / 2),
    };
    return this.walkTo(sessionId, centre.x, centre.y);
  }

  // --- simulation ----------------------------------------------------------

  #tick(deltaMs: number): void {
    const deltaSeconds = deltaMs / 1000;

    // Once a second, not once a tick: a balloon's lifetime is seconds.
    const now = Date.now();
    if (now >= this.#nextEmoteSweep) {
      this.#nextEmoteSweep = now + 1_000;
      this.#sweepEmotes(now);
      this.#stepSeating(now);
      this.#stepIdleLife(now);
    }
    // Four times a second, not every tick: a peer table is rebuilt when a
    // pair crosses the line, and nobody crosses it more often than that.
    if (now >= this.#nextEarshotSweep) {
      this.#nextEarshotSweep = now + EARSHOT_SWEEP_MS;
      this.#sweepEarshot();
    }

    for (const [sessionId, sim] of this.#sims) {
      const player = this.state.players.get(sessionId);
      if (!player || sim.away) continue;

      if (sim.intent.x !== 0 || sim.intent.y !== 0) {
        const next = stepMovement(this.#map, player, sim.intent, deltaSeconds);
        this.#apply(player, next.x, next.y, directionFromIntent(sim.intent, player.dir), true);
      } else if (sim.path.length > 0) {
        const { position, consumed, intent } = followPath(
          this.#map,
          player,
          sim.path,
          deltaSeconds,
        );
        if (consumed > 0) sim.path = sim.path.slice(consumed);
        const arrived = sim.path.length === 0;
        this.#apply(
          player,
          position.x,
          position.y,
          directionFromIntent(intent, player.dir),
          !arrived,
        );
        if (arrived && sim.agent) {
          if (sim.idleWalk) {
            // A wander is not an action. An audit log full of "walked two
            // tiles" is one nobody reads, and the agent did not ask to go.
            sim.idleWalk = false;
          } else if (sim.seatWalk) {
            // Reached the desk, or as near as the route allowed: sit if it
            // is the chair, else stand there — the next change tries again.
            sim.seatWalk = false;
            this.#settle(sessionId, sim, player);
          } else {
            const tile = this.#tileOf(player);
            audit(sim.agent.identity.id, 'effect.moved', {
              tile,
              zoneId: zoneAt(this.#map, tile.x, tile.y)?.id ?? null,
            });
            this.#sendRoster(sessionId);
          }
        }
      } else if (player.moving) {
        player.moving = false;
      }

      if (sim.pendingSeq !== undefined) {
        if (player.inputSeq !== sim.pendingSeq) player.inputSeq = sim.pendingSeq;
        sim.pendingSeq = undefined;
      }
    }
  }

  #apply(player: OfficePlayer, x: number, y: number, dir: Direction, moving: boolean): void {
    if (player.x !== x) player.x = x;
    if (player.y !== y) player.y = y;
    if (player.dir !== dir) player.dir = dir;
    if (player.moving !== moving) player.moving = moving;
  }

  // --- human messages ------------------------------------------------------

  #onInput(client: Client, payload: InputPayload): void {
    const sim = this.#sims.get(client.sessionId);
    if (!sim || sim.away || sim.agent) return; // agents don't hold arrow keys

    const intent = normalize({ x: clampAxis(payload?.x), y: clampAxis(payload?.y) });
    sim.intent = intent;
    if (intent.x !== 0 || intent.y !== 0) sim.path = [];
    this.#ackMove(client.sessionId, payload?.seq);
  }

  #onWalkTo(client: Client, payload: WalkToPayload): void {
    const sim = this.#sims.get(client.sessionId);
    if (sim?.agent) return; // agents use agent:move_to, which is rate limited
    // Read, whether or not it leads anywhere: the browser is waiting to hear
    // that this command is behind it, not that it worked.
    this.#ackMove(client.sessionId, payload?.seq);

    const x = Number(payload?.x);
    const y = Number(payload?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.#sendError(client, 'invalid_move', 'Target must be a tile coordinate.');
      return;
    }
    this.walkTo(client.sessionId, x, y);
  }

  /**
   * Note a movement command's count. `#tick` publishes it as `inputSeq` after
   * acting on it, so prediction knows which position answers which command.
   */
  #ackMove(sessionId: string, seq: unknown): void {
    const sim = this.#sims.get(sessionId);
    if (!sim || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return;
    sim.pendingSeq = seq;
  }

  #onStatus(client: Client, status: unknown): void {
    const sim = this.#sims.get(client.sessionId);
    if (sim?.agent) return; // agents use agent:set_status
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const next = String(status ?? '').slice(0, STATUS_MAX_LENGTH).trim();
    if (player.status !== next) player.status = next;
  }

  #onChat(client: Client, rawText: unknown, requestId?: string): void {
    const speaker = this.state.players.get(client.sessionId);
    if (!speaker) return;

    const text = this.#acceptHumanText(client, rawText);
    if (text === null) return;

    this.#deliverChat(client.sessionId, speaker, text, requestId);
  }

  #onChannelChat(client: Client, payload: ChannelChatSendPayload): void {
    const speaker = this.state.players.get(client.sessionId);
    if (!speaker) return;
    if (this.#sims.get(client.sessionId)?.agent) return; // agents post via agent:say

    const channel = this.#channelFor(speaker.userId, payload?.channelId);
    if (!channel) {
      this.#sendError(client, 'unauthorised', 'Not a channel you are in.');
      return;
    }

    const text = this.#acceptHumanText(client, payload?.text, CHANNEL_POST_MAX_LENGTH);
    if (text === null) return;

    this.#deliverChannelChat(client.sessionId, speaker, channel, text, latencyRequestId(payload?.requestId));
  }

  /**
   * Open a direct message with somebody, from the roster.
   *
   * The rule is `mayOpenDm`, and the facts it needs come from the database
   * rather than the room: the other party need not be in the room — you can
   * message an agent that is asleep, and it reads the line when it wakes.
   * The membership cache is refreshed at once rather than on the next poll,
   * so the tab appears when you click and not ten seconds later.
   */
  async #onDmOpen(client: Client, payload: DmOpenPayload): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.#agents.has(client.sessionId)) return;

    const db = getDb();
    try {
      let memberId = String(payload?.memberId ?? '');
      // `/msg Marvin`: a name, resolved against everyone in the office —
      // present or not — and refused if it fits more than one of them, since
      // a display name is not an identity and a DM is not the place to guess.
      if (memberId.length === 0 && typeof payload?.name === 'string') {
        const wanted = payload.name.replace(/^@/, '').trim().toLowerCase();
        if (wanted.length === 0) return;
        const [people, agentsHere] = await Promise.all([
          listPeopleForWorkspace(db, this.#workspaceId),
          listAgentsForWorkspace(db, this.#workspaceId),
        ]);
        const matches = [
          ...people.filter((person) => person.name.toLowerCase() === wanted).map((p) => p.id),
          ...agentsHere
            .filter((agent) => agent.revokedAt === null && agent.name.toLowerCase() === wanted)
            .map((a) => a.id),
        ];
        if (matches.length !== 1) {
          this.#sendError(
            client,
            'invalid_message',
            matches.length === 0 ? `Nobody here called ${payload.name}.` : `More than one ${payload.name}.`,
          );
          return;
        }
        memberId = matches[0] ?? '';
      }
      if (memberId.length === 0) return;

      const actor = await this.#actorFor(player);

      let subject: ChannelSubject | null = null;
      const agent = await findAgentById(db, memberId);
      if (agent) {
        if (agent.workspaceId === this.#workspaceId && agent.revokedAt === null) {
          subject = {
            id: agent.id,
            kind: 'agent',
            ownerUserId: agent.ownerUserId,
            scopes: agent.scopes,
          };
        }
      } else if (await findMembership(db, { userId: memberId, workspaceId: this.#workspaceId })) {
        subject = { id: memberId, kind: 'human' };
      }

      if (!subject || !mayOpenDm(actor, subject)) {
        this.#sendError(client, 'unauthorised', 'You cannot message them.');
        return;
      }

      const { id } = await openDm(db, {
        workspaceId: this.#workspaceId,
        openerId: player.userId,
        other: { id: subject.id, kind: subject.kind },
      });
      await this.#refreshChannels();
      const channel = this.#channels.get(id);
      if (!channel) return;
      client.send(ServerMessage.DmOpened, {
        channel: this.#refFor(channel, player.userId),
      } satisfies DmOpenedPayload);
    } catch (error: unknown) {
      logger.error('[office] could not open a direct message', error);
    }
  }

  /**
   * Length and rate checks shared by everything a person can type. Null =
   * refused. Speech has the short cap; a channel post may run to a review.
   */
  #acceptHumanText(
    client: Client,
    rawText: unknown,
    maxLength: number = CHAT_MAX_LENGTH,
  ): string | null {
    const text = String(rawText ?? '').trim();
    if (text.length === 0) return null;

    if (text.length > maxLength) {
      this.#sendError(
        client,
        'invalid_message',
        `Messages are limited to ${maxLength} characters.`,
      );
      return null;
    }

    if (!this.#chatLimiter.tryConsume(client.sessionId)) {
      const retryAfter = this.#chatLimiter.retryAfterSeconds(client.sessionId);
      this.#sendError(client, 'rate_limited', `Slow down — try again in ${retryAfter}s.`);
      return null;
    }

    return text;
  }

  /**
   * Send a line of speech into the room. Proximity for everyone, plus mentions
   * for agents — an agent has to be reachable by name from across the office,
   * or asking it to do something means walking over to it first.
   */
  #deliverChat(sessionId: string, speaker: OfficePlayer, text: string, requestId?: string): void {
    const sentAt = Date.now();
    const tile = this.#tileOf(speaker);
    const radius = this.#settings.chatRadiusTiles;
    const zoneId = zoneAt(this.#map, tile.x, tile.y)?.id ?? FLOOR_ZONE_ID;
    /** Stable ids of everyone this line addressed by name. */
    const mentioned: string[] = [];

    const humanPayload: ChatBroadcastPayload = {
      from: sessionId,
      fromName: speaker.name,
      fromKind: speaker.kind,
      text,
      sentAt,
    };

    // Names resolve against the people in the room, and a team's name against
    // its members here. The line's hop says whether naming anybody may still
    // start a turn: a person's line always may; an agent's, only while the
    // chain it is part of is short.
    const audience: Addressable[] = [...this.state.players.values()].map((player) => ({
      id: player.userId,
      name: player.name,
      kind: player.kind,
    }));
    const teams = this.#teamRosters();
    const named = addressedNames(text, [
      ...audience.map((member) => member.name),
      ...teams.map((team) => team.name),
    ]);
    // `!review <link>` with nobody named goes to the command's default, as
    // if it had been said.
    const commandLine = readCommandLine(text, speaker.kind, this.#commands, named);
    const resolved = resolveMentions(commandLine?.named ?? named, audience, teams, speaker.userId);
    let commandHeard = false;
    const hop = hopOf(speaker.kind, this.#wakeHops.lastWake(sessionId, SPATIAL));
    const wakes = mayWake(hop, this.#settings.mentionMaxHops);
    const owed = this.#collectReplyDebt(sessionId, sentAt);

    for (const [listenerId, listener] of this.state.players) {
      const distance = this.#tileDistance(speaker, listener);
      const withinEarshot = distance <= radius;
      const reach = resolved.reached.get(listener.userId);
      const byName = reach !== undefined;
      // Somebody who addressed this speaker from across the room is owed the
      // answer, wherever they are standing now.
      const owedThis = owed.has(listenerId);

      if (!withinEarshot && !byName && !owedThis) continue;

      const target = this.clients.getById(listenerId);
      if (!target) continue;

      const agent = this.#agents.get(listenerId);
      if (agent) {
        // Something reached it: whatever it was doing with nothing to do
        // ends. A person, or its name — another agent talking nearby is
        // context, the way the harness also treats it, and a banter line
        // must not wake every idler in earshot.
        const woken = byName && wakes;
        if (speaker.kind === 'human' || woken) this.#noteActivity(listenerId, true);
        if (woken) this.#wakeHops.woken(listenerId, SPATIAL, hop);
        const via = woken && reach?.viaTeam ? { viaTeam: reach.viaTeam } : {};
        const call = commandLine ? commandCallFor(commandLine, reach) : undefined;
        if (
          call &&
          commandTaken(call, {
            woken,
            withinEarshot,
            distance: round(distance),
            walkUpRadius: this.#settings.walkUpRadiusTiles,
          })
        ) {
          commandHeard = true;
        }
        const command = call ? { command: call } : {};
        if (withinEarshot) {
          target.send(AgentServerMessage.NearbyChat, {
            from: sessionId,
            fromUserId: speaker.userId,
            fromName: speaker.name,
            fromKind: speaker.kind,
            text,
            distance: round(distance),
            sentAt,
            ...(requestId ? { requestId } : {}),
            ...via,
            ...command,
          } satisfies AgentChatEvent);
        } else if (woken) {
          target.send(AgentServerMessage.Mention, {
            from: sessionId,
            fromUserId: speaker.userId,
            fromName: speaker.name,
            fromKind: speaker.kind,
            text,
            sentAt,
            ...(requestId ? { requestId } : {}),
            ...via,
            ...command,
          } satisfies AgentMentionEvent);
        }
      } else {
        target.send(ServerMessage.Chat, humanPayload);
      }

      // Addressing somebody out of earshot opens a short window for their
      // reply to come back to you.
      if (byName && wakes && !withinEarshot) this.#oweReply(listenerId, sessionId, sentAt);
      if (byName) mentioned.push(listener.userId);
    }

    if (!wakes && mentioned.length > 0) {
      const agent = this.#agents.get(sessionId);
      if (agent) audit(agent.id, 'effect.mention_suppressed', { hop, where: zoneId, mentioned });
    }
    this.#sendNotice(
      sessionId,
      'team_members_absent',
      absentNotice(resolved.absent, 'the office right now'),
    );
    if (commandLine && !commandHeard) {
      this.#sendNotice(sessionId, 'command_unheard', unheardNotice(commandLine));
    }

    // Anyone reading this zone from elsewhere. Sent even to somebody who also
    // heard it in earshot: the two arrive on different messages and land in
    // different transcripts, and the client is the one that knows which it
    // has open. Deduplicating here would mean guessing that.
    for (const [followerId, followedZone] of this.#followed) {
      if (followedZone !== zoneId) continue;
      const follower = this.clients.getById(followerId);
      if (!follower) continue;
      follower.send(ServerMessage.ZoneChat, { zoneId, ...humanPayload } satisfies ZoneChatPayload);
    }

    // After delivery, not before: the people in the room should never wait on
    // a disk. A write that fails is logged and the words were still heard.
    void this.#keep(zoneId, {
      fromId: speaker.userId,
      fromKind: speaker.kind,
      fromName: speaker.name,
      text,
      sentAt,
      x: speaker.x,
      y: speaker.y,
      mentions: mentioned,
    });
  }

  // --- channels ------------------------------------------------------------

  async #refreshChannels(): Promise<void> {
    try {
      const db = getDb();
      const [channels, latest, teams, commands] = await Promise.all([
        channelMembershipForWorkspace(db, this.#workspaceId),
        latestMessageAtByConversation(db, this.#workspaceId),
        listTeamsForWorkspace(db, this.#workspaceId),
        listOfficeCommandsForWorkspace(db, this.#workspaceId),
      ]);
      this.#channels = channels;
      this.#teams = teams;
      this.#commands = commands;
      // A line delivered here is known before the database has it; the
      // later of the two is the truth.
      for (const [id, at] of latest) {
        if ((this.#lastMessageAt.get(id) ?? 0) < at) this.#lastMessageAt.set(id, at);
      }
    } catch (error: unknown) {
      logger.error('[office] could not read channels', error);
      return;
    }
    // Anyone whose list changed hears about it; anyone whose list did not, does not.
    for (const sessionId of this.state.players.keys()) this.#sendChannels(sessionId);
  }

  async #readMcpServers(agentIds: string[]): Promise<Map<string, { servers: AgentMcpServer[]; fingerprint: string }>> {
    try {
      return await mcpServersForAgents(getDb(), agentIds);
    } catch (error: unknown) {
      logger.error('[office] could not read MCP servers', error);
      return new Map();
    }
  }

  /**
   * Tell each connected agent when its owner changed its MCP servers.
   *
   * On the settings timer, like channels: the settings page writes the
   * database and nothing else, and there is no other way from there to here.
   * Ten seconds is the delay between saving Slack on the settings page and
   * the agent's runtime reloading with it.
   */
  async #refreshMcpServers(): Promise<void> {
    const sessions = [...this.#agents.entries()];
    if (sessions.length === 0) return;
    const found = await this.#readMcpServers([...new Set(sessions.map(([, identity]) => identity.id))]);
    for (const [sessionId, identity] of sessions) {
      const mcp = found.get(identity.id);
      if (!mcp || this.#mcpSent.get(sessionId) === mcp.fingerprint) continue;
      const client = this.clients.getById(sessionId);
      if (!client) continue;
      this.#mcpSent.set(sessionId, mcp.fingerprint);
      client.send(AgentServerMessage.McpServers, { servers: mcp.servers } satisfies AgentMcpServersEvent);
    }
  }

  /**
   * The harness saying how its owner's MCP servers stand on its machine.
   * Stored for the owner's settings page — the sign-in URL in it is for the
   * owner and nobody else, so it is never broadcast to the room.
   */
  #onAgentMcpStatus(client: Client, payload: unknown): void {
    const session = this.#agentSession(client);
    if (!session) return;
    markSeen(session.identity.id);
    const status = parseMcpStatus(payload);
    if (!status) {
      this.#denyAgent(client, session, 'invalid_payload', 'agent:mcp_status wants { servers: [...] }.');
      return;
    }
    const agentId = session.identity.id;
    void setAgentMcpStatus(getDb(), agentId, status).catch((error: unknown) => {
      logger.error(`[agent] MCP status write failed for ${agentId}`, error);
    });
  }

  /** The channels and DMs one person or agent is in, as they should see them. */
  #channelsFor(memberId: string): ChannelRef[] {
    const mine: ChannelRef[] = [];
    for (const channel of this.#channels.values()) {
      if (channel.members.has(memberId)) mine.push(this.#refFor(channel, memberId));
    }
    return mine;
  }

  /**
   * A conversation as one member sees it. A channel looks the same to
   * everybody; a DM is named after the *other* party, so the same row is
   * "Marvin" to Josh and "Josh" to Marvin.
   */
  #refFor(
    channel: ChannelRef & { members: ReadonlyMap<string, ChannelMember> },
    viewerId: string,
  ): ChannelRef {
    const lastMessageAt = this.#lastMessageAt.get(channel.id);
    const lastReadAt = this.#readCursors.get(viewerId)?.get(channel.id);
    const heard = {
      ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
      // Per viewer: the same channel is caught up for one member and has
      // three unread lines for the next.
      ...(lastReadAt === undefined ? {} : { lastReadAt }),
    };
    if (channel.kind !== 'dm') {
      return { id: channel.id, kind: channel.kind, name: channel.name, slug: channel.slug, ...heard };
    }
    let other = 'somebody';
    for (const member of channel.members.values()) {
      if (member.id !== viewerId) other = member.name;
    }
    return { id: channel.id, kind: 'dm', name: other, slug: '', ...heard };
  }

  /** A channel this member is in, by id — or null, which covers "no such channel" too. */
  #channelFor(memberId: string, channelId: unknown) {
    if (typeof channelId !== 'string' || channelId.length === 0) return null;
    const channel = this.#channels.get(channelId);
    return channel?.members.has(memberId) ? channel : null;
  }

  /**
   * Tell one client which channels it is in, if that changed since last time.
   *
   * Sent on request and on every refresh, but only when different: a list
   * that arrives every ten seconds unchanged is a list clients learn to
   * ignore, and then miss the one that matters.
   */
  #sendChannels(sessionId: string): void {
    const client = this.clients.getById(sessionId);
    const player = this.state.players.get(sessionId);
    if (!client || !player) return;

    const channels = this.#channelsFor(player.userId);
    // What a person could join: every channel they are not in. Never a DM —
    // there is no such thing as a DM you could join.
    const available: ChannelRef[] = [];
    if (!this.#agents.has(sessionId)) {
      for (const channel of this.#channels.values()) {
        if (channel.kind === 'channel' && !channel.members.has(player.userId)) {
          available.push(this.#refFor(channel, player.userId));
        }
      }
    }
    // An agent is told its own teams, as it is on connect — a change to one
    // is a change to its prompt, and it should not have to reconnect to
    // hear it. A person is told every team, for the picker.
    const isAgent = this.#agents.has(sessionId);
    const teams = this.#teams.map(teamRef);
    const commands = this.#commands.map(officeCommandRef);
    const agentTeams = isAgent ? this.#teamsFor(player.userId) : [];
    const signature = isAgent
      ? `${channelListSignature(channels, [])}|${agentTeamsSignature(agentTeams)}`
      : `${channelListSignature(channels, available, teams)}|${officeCommandsSignature(commands)}`;
    if (!this.#channelsSent.offer(sessionId, signature)) return;

    if (isAgent) {
      client.send(AgentServerMessage.Channels, {
        channels,
        teams: agentTeams,
      } satisfies AgentChannelsEvent);
    } else {
      client.send(ServerMessage.Channels, {
        channels,
        available,
        teams,
        commands,
      } satisfies ChannelsPayload);
    }
  }

  // --- the board -----------------------------------------------------------

  /**
   * Read the board again, and tell every person in the room if it changed.
   *
   * On the settings cadence and after every change made here, like the
   * channels: a note written from somewhere else — a settings page, a CLI,
   * an agent on another socket — shows up within ten seconds, and one
   * written here shows up now.
   */
  async #refreshBoard(): Promise<void> {
    // A read started before a write committed may finish after the read
    // started after it. Only the newest read lands, whichever finishes first.
    const ticket = this.#boardReads.start();
    try {
      const db = getDb();
      const [items, agents, tasks, statuses, github, reviews] = await Promise.all([
        listBoardItemsForWorkspace(db, this.#workspaceId),
        listBoardAgentsForWorkspace(db, this.#workspaceId),
        listAgentTasksForWorkspace(db, this.#workspaceId, {
          endedMax: BOARD_LEDGER_ENDED_MAX,
          endedPerAgentMax: BOARD_LEDGER_ENDED_PER_AGENT_MAX,
        }),
        pullRequestStatusesForWorkspace(db, this.#workspaceId),
        describeOfficeGithub(db, this.#workspaceId),
        listPullReviewRequests(db, this.#workspaceId),
      ]);
      if (!this.#boardReads.isLatest(ticket)) return;
      this.#boardItems = items;
      // To the minute: an agent being heard from is not the board changing.
      this.#boardAgents = boardAgentsOf(agents);
      // Each line carries what GitHub last said about its pull request, if the office has looked.
      this.#boardTasks = tasks.map((task) => ({ ...task, github: statuses.get(task.id) ?? null }));
      this.#pullStatuses = statuses;
      this.#boardGithub = boardGithubOf(github);
      this.#boardReviews = reviews;
    } catch (error: unknown) {
      logger.error('[office] could not read the board', error);
      return;
    }
    this.#sendBoardIfChanged();
  }

  /** Everybody here is sent the board, if it is not the board they were last sent. */
  #sendBoardIfChanged(): void {
    const signature = boardSignatureOf(this.#boardView());
    if (signature === this.#boardSignature) return;
    this.#boardSignature = signature;
    for (const sessionId of this.state.players.keys()) void this.#sendBoard(sessionId);
  }

  /** A person's role here as last read, for sending the board. Null for a guest. */
  async #roleFor(sessionId: string, player: OfficePlayer): Promise<MembershipRole | null> {
    const known = this.#roles.get(sessionId);
    if (known !== undefined) return known;
    const actor = await this.#actorFor(player);
    this.#roles.set(sessionId, actor.role);
    return actor.role;
  }

  #boardView(): BoardView {
    return {
      items: this.#boardItems,
      agents: this.#boardAgents,
      tasks: this.#boardTasks,
      github: this.#boardGithub,
      pulls: this.#repoPulls,
      reviews: this.#boardReviews,
    };
  }

  /** Who did what on the board, written down. Fire-and-forget, like the agents' audit: a write must not wait on it. */
  #boardEvent(input: Omit<RecordBoardEventInput, 'workspaceId'>): void {
    void recordBoardEvent(getDb(), { workspaceId: this.#workspaceId, ...input }).catch((error: unknown) => {
      logger.error(`[office] board event write failed (${input.kind})`, error);
    });
  }

  // --- GitHub ------------------------------------------------------------------

  /** The minute's look at GitHub, while somebody is here. Whatever changed, the board follows. */
  async #pollPulls(): Promise<void> {
    if (!this.#humansPresent()) return;
    try {
      if (this.#boardLoaded) await this.#boardLoaded;
      if (this.#pulls.listDue()) await this.#listRepoPulls();
      const outcome = await this.#pulls.refresh(this.#boardTasks, this.#pullStatuses, { listed: this.#repoPulls.pulls });
      if (!outcome.configured) return;
      await this.#followPulls(outcome.changes);
      if (outcome.looked > 0) await this.#refreshBoard();
    } catch (error: unknown) {
      logger.error('[office] could not check GitHub', error);
    }
  }

  /**
   * List every pull request of the office's repositories, and send the board
   * if the list changed. No token is no list: one taken out in Settings
   * empties the tab on the next listing.
   */
  async #listRepoPulls(): Promise<{ tokenRefused: string | null }> {
    const outcome = await this.#pulls.listRepos(this.#repoPulls);
    this.#repoPulls = outcome.pulls;
    this.#sendBoardIfChanged();
    return { tokenRefused: outcome.tokenRefused };
  }

  /**
   * GitHub's word moves the note: a pull request it says has merged takes
   * the note it was for to "done", as the harness saying so would. The
   * ledger line itself was moved by the look that found it.
   */
  async #followPulls(changes: readonly { task: BoardTaskRef; merged: boolean }[]): Promise<void> {
    const db = getDb();
    for (const change of changes) {
      if (!change.merged || !change.task.item) continue;
      try {
        const item = await getBoardItem(db, this.#workspaceId, change.task.item.id);
        if (!item) continue;
        const status = boardStatusAfterTask(item, { linked: false, merged: true });
        if (status) await updateBoardItem(db, { workspaceId: this.#workspaceId, itemId: item.id, status });
      } catch (error: unknown) {
        logger.error('[office] could not move a note after its pull request merged', error);
      }
    }
  }

  /** The person behind a GitHub message: a member, as for writing on the board. */
  async #pullActor(client: Client): Promise<{ player: OfficePlayer; role: MembershipRole } | null> {
    return this.#boardWriter(client);
  }

  async #onBoardPullRefresh(client: Client, payload: unknown): Promise<void> {
    const actor = await this.#pullActor(client);
    if (!actor) return;
    const asked = (payload ?? {}) as Partial<BoardPullRefreshPayload>;
    const taskId = typeof asked.taskId === 'string' ? asked.taskId : undefined;
    if (!this.#boardGithub.connected) {
      this.#sendError(client, 'not_configured', 'This office has no GitHub token. An owner or admin puts one in Settings → Office → GitHub.');
      return;
    }
    const wait = this.#pulls.refreshWaitMs();
    if (wait > 0) {
      this.#sendError(client, 'rate_limited', `GitHub was asked a moment ago. Again in ${Math.ceil(wait / 1000)}s.`);
      return;
    }
    try {
      if (this.#boardLoaded) await this.#boardLoaded;
      // Asked about everything, the repositories are listed again too — but not
      // more often than the token can bear, whoever keeps clicking.
      const relist = !taskId && this.#pulls.listDue(REPO_PULLS_REFRESH_MIN_MS);
      const listed = relist ? await this.#listRepoPulls() : { tokenRefused: null };
      if (listed.tokenRefused) {
        this.#sendError(client, 'github', listed.tokenRefused);
        return;
      }
      const outcome = await this.#pulls.refresh(this.#boardTasks, this.#pullStatuses, taskId ? { taskId } : { listed: this.#repoPulls.pulls });
      if (!outcome.configured) {
        this.#sendError(client, 'not_configured', 'This office has no GitHub token any more.');
        return;
      }
      await this.#followPulls(outcome.changes);
      await this.#refreshBoard();
      if (outcome.tokenRefused) {
        this.#sendError(client, 'github', outcome.tokenRefused);
        return;
      }
      this.#sendNotice(
        client.sessionId,
        'pull_request',
        taskId
          ? outcome.looked === 0
            ? 'Nothing on the ledger to ask GitHub about.'
            : 'Checked the pull request with GitHub.'
          : [
              relist ? `Listed ${this.#repoPulls.pulls.length} pull request${this.#repoPulls.pulls.length === 1 ? '' : 's'} of the office’s repositories.` : null,
              outcome.looked > 0 ? `Checked ${outcome.looked === 1 ? 'the pull request' : `${outcome.looked} pull requests`} on the ledger.` : null,
              relist ? null : 'The repositories were listed a moment ago; they are listed again in a few minutes.',
            ]
              .filter((part): part is string => part !== null)
              .join(' '),
      );
    } catch (error: unknown) {
      logger.error('[office] could not check GitHub', error);
      this.#sendError(client, 'github', 'GitHub could not be checked just now.');
    }
  }

  async #onBoardPullAction(client: Client, payload: unknown): Promise<void> {
    const actor = await this.#pullActor(client);
    if (!actor) return;
    const asked = (payload ?? {}) as Partial<BoardPullActionPayload>;
    if (typeof asked.taskId !== 'string' || !isPullRequestAction(asked.action)) {
      this.#sendError(client, 'invalid_payload', 'Name the ledger line and what to do to its pull request.');
      return;
    }
    const expectedHeadSha = typeof asked.expectedHeadSha === 'string' && asked.expectedHeadSha ? asked.expectedHeadSha : undefined;
    if (this.#boardLoaded) await this.#boardLoaded;
    const task = this.#boardTasks.find((line) => line.id === asked.taskId);
    if (!task || !task.pr) {
      this.#sendError(client, 'not_found', 'No such pull request on the ledger.');
      return;
    }
    let said: string;
    try {
      ({ said } = await this.#pulls.act(task, asked.action, { userId: actor.player.userId, name: actor.player.name }, expectedHeadSha));
    } catch (error: unknown) {
      if (error instanceof PullActionError) {
        this.#sendError(client, error.code, error.message);
        return;
      }
      logger.error('[office] a pull request action failed', error);
      this.#sendError(client, 'github', 'GitHub could not be reached just now.');
      return;
    }
    // Then look at it again, so the board says what GitHub now says — merged,
    // closed, a new head — and the note follows a merge.
    try {
      const outcome = await this.#pulls.refresh(this.#boardTasks, this.#pullStatuses, { taskId: task.id });
      await this.#followPulls(outcome.changes);
    } catch (error: unknown) {
      logger.error('[office] could not check GitHub after acting', error);
    }
    await this.#refreshBoard();
    this.#sendNotice(client.sessionId, 'pull_request', said);
  }

  /**
   * One of your agents asked to review a pull request. It goes the way a
   * note is handed over: a line from you in your DM with the agent, the
   * review brief attached, so the agent reads it as you asking and answers
   * where you will see it. Its owner only, and only a pull request the
   * office knows — on the ledger, or in a repository on its GitHub list.
   */
  async #onBoardPullReview(client: Client, payload: unknown): Promise<void> {
    const writer = await this.#boardWriter(client);
    if (!writer) return;
    const asked = (payload ?? {}) as Partial<BoardPullReviewPayload>;
    if (typeof asked.agentId !== 'string' || typeof asked.url !== 'string') {
      this.#sendError(client, 'invalid_payload', 'Name the agent and the pull request it is to review.');
      return;
    }
    if (!(await this.#mayHandTo(client, writer, asked.agentId, 'asks them for a review'))) return;
    if (this.#boardLoaded) await this.#boardLoaded;
    const target = reviewTargetOf(asked.url, {
      pulls: this.#repoPulls.pulls,
      tasks: this.#boardTasks,
      github: this.#boardGithub,
      host: config.githubWebHost,
    });
    if (!target) {
      this.#sendError(client, 'not_found', 'That pull request is neither on the ledger nor in a repository on the office’s GitHub list.');
      return;
    }
    try {
      const actor = await this.#actorFor(writer.player);
      const channel = await this.#dmWith(actor, asked.agentId);
      const agent = await findAgentById(getDb(), asked.agentId);
      if (!channel || !agent) {
        this.#sendError(client, 'unauthorised', `${agent?.name ?? 'That agent'} takes no direct messages, so it cannot be asked from here.`);
        return;
      }
      this.#deliverChannelChat(client.sessionId, writer.player, channel, reviewLine(target, agent.name), undefined, reviewBrief(target));
      // Stamped once, so the row shown now is the row the next read finds.
      const now = Date.now();
      // The tab says who was asked at once. A read already in flight may have
      // started before the event below is written: taking a ticket keeps it
      // from landing, and the read after the write carries the row for good.
      this.#boardReads.start();
      const review: BoardPullReviewRef = {
        url: target.url,
        repo: target.repo.toLowerCase(),
        number: target.number,
        agentId: agent.id,
        agentName: agent.name,
        byName: writer.player.name,
        at: now,
      };
      this.#boardReviews = [review, ...this.#boardReviews].slice(0, BOARD_PULL_REVIEWS_MAX);
      this.#sendBoardIfChanged();
      // The DM has gone either way: a failed write is logged, not refused.
      const recorded = await recordBoardEvent(getDb(), {
        workspaceId: this.#workspaceId,
        kind: 'pr.review_requested',
        actor: { kind: 'user', id: writer.player.userId, name: writer.player.name },
        taskId: target.taskId,
        itemId: target.itemId,
        payload: { repo: target.repo, number: target.number, url: target.url, agentId: agent.id, agentName: agent.name },
        now,
      }).then(
        () => true,
        (error: unknown) => {
          logger.error('[office] board event write failed (pr.review_requested)', error);
          return false;
        },
      );
      if (recorded) void this.#refreshBoard();
      this.#sendNotice(client.sessionId, 'pull_request', `Asked ${agent.name} to review ${target.repo}#${target.number}. It answers in your DM.`);
    } catch (error: unknown) {
      logger.error('[office] could not ask for a review', error);
      this.#sendError(client, 'invalid_payload', 'The review could not be asked for just now.');
    }
  }

  /**
   * The board as this person sees it. A guest gets the notes and the agents'
   * names, not the ledger or the office's machines. Agents are not sent it:
   * theirs is the gateway's business.
   */
  async #sendBoard(sessionId: string): Promise<void> {
    const client = this.clients.getById(sessionId);
    const player = this.state.players.get(sessionId);
    if (!client || !player || this.#agents.has(sessionId)) return;
    const role = await this.#roleFor(sessionId, player);
    client.send(ServerMessage.Board, {
      ...boardForRole(this.#boardView(), role),
      githubHost: config.githubWebHost,
      you: { userId: player.userId, role },
    } satisfies BoardMessagePayload);
  }

  async #onBoardGet(client: Client): Promise<void> {
    if (this.#boardLoaded) await this.#boardLoaded;
    await this.#sendBoard(client.sessionId);
    // The first person in need not wait for the minute's poll to see the repositories' pull requests.
    if (this.#boardGithub.connected && this.#repoPulls.fetchedAt === null && this.#pulls.listDue()) {
      void this.#listRepoPulls().catch((error: unknown) => logger.error('[office] could not list pull requests', error));
    }
  }

  /**
   * The person behind a board message, if they may write on it. Refuses for
   * them otherwise.
   *
   * The membership is read now, not taken from the cache, like every other
   * action in the room: someone removed from the office, or demoted, loses
   * the pen at once rather than on their next connection. The cache is
   * corrected from what was read, and the board sent again if their standing
   * changed, so the panel catches up too.
   */
  async #boardWriter(client: Client): Promise<{ player: OfficePlayer; role: MembershipRole } | null> {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.#agents.has(client.sessionId)) return null;
    const { role } = await this.#actorFor(player);
    if (this.#roles.get(client.sessionId) !== role) {
      this.#roles.set(client.sessionId, role);
      void this.#sendBoard(client.sessionId);
    }
    if (!mayWriteBoard({ role })) {
      this.#sendError(client, 'unauthorised', 'Only members of this office write on the board; guests read it.');
      return null;
    }
    return { player, role: role as MembershipRole };
  }

  #boardRefused(client: Client, error: unknown): void {
    if (error instanceof BoardItemError) {
      const code = error.reason === 'not_found' ? 'not_found' : 'invalid_payload';
      this.#sendError(client, code, error.message);
      return;
    }
    logger.error('[office] board write failed', error);
    this.#sendError(client, 'invalid_payload', 'The board could not be written.');
  }

  async #onBoardCreate(client: Client, payload: unknown): Promise<void> {
    const writer = await this.#boardWriter(client);
    if (!writer) return;
    const note = parseBoardCreate(payload);
    if (!note) {
      this.#sendError(client, 'invalid_payload', 'A note needs a title, a known column and a known colour.');
      return;
    }
    if (note.assigneeAgentId && !(await this.#mayHandTo(client, writer, note.assigneeAgentId))) return;
    let created: BoardItemRef;
    try {
      created = await createBoardItem(getDb(), {
        workspaceId: this.#workspaceId,
        ...note,
        createdBy: { userId: writer.player.userId },
      });
    } catch (error: unknown) {
      this.#boardRefused(client, error);
      return;
    }
    this.#boardEvent({
      kind: 'item.created',
      actor: { kind: 'user', id: writer.player.userId, name: writer.player.name },
      itemId: created.id,
      payload: { number: created.number, title: created.title, assignee: created.assignee?.name ?? null },
    });
    await this.#refreshBoard();
    // A note written straight into an agent's hands is handed over like any other.
    if (created.assignee) {
      void this.#announceAssignment(client.sessionId, writer.player, { ...created, assignee: null }, created);
    }
  }

  /**
   * May this writer hand a note to this agent? Handing a note over is the
   * owner's to do: the agent reads the note as a request and acts as its
   * owner. The row, not the cache, says whose it is and whether it is still
   * here at all. Says why not to the client, so the caller only returns.
   */
  async #mayHandTo(
    client: Client,
    writer: { player: OfficePlayer; role: MembershipRole },
    agentId: string,
    what = 'hands them a note',
  ): Promise<boolean> {
    const agent = await findAgentById(getDb(), agentId);
    if (!agent || agent.workspaceId !== this.#workspaceId || agent.revokedAt !== null) {
      this.#sendError(client, 'not_found', 'No such agent in this office.');
      return false;
    }
    if (!mayAssignBoardItem({ userId: writer.player.userId, role: writer.role }, agent)) {
      const owner = agent.ownerName.trim();
      this.#sendError(
        client,
        'unauthorised',
        `Only ${agent.name}'s owner${owner ? `, ${owner},` : ''} ${what}. Ask them to.`,
      );
      return false;
    }
    return true;
  }

  async #onBoardUpdate(client: Client, payload: unknown): Promise<void> {
    const writer = await this.#boardWriter(client);
    if (!writer) return;
    const patch = parseBoardUpdate(payload);
    if (!patch) {
      this.#sendError(client, 'invalid_payload', 'Name the note and what changes about it.');
      return;
    }
    if (typeof patch.assigneeAgentId === 'string' && !(await this.#mayHandTo(client, writer, patch.assigneeAgentId))) {
      return;
    }
    let before: BoardItemRef | null = null;
    let after: BoardItemRef;
    try {
      const db = getDb();
      if (patch.assigneeAgentId !== undefined) before = await getBoardItem(db, this.#workspaceId, patch.itemId);
      after = await updateBoardItem(db, { workspaceId: this.#workspaceId, ...patch });
    } catch (error: unknown) {
      this.#boardRefused(client, error);
      return;
    }
    this.#boardEvent({
      kind: 'item.updated',
      actor: { kind: 'user', id: writer.player.userId, name: writer.player.name },
      itemId: after.id,
      payload: { number: after.number, changed: Object.keys(patch).filter((key) => key !== 'itemId'), ...(patch.status ? { status: patch.status } : {}) },
    });
    await this.#refreshBoard();
    if (before && before.assignee?.id !== after.assignee?.id) {
      void this.#announceAssignment(client.sessionId, writer.player, before, after);
    }
  }

  /**
   * A note changed hands: the person who handed it over is seen to say so,
   * in their DM with the agent, with the brief attached. Whoever had it
   * before is told where it went, in the same way, without the brief. An
   * agent that is not here reads it when it next is, as any mention.
   *
   * Each line goes only where the person could have said it themselves:
   * `#dmWith` answers to `mayOpenDm`, so a note taken off a colleague's
   * agent, or handed to one that lives only in public, is on the board and
   * nowhere else.
   */
  async #announceAssignment(
    sessionId: string,
    assigner: OfficePlayer,
    before: BoardItemRef,
    after: BoardItemRef,
  ): Promise<void> {
    try {
      const actor = await this.#actorFor(assigner);
      if (after.assignee) {
        const channel = await this.#dmWith(actor, after.assignee.id);
        if (channel) {
          this.#deliverChannelChat(
            sessionId,
            assigner,
            channel,
            assignmentLine(after, after.assignee.name),
            undefined,
            assignmentBrief(after),
          );
        }
      }
      if (before.assignee) {
        const channel = await this.#dmWith(actor, before.assignee.id);
        if (channel) {
          this.#deliverChannelChat(
            sessionId,
            assigner,
            channel,
            handoverLine(after, before.assignee.name, after.assignee?.name ?? null),
          );
        }
      }
    } catch (error: unknown) {
      logger.error('[office] could not say who a board note went to', error);
    }
  }

  /**
   * The DM between a person and an agent of this office, opened if need be,
   * with its members — or null when `mayOpenDm` would refuse them the same
   * from the roster: not the agent's owner, or an agent without the `dm`
   * scope. The office never opens a door for somebody that it would not let
   * them open themselves.
   */
  async #dmWith(actor: ChannelActor, agentId: string) {
    const db = getDb();
    const agent = await findAgentById(db, agentId);
    if (!agent || agent.workspaceId !== this.#workspaceId || agent.revokedAt !== null) return null;
    const subject: ChannelSubject = {
      id: agent.id,
      kind: 'agent',
      ownerUserId: agent.ownerUserId,
      scopes: agent.scopes,
    };
    if (!mayOpenDm(actor, subject)) return null;
    const { id } = await openDm(db, {
      workspaceId: this.#workspaceId,
      openerId: actor.userId,
      other: { id: agent.id, kind: 'agent' },
    });
    if (!this.#channels.has(id)) await this.#refreshChannels();
    return this.#channels.get(id) ?? null;
  }

  /**
   * Keep what an agent says it is on, and move its note along.
   *
   * The note is the one the harness named, else the newest handed to this
   * agent that no task has taken yet — an owner's `!task` names none. A
   * note newly taken to a branch goes to "in progress"; one whose pull
   * request merged goes to "done". A note nobody handed over is left as it
   * is, except that a task naming it takes it. A note handed to *another*
   * agent is never this task's, whatever the harness says: the task is kept
   * in the ledger with no note, and that agent's card is left alone. The
   * board is sent again when anything of this shows on it.
   */
  async #ledgerTask(agent: AgentIdentity, task: AgentTask | null): Promise<void> {
    try {
      const db = getDb();
      if (task === null) {
        const ended = await endAgentTasks(db, this.#workspaceId, agent.id);
        if (ended.length > 0) await this.#refreshBoard();
        return;
      }
      const item = noteForTask(
        task.item
          ? await findBoardItemByNumber(db, this.#workspaceId, task.item)
          : await findUnlinkedItemForAgent(db, this.#workspaceId, agent.id),
        agent.id,
      );
      const heard = await noteAgentTask(db, {
        workspaceId: this.#workspaceId,
        agentId: agent.id,
        task,
        boardItemId: item?.id ?? null,
      });
      const linked = item ? heard.record.item?.id === item.id : false;
      if (item) {
        const status = boardStatusAfterTask(item, { linked: heard.linked, merged: heard.merged });
        const claim = heard.linked && item.assignee === null ? { assigneeAgentId: agent.id } : {};
        if (status || claim.assigneeAgentId) {
          await updateBoardItem(db, {
            workspaceId: this.#workspaceId,
            itemId: item.id,
            ...(status ? { status } : {}),
            ...claim,
          });
        }
      }
      if (heard.created || heard.linked || heard.merged || linked) await this.#refreshBoard();
    } catch (error: unknown) {
      logger.error('[office] could not keep the agent task', error);
    }
  }

  async #onBoardDelete(client: Client, payload: BoardDeletePayload): Promise<void> {
    const writer = await this.#boardWriter(client);
    if (!writer) return;
    const itemId = typeof payload?.itemId === 'string' ? payload.itemId : '';
    // The row, not the cache: who wrote a note decides who may take it down,
    // and the cache may be a read behind.
    const item = itemId ? await getBoardItem(getDb(), this.#workspaceId, itemId) : null;
    if (!item) {
      this.#sendError(client, 'not_found', 'No such note on this board.');
      return;
    }
    if (!mayDeleteBoardItem({ userId: writer.player.userId, role: writer.role }, item)) {
      this.#sendError(client, 'unauthorised', 'Only whoever wrote a note, or an admin, may take it down.');
      return;
    }
    try {
      await deleteBoardItem(getDb(), this.#workspaceId, item.id);
    } catch (error: unknown) {
      this.#boardRefused(client, error);
      return;
    }
    this.#boardEvent({
      kind: 'item.deleted',
      actor: { kind: 'user', id: writer.player.userId, name: writer.player.name },
      payload: { number: item.number, title: item.title },
    });
    await this.#refreshBoard();
  }

  /** The teams as a mention resolves against them. */
  #teamRosters(): TeamRoster[] {
    return this.#teams.map((team) => ({
      id: team.id,
      name: team.name,
      members: team.members.map((member) => ({ id: member.id, name: member.name })),
    }));
  }

  /** The teams one agent is on, as it is told on connect. */
  #teamsFor(agentId: string): AgentTeam[] {
    return this.#teams
      .filter((team) => team.members.some((member) => member.id === agentId))
      .map((team) => ({
        id: team.id,
        name: team.name,
        description: team.description,
        instructions: team.instructions,
        members: team.members.map((member) => member.name),
      }));
  }

  /** Something a person should know that is not a refusal. Agents are not told: it is not for them. */
  #sendNotice(sessionId: string | null, code: NoticePayload['code'], message: string | null): void {
    if (message === null || sessionId === null || this.#agents.has(sessionId)) return;
    const client = this.clients.getById(sessionId);
    client?.send(ServerMessage.Notice, { code, message } satisfies NoticePayload);
  }

  #onFollowZone(client: Client, payload: FollowZonePayload): void {
    if (this.#agents.has(client.sessionId)) return; // agents read zones with messages_get
    const zoneId = payload?.zoneId;
    if (typeof zoneId !== 'string' || zoneId.length === 0) {
      this.#followed.delete(client.sessionId);
      return;
    }
    const known = zoneId === FLOOR_ZONE_ID || this.#map.zones.some((zone) => zone.id === zoneId);
    if (!known) {
      this.#sendError(client, 'invalid_message', 'No such zone.');
      return;
    }
    this.#followed.set(client.sessionId, zoneId);
  }

  /** A person's standing in the office, for the channel rules. Null for a guest. */
  async #actorFor(player: OfficePlayer): Promise<ChannelActor> {
    return player.isGuest ? { userId: player.userId, role: null } : this.#actorForUser(player.userId);
  }

  /** A person's standing in this office from their membership row, or a guest's when they have none. */
  async #actorForUser(userId: string): Promise<ChannelActor> {
    const membership = await findMembership(getDb(), { userId, workspaceId: this.#workspaceId });
    return {
      userId,
      role: (membership?.role as MembershipRole | undefined) ?? null,
    };
  }

  /** `/join engineering`. Same rule as being added by somebody else: members only. */
  async #onChannelJoin(client: Client, payload: ChannelJoinPayload): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.#agents.has(client.sessionId)) return;
    const slug = String(payload?.slug ?? '')
      .replace(/^#/, '')
      .trim()
      .toLowerCase();
    const channel = [...this.#channels.values()].find(
      (candidate) => candidate.kind === 'channel' && candidate.slug === slug,
    );
    if (!channel) {
      this.#sendError(client, 'invalid_message', `No #${slug} here.`);
      return;
    }
    try {
      const actor = await this.#actorFor(player);
      if (!mayAddToChannel(actor, { id: player.userId, kind: 'human' })) {
        this.#sendError(client, 'unauthorised', 'Guests cannot join channels.');
        return;
      }
      await addChannelMember(getDb(), {
        channelId: channel.id,
        memberId: player.userId,
        memberKind: 'human',
        addedBy: player.userId,
      });
      await this.#refreshChannels();
    } catch (error: unknown) {
      logger.error('[office] could not join a channel', error);
    }
  }

  /** `/leave`. Anyone may leave a channel; a DM is not left, only ignored. */
  async #onChannelLeave(client: Client, payload: ChannelLeavePayload): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.#agents.has(client.sessionId)) return;
    const channel = this.#channelFor(player.userId, payload?.channelId);
    if (!channel || channel.kind !== 'channel') return;
    try {
      await removeChannelMember(getDb(), channel.id, player.userId);
      // The cursor went with the membership row. Forgetting it here too
      // keeps this room from answering for a channel it no longer has one
      // for — rejoining without reconnecting would otherwise look caught up.
      this.#readCursors.get(player.userId)?.delete(channel.id);
      await this.#refreshChannels();
    } catch (error: unknown) {
      logger.error('[office] could not leave a channel', error);
    }
  }

  /**
   * Somebody has looked at a conversation.
   *
   * Kept so their other devices agree: the cursor is a fact about the
   * person, not about the browser that reported it. Agents are ignored —
   * they are told everything as it happens and have nothing to catch up on.
   *
   * The time is the office's, never the client's, unless the client asks for
   * an *earlier* one. A browser with a fast clock that could mark itself
   * caught up on lines nobody has said yet would hide them for good.
   */
  async #onRead(client: Client, payload: ReadPayload): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.#agents.has(client.sessionId)) return;
    const channel = this.#channelFor(player.userId, payload?.channelId);
    if (!channel) return;

    const now = Date.now();
    const asked = typeof payload?.at === 'number' && Number.isFinite(payload.at) ? payload.at : now;
    const at = Math.min(asked, now);
    if (at <= 0) return;

    // Nothing new to say. Checked before the limiter so a client repeating
    // itself is not spending its allowance on a no-op.
    if ((this.#readCursors.get(player.userId)?.get(channel.id) ?? 0) >= at) return;
    // Dropped in silence, not refused: a read is not something a person did
    // on purpose, so there is nothing to tell them about. Their cursor is
    // simply a little behind until the next report.
    if (!this.#readLimiter.tryConsume(client.sessionId, now)) return;

    // The database first, and only then what this room believes. The other
    // order leaves the room ahead of the disk when a write fails: every
    // session would be told the channel was read, and the next reconnect
    // would quietly take it back.
    let moved = false;
    try {
      moved = await markRead(getDb(), {
        workspaceId: this.#workspaceId,
        conversationId: channel.id,
        memberId: player.userId,
        at,
      });
    } catch (error: unknown) {
      logger.error('[office] could not keep where somebody had got to', error);
      return;
    }
    if (!moved) return;

    // Re-checked after the await: another report of theirs may have landed
    // and got further while this one was in the database.
    const cursors = this.#readCursors.get(player.userId) ?? new Map<string, number>();
    if ((cursors.get(channel.id) ?? 0) >= at) return;
    cursors.set(channel.id, at);
    this.#readCursors.set(player.userId, cursors);

    // Their other sessions, and this one: the list each of them is holding
    // now disagrees with the office about what is unread.
    for (const [sessionId, other] of this.state.players.entries()) {
      if (other.userId === player.userId) this.#sendChannels(sessionId);
    }
  }

  /**
   * Post a line in a channel: every member in the room is told, wherever
   * they stand, and the line is kept for the members who are not.
   *
   * Not spatial, deliberately. No bubble, no earshot, no reply-debt — a
   * channel is a place you are in by membership, not by standing somewhere,
   * and mixing the two would make "who heard that" unanswerable.
   *
   * Agents are told whether the line named them. They wake for mentions and
   * for nothing else, but they are told everything, so the window their next
   * turn is given has the conversation the mention was part of.
   */
  #deliverChannelChat(
    /** The speaker's session, or null for a line the office speaks in a member's name while they are not here: a routine firing. */
    sessionId: string | null,
    speaker: Pick<OfficePlayer, 'userId' | 'name' | 'kind'>,
    channel: ChannelRef & { members: ReadonlyMap<string, ChannelMember> },
    text: string,
    requestId?: string,
    /** Attached to the line for every agent it wakes, in place of any `!command` in the text. */
    brief?: AgentCommandCall,
  ): void {
    const sentAt = Date.now();
    this.#lastMessageAt.set(channel.id, sentAt);

    // Mentions resolve against the channel's members, present or not: a
    // member who is not in the room right now can still be told later that
    // they were named, which is what the mention index is for. A team's name
    // reaches its members that are in the channel; the sender is told about
    // the ones that are not. In a DM every line is addressed to the other
    // party by construction — there is nobody else it could be for.
    const audience: Addressable[] = [...channel.members.values()].map((member) => ({
      id: member.id,
      name: member.name,
      kind: member.kind,
    }));
    const teams = this.#teamRosters();
    const named = addressedNames(text, [
      ...audience.map((member) => member.name),
      ...teams.map((team) => team.name),
    ]);
    const commandLine = readCommandLine(text, speaker.kind, this.#commands, named);
    const resolved = resolveMentions(commandLine?.named ?? named, audience, teams, speaker.userId);
    // Before the DM's implicit address is added: see `commandReach`.
    const namedReach = new Map(resolved.reached);
    if (channel.kind === 'dm') {
      for (const member of channel.members.values()) {
        if (member.id !== speaker.userId && !resolved.reached.has(member.id)) {
          resolved.reached.set(member.id, {});
        }
      }
    }
    const mentioned = new Set(resolved.reached.keys());
    let commandHeard = false;
    // Whether naming anybody may start a turn — see `hops.ts`.
    const hop = hopOf(speaker.kind, sessionId === null ? undefined : this.#wakeHops.lastWake(sessionId, channel.id));
    const wakes = mayWake(hop, this.#settings.mentionMaxHops);

    const line = {
      ...(requestId ? { requestId } : {}),
      from: sessionId ?? '',
      fromUserId: speaker.userId,
      fromName: speaker.name,
      fromKind: speaker.kind,
      text,
      sentAt,
    };

    for (const [listenerId, listener] of this.state.players) {
      if (!channel.members.has(listener.userId)) continue;
      const target = this.clients.getById(listenerId);
      if (!target) continue;

      const ref = this.#refFor(channel, listener.userId);
      if (this.#agents.has(listenerId)) {
        // Only a line that names it is for it; the rest is the quiet an
        // agent in a channel keeps, and a busy channel must not keep every
        // member from ever being idle.
        const woken = wakes && mentioned.has(listener.userId);
        if (woken) {
          this.#noteActivity(listenerId, true);
          this.#wakeHops.woken(listenerId, channel.id, hop);
        }
        const reach = resolved.reached.get(listener.userId);
        const via = reach?.viaTeam;
        // Only to a member it woke: in a channel nothing else starts a turn.
        const call = !woken
          ? undefined
          : brief
            ? brief
            : commandLine
              ? commandCallFor(
                  commandLine,
                  commandReach(commandLine, namedReach, resolved.reached).get(listener.userId),
                )
              : undefined;
        if (call) commandHeard = true;
        target.send(AgentServerMessage.ChannelChat, {
          channel: ref,
          ...line,
          mentioned: woken,
          ...(woken && via ? { viaTeam: via } : {}),
          ...(call ? { command: call } : {}),
        } satisfies AgentChannelChatEvent);
      } else {
        target.send(ServerMessage.ChannelChat, {
          channel: ref,
          from: line.from,
          fromName: line.fromName,
          fromKind: line.fromKind,
          text,
          sentAt,
        } satisfies ChannelChatPayload);
      }
    }

    if (!wakes && mentioned.size > 0) {
      const agent = sessionId === null ? undefined : this.#agents.get(sessionId);
      if (agent) {
        audit(agent.id, 'effect.mention_suppressed', {
          hop,
          channel: channel.id,
          mentioned: [...mentioned],
        });
      }
    }
    this.#sendNotice(
      sessionId,
      'team_members_absent',
      absentNotice(
        resolved.absent,
        channel.kind === 'dm' ? 'this conversation' : channelLabel(channel),
      ),
    );
    if (commandLine && !commandHeard) {
      this.#sendNotice(sessionId, 'command_unheard', unheardNotice(commandLine));
    }

    void this.#keepIn(channel.id, {
      fromId: speaker.userId,
      fromKind: speaker.kind,
      fromName: speaker.name,
      text,
      sentAt,
      mentions: [...mentioned],
    });
  }

  // --- history -------------------------------------------------------------

  /**
   * Open this office's transcript for every zone on the map.
   *
   * A room that cannot reach the database still opens — people can talk, they
   * just are not being written down, and the log says so once rather than on
   * every line.
   */
  async #openConversations(mapId: string): Promise<ReadonlyMap<string, string>> {
    try {
      return await ensureZoneConversations(getDb(), this.#workspaceId, mapId, this.#map.zones);
    } catch (error: unknown) {
      logger.error('[office] could not open conversations; chat will not be kept', error);
      return new Map();
    }
  }

  async #keep(
    zoneId: string,
    message: Omit<Parameters<typeof recordMessage>[1], 'conversationId'>,
  ): Promise<void> {
    const conversationId = (await this.#conversations).get(zoneId);
    if (!conversationId) return;
    await this.#keepIn(conversationId, message);
  }

  async #keepIn(
    conversationId: string,
    message: Omit<Parameters<typeof recordMessage>[1], 'conversationId'>,
  ): Promise<void> {
    try {
      await recordMessage(getDb(), { conversationId, ...message });
    } catch (error: unknown) {
      logger.error('[office] could not keep a message', error);
    }
  }

  /** A zone id somebody sent, or the zone they stand in, or the floor. */
  #zoneIdFor(player: OfficePlayer, requested: unknown): string | null {
    if (typeof requested === 'string' && requested.length > 0) {
      if (requested === FLOOR_ZONE_ID) return requested;
      return this.#map.zones.some((zone) => zone.id === requested) ? requested : null;
    }
    const tile = this.#tileOf(player);
    return zoneAt(this.#map, tile.x, tile.y)?.id ?? FLOOR_ZONE_ID;
  }

  /**
   * What was said before somebody arrived.
   *
   * Two reads. With no zone named: what they could have heard from where they
   * stand, across zones — the first version read the transcript of the zone
   * they spawned in, which is the lobby, and the lobby is where nobody talks.
   * The box in the corner is an earshot box, and on arrival it should hold
   * what earshot would have held. With a zone named: that zone's transcript,
   * any zone in the office — a transcript is for the people who were not
   * there. Requested by the client once it is listening, because a message
   * sent from `onJoin` is sent to nobody.
   */
  async #onHistoryGet(client: Client, payload: HistoryGetPayload): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const before = Number(payload?.before);
    const limit = Math.min(Math.max(Number(payload?.n) || CHAT_LOG_LIMIT, 1), CHAT_LOG_LIMIT, 50);
    const paging = Number.isFinite(before) && before > 0 ? { before } : {};
    const workspaceId = this.#workspaceId;

    let zoneId: string | null = null;
    let channelId: string | null = null;
    let page: MessagePage;
    try {
      if (typeof payload?.channelId === 'string' && payload.channelId.length > 0) {
        const channel = this.#channelFor(player.userId, payload.channelId);
        if (!channel) {
          this.#sendError(client, 'unauthorised', 'Not a channel you are in.');
          return;
        }
        channelId = channel.id;
        page = await recentMessages(getDb(), channel.id, { workspaceId, limit, ...paging });
      } else if (typeof payload?.zoneId === 'string' && payload.zoneId.length > 0) {
        zoneId = this.#zoneIdFor(player, payload.zoneId);
        if (zoneId === null) {
          this.#sendError(client, 'invalid_message', 'No such zone.');
          return;
        }
        const conversationId = (await this.#conversations).get(zoneId);
        page = conversationId
          ? await recentMessages(getDb(), conversationId, { workspaceId, limit, ...paging })
          : { messages: [], hasMore: false };
      } else {
        page = await recentMessagesNear(getDb(), {
          workspaceId,
          mapId: this.state.mapId,
          x: player.x,
          y: player.y,
          radius: this.#settings.chatRadiusTiles * this.#map.tileSize,
          limit,
          ...paging,
        });
      }
      const conversationId = channelId ?? (zoneId ? (await this.#conversations).get(zoneId) : undefined);
      const activity = await readActivity(getDb(), workspaceId, {
        ...(conversationId ? { conversationId } : {}), mapId: this.state.mapId,
        x: player.x, y: player.y, radius: this.#settings.chatRadiusTiles * this.#map.tileSize, ...paging,
      });
      // Recheck membership after the asynchronous read.
      if (channelId && !this.#channelFor(player.userId, channelId)) return;
      for (const value of activity) {
        const live = this.#activity.get(`${value.agentId}:${value.turnId}`);
        if (!live && !activityTerminal(value.state)) {
          value.state = 'interrupted';
          for (const item of value.items) if (item.state === 'running' || item.state === 'pending') {
            item.state = 'interrupted'; item.endedAt = value.updatedAt;
          }
        }
      }
      const combined: ChatBroadcastPayload[] = [...page.messages.map((message) => ({
          from: message.fromId,
          fromName: message.fromName,
          fromKind: message.fromKind,
          text: message.text,
          sentAt: message.sentAt,
        })), ...activity.map(value => ({ from: value.agentId, fromName: value.agentName,
          fromKind: 'agent' as const, text: '', sentAt: value.startedAt, activity: value }))]
          .sort((a, b) => a.sentAt - b.sentAt);
      client.send(ServerMessage.History, {
        zoneId, channelId,
        hasMore: page.hasMore || activity.length === 50 || combined.length > limit,
        messages: combined.slice(-limit),
      } satisfies HistoryPayload);
      // A long-running turn can predate the latest history page. Replay active
      // snapshots separately so reconnect never hides it behind newer chat.
      if (!paging.before) for (const entry of this.#activity.values()) {
        if (activityTerminal(entry.value.state)) continue;
        const sameTarget = channelId ? entry.value.channelId === channelId :
          !entry.value.channelId && (zoneId ? entry.value.zoneId === zoneId :
            Math.hypot(player.x - entry.x, player.y - entry.y) <= this.#settings.chatRadiusTiles * this.#map.tileSize);
        if (sameTarget) client.send('activity', { ...entry.value, nearby: !entry.value.channelId &&
          Math.hypot(player.x - entry.x, player.y - entry.y) <= this.#settings.chatRadiusTiles * this.#map.tileSize });
      }
      // Cards are live state, not transcript: a reopened panel or a fresh
      // tab must find the questions still waiting rather than a gap where
      // one was. Resolved ones are left out — a dead button is worse than
      // no button.
      if (!paging.before) for (const entry of this.#approvals.values()) {
        if (entry.resolvedAt !== undefined) continue;
        const audience = this.#approvalAudience(client, entry);
        if (!audience.visible) continue;
        const sameTarget = channelId
          ? entry.value.channelId === channelId
          : !entry.value.channelId && (zoneId ? entry.value.zoneId === zoneId : !audience.private);
        if (sameTarget || audience.private) {
          client.send(ServerMessage.Approval, { ...entry.value,
            ...(audience.private ? { private: true } : {}) } satisfies PublicApprovalRequest);
        }
      }
    } catch (error: unknown) {
      logger.error('[office] could not read history', error);
    }
  }

  #toChatEvent(message: StoredMessage, listener: OfficePlayer): AgentChatEvent {
    const distance =
      message.x === null || message.y === null
        ? 0
        : Math.hypot(message.x - listener.x, message.y - listener.y) / this.#map.tileSize;
    return {
      from: message.fromId,
      fromUserId: message.fromId,
      fromName: message.fromName,
      fromKind: message.fromKind,
      text: message.text,
      distance: round(distance),
      sentAt: message.sentAt,
    };
  }

  /** Record that `speaker` owes `listener` a reply they can actually hear. */
  #oweReply(speakerId: string, listenerId: string, at: number): void {
    if (this.#settings.replyWindowSeconds <= 0) return;
    const debts = this.#awaitingReply.get(speakerId) ?? new Map<string, number>();
    debts.set(listenerId, at);
    this.#awaitingReply.set(speakerId, debts);
  }

  /** Who is still owed a reply from this speaker, clearing what has expired. */
  #collectReplyDebt(speakerId: string, now: number): Set<string> {
    const debts = this.#awaitingReply.get(speakerId);
    if (!debts) return new Set();

    const windowMs = this.#settings.replyWindowSeconds * 1000;
    const live = new Set<string>();
    for (const [listenerId, at] of debts) {
      if (now - at <= windowMs) live.add(listenerId);
      else debts.delete(listenerId);
    }

    // One reply settles the debt; a conversation that continues re-opens it
    // through the normal addressing path.
    this.#awaitingReply.delete(speakerId);
    return live;
  }

  async #refreshSettings(): Promise<void> {
    try {
      const before = this.#settings.chatRadiusTiles;
      this.#settings = await getOfficeSettings(getDb(), this.#workspaceId);
      if (this.#settings.chatRadiusTiles !== before) {
        for (const client of this.clients) this.#sendEarshot(client);
      }
    } catch (error: unknown) {
      logger.error('[office] could not read settings', error);
    }
  }

  /** How far a voice carries here. Humans only: an agent has nothing to do with it. */
  #sendEarshot(client: Client): void {
    if (this.#agents.has(client.sessionId)) return;
    client.send(ServerMessage.Earshot, {
      radiusTiles: this.#settings.chatRadiusTiles,
    } satisfies EarshotPayload);
  }

  // --- agent messages ------------------------------------------------------

  #agentSession(client: Client): AgentSession | null {
    const sim = this.#sims.get(client.sessionId);
    // Every command an agent sends is a sign of life, and this is the one
    // place they all pass through. A status line, a look around, a move: the
    // agent is doing something, so it is not idling.
    if (sim?.agent) this.#noteActivity(client.sessionId);
    return sim?.agent ?? null;
  }

  async #drainActivity(client: Client): Promise<void> {
    if (this.#activityBusy.has(client.sessionId)) return;
    this.#activityBusy.add(client.sessionId);
    try {
      while (this.#activityPending.has(client.sessionId)) {
        // Bound fan-out and writes independently of the chat rate limiter.
        await new Promise(resolve => setTimeout(resolve, 100));
        const pending = this.#activityPending.get(client.sessionId);
        this.#activityPending.delete(client.sessionId);
        for (const payload of pending?.values() ?? []) await this.#onActivity(client, payload);
      }
    } catch (error) { logger.error('[office] activity could not be kept', error); }
    finally { this.#activityBusy.delete(client.sessionId); }
  }

  async #onActivity(client: Client, payload: unknown): Promise<void> {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    const value = parseActivity(payload);
    if (!session || !player || this.#sims.get(client.sessionId)?.away || !value || !hasScope(session.identity, 'chat') || !hasScope(session.identity, 'status')) return;
    const channel = value.channelId ? this.#channelFor(player.userId, value.channelId) : null;
    if (value.channelId && (!channel || (channel.kind === 'dm' && !hasScope(session.identity, 'dm')))) return;
    const zoneId = value.channelId ? null : this.#zoneIdFor(player, value.zoneId);
    if (!value.channelId && zoneId === null) return;
    const conversationId = channel?.id ?? (await this.#conversations).get(zoneId!);
    if (!conversationId) return;
    const key = `${session.identity.id}:${value.turnId}`;
    let previous = this.#activity.get(key);
    if (!previous) {
      const stored = await findActivity(getDb(), this.#workspaceId, session.identity.id, value.turnId);
      if (stored) {
        previous = { value: stored.activity, owner: client.sessionId,
          conversationId: stored.conversationId, x: stored.x ?? player.x, y: stored.y ?? player.y };
      }
    }
    if (previous && (previous.conversationId !== conversationId || previous.value.sequence >= value.sequence ||
        (activityTerminal(previous.value.state) && previous.value.state !== 'disconnected'))) return;
    if (!previous && zoneId && zoneId !== this.#zoneIdFor(player, undefined)) return;
    if (!previous && this.#activity.size >= 500 && ![...this.#activity.values()].some(e => activityTerminal(e.value.state))) return;
    if (!previous && [...this.#activity.values()].filter(e => e.owner === client.sessionId && !activityTerminal(e.value.state)).length >= 32) return;
    if (!this.state.players.has(client.sessionId) || (value.channelId && !this.#channelFor(player.userId, value.channelId))) return;
    const now = Date.now();
    const publicValue: PublicActivity = { ...value, agentId: session.identity.id, agentName: player.name,
      startedAt: previous?.value.startedAt ?? now, receivedAt: now,
      ...(zoneId ? { zoneId } : {}) };
    const entry = { value: publicValue, owner: client.sessionId, conversationId,
      x: previous?.x ?? player.x, y: previous?.y ?? player.y };
    this.#activity.set(key, entry);
    if (this.#activity.size > 500) {
      const oldest = [...this.#activity].find(([, e]) => activityTerminal(e.value.state));
      if (oldest) this.#activity.delete(oldest[0]);
    }
    this.#publishActivity(entry);
    await keepActivity(getDb(), conversationId, this.#workspaceId, publicValue, value.channelId ? null : entry);
  }

  // --- tool approvals (docs/GATEWAY.md) ------------------------------------

  /**
   * An agent is holding a tool until its owner says yes.
   *
   * Same audience rules as activity, because the card sits in the transcript
   * beside the turn it belongs to: channel membership, or earshot, or a zone
   * somebody is reading. What is different is that only one person can answer
   * it, and that person may not be in the room the question was asked in — so
   * they get their own copy either way.
   */
  async #onApprovalRequest(client: Client, payload: unknown): Promise<void> {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    const value = parseApprovalRequest(payload);
    if (
      !session ||
      !player ||
      !value ||
      !hasScope(session.identity, 'chat') ||
      !hasScope(session.identity, 'status')
    )
      return;
    const channel = value.channelId ? this.#channelFor(player.userId, value.channelId) : null;
    if (value.channelId && (!channel || (channel.kind === 'dm' && !hasScope(session.identity, 'dm'))))
      return;
    const zoneId = value.channelId ? null : this.#zoneIdFor(player, value.zoneId);
    if (!value.channelId && zoneId === null) return;
    // An agent may only put a card in the room it is actually standing in.
    // The earshot test below is against where it stands, so a claimed zone
    // elsewhere would show the card to that zone's readers and nobody near.
    if (zoneId && zoneId !== this.#zoneIdFor(player, undefined)) return;
    const conversationId = channel?.id ?? (await this.#conversations).get(zoneId!);
    if (!conversationId) return;
    // Recheck after the asynchronous read: membership can move under it.
    if (value.channelId && !this.#channelFor(player.userId, value.channelId)) return;

    const existing = this.#approvals.get(value.requestId);
    // A replay after a reconnect is the same question, not a new one.
    //
    // Matched on the agent's identity rather than its socket: a reconnect
    // arrives on a new `sessionId`, so a session match would reject exactly
    // the case this exists for. A card closed `interrupted` because that
    // socket dropped comes back and is answerable again; one the harness
    // itself settled, or one whose deadline passed meanwhile, stays closed —
    // a harness must not be able to un-answer a card.
    if (existing) {
      if (existing.value.agentId !== session.identity.id) return;
      if (!resumableApproval(existing)) return;
      existing.owner = client.sessionId;
      if (existing.resolvedAt !== undefined) {
        delete existing.resolvedAt;
        delete existing.resolution;
        audit(session.identity.id, 'approval.requested', {
          requestId: value.requestId,
          tool: existing.value.toolName,
          turnId: existing.value.turnId,
          resumed: true,
        });
      }
      this.#publishApproval(existing);
      return;
    }
    const mine = [...this.#approvals.values()].filter(
      (entry) => entry.owner === client.sessionId && entry.resolvedAt === undefined,
    ).length;
    if (mine >= APPROVAL_MAX_PER_AGENT || this.#approvals.size >= APPROVAL_MAX_PER_ROOM) {
      logger.warn(`[office] ${session.identity.name} has too many approvals open; refusing one`);
      // Say which, rather than dropping it on the floor. A refusal the
      // harness never hears about is a runtime holding a tool for five
      // minutes with no card anywhere to explain the wait.
      client.send(AgentServerMessage.Error, {
        code: 'rate_limited',
        message: 'Too many approvals are already waiting for this agent.',
        requestId: value.requestId,
      } satisfies AgentErrorPayload);
      return;
    }

    const entry: TrackedApproval = {
      value: {
        ...value,
        agentId: session.identity.id,
        agentName: player.name,
        ownerUserId: session.identity.ownerUserId,
        ownerName: session.identity.ownerName,
        receivedAt: Date.now(),
        ...(zoneId ? { zoneId } : {}),
      },
      owner: client.sessionId,
      conversationId,
      x: player.x,
      y: player.y,
    };
    this.#approvals.set(value.requestId, entry);
    audit(session.identity.id, 'approval.requested', {
      requestId: value.requestId,
      tool: value.toolName,
      turnId: value.turnId,
      ...(value.channelId ? { channelId: value.channelId } : { zoneId }),
    });
    this.#publishApproval(entry);
  }

  /** The harness says a question stopped waiting, however it stopped. */
  #onApprovalResolved(client: Client, payload: unknown): void {
    const session = this.#agentSession(client);
    const value = parseApprovalResolved(payload);
    if (!session || !value) return;
    const entry = this.#approvals.get(value.requestId);
    if (!entry) {
      // No card: a `run` scope approval, or one this office never saw. It is
      // still an authorization decision, so it is still on the record.
      audit(session.identity.id, 'approval.resolved', {
        requestId: value.requestId,
        resolution: value.resolution,
        via: value.via,
      });
      return;
    }
    if (entry.owner !== client.sessionId || entry.resolvedAt !== undefined) return;
    this.#settleApproval(entry, value, session.identity.id);
  }

  /** The office's own word: nobody answered, or the agent that asked has gone. */
  #closeApproval(requestId: string, resolution: 'expired' | 'interrupted'): void {
    const entry = this.#approvals.get(requestId);
    if (!entry || entry.resolvedAt !== undefined) return;
    this.#settleApproval(
      entry,
      { version: 1, requestId, turnId: entry.value.turnId, resolution, via: 'system', resolvedAt: Date.now() },
      entry.value.agentId,
    );
  }

  #settleApproval(entry: TrackedApproval, resolved: ApprovalResolved, agentId: string): void {
    entry.resolvedAt = Date.now();
    entry.resolution = resolved.resolution;
    audit(agentId, 'approval.resolved', {
      requestId: resolved.requestId,
      resolution: resolved.resolution,
      via: resolved.via,
      ...(entry.decidedBy ? { decidedBy: entry.decidedBy } : {}),
    });
    const publicValue: PublicApprovalResolved = {
      ...resolved,
      agentId: entry.value.agentId,
      agentName: entry.value.agentName,
      ...(entry.decidedBy ? { decidedByName: entry.decidedBy } : {}),
      receivedAt: entry.resolvedAt,
    };
    for (const client of this.clients) {
      if (this.#approvalAudience(client, entry).visible) {
        client.send(ServerMessage.ApprovalResolved, publicValue);
      }
    }
  }

  /**
   * A human clicked Allow once or Deny.
   *
   * Everything that matters is checked here rather than in the browser: who
   * they are, which request they named, whether it is still waiting, and
   * whether the option was one this request actually offered. Only then is
   * the answer handed to the agent that asked — by id, on its own socket.
   */
  #onApprovalDecide(client: Client, payload: unknown): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || player.kind === 'agent') return;
    const decide: ApprovalDecidePayload | null = parseApprovalDecide(payload);
    if (!decide) {
      this.#sendError(client, 'invalid_payload', 'That is not an answer this office understands.');
      return;
    }
    const entry = this.#approvals.get(decide.requestId);
    const verdict = judgeDecision(entry, decide, player.userId);
    if (!verdict.ok) {
      this.#sendError(client, verdict.code, verdict.message, decide.requestId);
      return;
    }
    const agentClient = this.clients.find((candidate) => candidate.sessionId === entry!.owner);
    if (!agentClient) {
      this.#sendError(client, 'unroutable', `${entry!.value.agentName} is no longer connected.`, decide.requestId);
      this.#closeApproval(decide.requestId, 'interrupted');
      return;
    }
    entry!.decidedBy = player.name;
    audit(entry!.value.agentId, 'approval.decided', {
      requestId: decide.requestId,
      optionId: verdict.optionId,
      tool: entry!.value.toolName,
      decidedByUserId: player.userId,
    });
    agentClient.send(AgentServerMessage.ApprovalDecision, {
      requestId: decide.requestId,
      optionId: verdict.optionId,
      decidedByUserId: player.userId,
      decidedByName: player.name,
    } satisfies AgentApprovalDecisionEvent);
    // Nothing is broadcast here. What the runtime was actually told is the
    // harness's to say, and it says it with a resolution a moment later; a
    // card claiming an outcome before the runtime has heard the answer would
    // be this office guessing. A second click meanwhile is refused above.
  }

  /**
   * Whether this client sees the card, and whether it reaches them privately.
   *
   * The owner always sees it. When the conversation would not have reached
   * them — an agent in a channel they are not in, or asking from across the
   * office — their copy is marked private and shown in their own corner
   * rather than in a transcript they cannot open.
   */
  #approvalAudience(
    client: Client,
    entry: TrackedApproval,
  ): { visible: boolean; private: boolean } {
    const player = this.state.players.get(client.sessionId);
    if (!player || player.kind === 'agent') return { visible: false, private: false };
    const inConversation = canSeeApproval(
      entry,
      {
        x: player.x,
        y: player.y,
        inChannel: !!(entry.value.channelId && this.#channelFor(player.userId, entry.value.channelId)),
        followedZone: this.#followed.get(client.sessionId) ?? null,
      },
      this.#settings.chatRadiusTiles * this.#map.tileSize,
    );
    const isOwner = player.userId === entry.value.ownerUserId;
    if (inConversation) return { visible: true, private: false };
    if (isOwner && needsPrivateCopy(inConversation)) return { visible: true, private: true };
    return { visible: false, private: false };
  }

  #publishApproval(entry: TrackedApproval): void {
    for (const client of this.clients) {
      const audience = this.#approvalAudience(client, entry);
      if (!audience.visible) continue;
      client.send(ServerMessage.Approval, {
        ...entry.value,
        ...(audience.private ? { private: true } : {}),
      } satisfies PublicApprovalRequest);
    }
  }

  #publishActivity(entry: { value: PublicActivity; x: number; y: number }): void {
    for (const client of this.clients) {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.kind === 'agent') continue; // no wakeups, mentions or unread events
      const visible = entry.value.channelId ? !!this.#channelFor(player.userId, entry.value.channelId) :
        this.#followed.get(client.sessionId) === entry.value.zoneId ||
        Math.hypot(player.x - entry.x, player.y - entry.y) <= this.#settings.chatRadiusTiles * this.#map.tileSize;
      if (visible) client.send('activity', { ...entry.value, nearby: !entry.value.channelId &&
        Math.hypot(player.x - entry.x, player.y - entry.y) <= this.#settings.chatRadiusTiles * this.#map.tileSize });
    }
  }

  #closeActivity(entry: { value: PublicActivity; owner: string; conversationId: string; x: number; y: number }, state: 'disconnected' | 'interrupted'): void {
    entry.value = { ...entry.value, state, updatedAt: Date.now(), receivedAt: Date.now(),
      items: entry.value.items.map(item => item.state === 'running' || item.state === 'pending'
        ? { ...item, state: 'interrupted', endedAt: Date.now() } : item) };
    this.#publishActivity(entry);
    void keepActivity(getDb(), entry.conversationId, this.#workspaceId, entry.value,
      entry.value.channelId ? null : entry).catch(error => logger.error('[office] activity close failed', error));
  }

  #onAgentSay(client: Client, payload: AgentSayPayload): void {
    const session = this.#agentSession(client);
    const speaker = this.state.players.get(client.sessionId);
    if (!session || !speaker) return;

    const text = String(payload?.text ?? '').trim();
    audit(session.identity.id, 'command.say', { text });
    markSeen(session.identity.id);

    if (!hasScope(session.identity, 'chat')) {
      this.#denyAgent(client, session, 'missing_scope', 'This agent has no "chat" scope.');
      return;
    }
    // A post in a channel may be a whole review; speech stays a bubble.
    const maxLength = messageMaxLength(payload?.channelId);
    if (text.length === 0 || text.length > maxLength) {
      this.#denyAgent(
        client,
        session,
        'invalid_payload',
        `text must be 1..${maxLength} characters.`,
      );
      return;
    }

    const waitMs = allowChat(session, Date.now());
    if (waitMs > 0) {
      this.#denyAgent(client, session, 'rate_limited', 'Agents may speak once every 2s.', waitMs);
      return;
    }

    if (typeof payload?.channelId === 'string' && payload.channelId.length > 0) {
      const channel = this.#channelFor(speaker.userId, payload.channelId);
      if (!channel) {
        this.#denyAgent(client, session, 'not_found', 'Not a channel you are in.');
        return;
      }
      this.#deliverChannelChat(client.sessionId, speaker, channel, text);
      audit(session.identity.id, 'effect.posted', {
        text,
        kind: channel.kind,
        // A DM's slug is a pair key, not a name; the log gets the kind and
        // the conversation id, which is what "which DM" actually means.
        channel: channel.kind === 'dm' ? channel.id : channel.slug,
      });
      return;
    }

    // If this is the line the office asked for, the exchange moves on.
    this.#onBanterLine(client.sessionId, speaker, text, Date.now());
    this.#deliverChat(client.sessionId, speaker, text);
    audit(session.identity.id, 'effect.spoke', { text, heardBy: this.#earshotCount(speaker) });
  }

  #onAgentMoveTo(client: Client, payload: AgentMoveToPayload): void {
    const session = this.#agentSession(client);
    if (!session) return;

    audit(session.identity.id, 'command.move_to', payload);
    markSeen(session.identity.id);

    if (!hasScope(session.identity, 'move')) {
      this.#denyAgent(client, session, 'missing_scope', 'This agent has no "move" scope.');
      return;
    }

    const waitMs = allowMove(session, Date.now());
    if (waitMs > 0) {
      this.#denyAgent(client, session, 'rate_limited', 'Agents may move twice a second.', waitMs);
      return;
    }

    // TODO(step 0.8): private zones. Once zones carry access rules, an agent
    // routed into a `private` zone should be refused here with `unroutable`
    // unless its owner is inside. The hook is deliberately this one place.

    const routed =
      typeof payload?.zoneId === 'string'
        ? this.walkToZone(client.sessionId, payload.zoneId)
        : typeof payload?.person === 'string'
          ? this.walkToPerson(client.sessionId, payload.person)
          : this.walkTo(client.sessionId, Number(payload?.x), Number(payload?.y));

    if (!routed) {
      this.#denyAgent(
        client,
        session,
        'unroutable',
        typeof payload?.person === 'string'
          ? `Nobody called "${payload.person}" is here, or there is nowhere to stand beside them.`
          : 'No route to that destination, or it does not exist.',
      );
    }
  }

  #onAgentSetStatus(client: Client, payload: AgentSetStatusPayload): void {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;

    const rawStatus = String(payload?.status ?? '').slice(0, AGENT_STATUS_MAX_LENGTH).trim();
    const status = rawStatus && (payload?.channelId || payload?.channelIds?.length) ? 'working' : rawStatus;
    audit(session.identity.id, 'command.set_status', { status });
    markSeen(session.identity.id);

    if (!hasScope(session.identity, 'status')) {
      this.#denyAgent(client, session, 'missing_scope', 'This agent has no "status" scope.');
      return;
    }

    // Where the work is. Only conversations this agent is in — anything else
    // is dropped, never an error: a stale channel id must not stop a status
    // line from landing. Several at once, because an agent may be answering
    // several; `zone` marks spatial work. A harness that names no
    // conversation and does not say `spatial` is one that predates parallel
    // turns, and an empty list reads as spatial for it (`workingInTokens`).
    // Capped at the most turns an agent may run: anything past that is not
    // a picture of its work, whatever it is.
    const named = [
      ...(typeof payload?.channelId === 'string' ? [payload.channelId] : []),
      ...(Array.isArray(payload?.channelIds)
        ? payload.channelIds.slice(0, AGENT_PARALLELISM_MAX)
        : []),
    ];
    const conversations = [
      ...new Set(
        named
          .map((channelId) => this.#channelFor(player.userId, channelId)?.id)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const tokens =
      status.length === 0
        ? []
        : payload?.spatial === true
          ? [...conversations, WORKING_IN_ZONE]
          : conversations;
    const workingIn = tokens.join(',');
    // The clock beside it: started when idle turns to working, held while
    // the work goes on, dropped at idle. A crashed harness cannot leave it
    // running — its player leaves the room with it.
    const workingSince = workingSinceAfter(player, workingIn, Date.now());
    if (player.workingIn !== workingIn) player.workingIn = workingIn;
    if (player.workingSince !== workingSince) player.workingSince = workingSince;

    if (player.status !== status) {
      player.status = status;
      session.identity.status = status;
      persistStatus(session.identity.id, status);
      audit(session.identity.id, 'effect.status_changed', { status });
      this.#broadcastRosterToAgents();
    }
  }

  /**
   * A balloon over the head.
   *
   * Under the `status` scope — it is the status line in a glyph — and only
   * ever a catalogue id, because a balloon is a picture the office draws for
   * everybody and an agent does not get to draw arbitrary things. The office
   * owns the timer too: a balloon with a TTL comes down here, on the tick,
   * so a client that joined late agrees with one that saw it go up.
   */
  #onAgentEmote(client: Client, payload: AgentEmotePayload): void {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;

    const emote = String(payload?.emote ?? '').trim();
    if (emote.length > 0 && !isEmote(emote)) {
      this.#denyAgent(client, session, 'invalid_payload', `"${emote}" is not an emote.`);
      return;
    }
    if (!hasScope(session.identity, 'status')) {
      this.#denyAgent(client, session, 'missing_scope', 'This agent has no "status" scope.');
      return;
    }

    const ttlRaw = payload?.ttlMs;
    const ttlMs =
      ttlRaw === undefined
        ? EMOTE_TTL_DEFAULT_MS
        : Math.min(Math.max(Number(ttlRaw) || 0, 0), EMOTE_TTL_MAX_MS);
    const wanted = { emote, ttlMs, chosen: ttlRaw === undefined };

    // A flicker guard, not a refusal. Balloons follow status lines, and a
    // tool-heavy turn flips those several times a second; refusing the extra
    // ones left the *last* balloon unset — the map showing a lightbulb on an
    // agent that had gone idle, with six "rate_limited" rows in its log. Now
    // the newest wanted balloon is kept and applied when the interval is up,
    // so the office always ends on the balloon the harness meant.
    const waitMs = allowEmote(session, Date.now());
    if (waitMs > 0) {
      const pending = this.#emoteLater.get(client.sessionId);
      if (pending) {
        pending.wanted = wanted;
        return;
      }
      const timer = setTimeout(() => {
        const later = this.#emoteLater.get(client.sessionId);
        this.#emoteLater.delete(client.sessionId);
        if (!later || !this.state.players.has(client.sessionId)) return;
        session.lastEmoteAt = Date.now();
        this.#applyEmote(client.sessionId, session, later.wanted);
      }, waitMs);
      this.#emoteLater.set(client.sessionId, { timer, wanted });
      return;
    }

    this.#applyEmote(client.sessionId, session, wanted);
  }

  #applyEmote(
    sessionId: string,
    session: AgentSession,
    wanted: { emote: string; ttlMs: number; chosen: boolean },
  ): void {
    const player = this.state.players.get(sessionId);
    if (!player) return;
    const until = wanted.emote.length === 0 || wanted.ttlMs === 0 ? 0 : Date.now() + wanted.ttlMs;
    if (player.emote !== wanted.emote) player.emote = wanted.emote;
    if (player.emoteUntil !== until) player.emoteUntil = until;
    // Only the chosen ones are worth a log line; the derived ones follow the
    // status changes that are already logged.
    if (wanted.chosen && wanted.emote.length > 0) {
      audit(session.identity.id, 'command.emote', { emote: wanted.emote });
    }
  }

  /** Bring down balloons whose time is up. Called from the tick, once a second. */
  #sweepEmotes(now: number): void {
    for (const player of this.state.players.values()) {
      if (player.emoteUntil !== 0 && player.emoteUntil <= now) {
        player.emote = '';
        player.emoteUntil = 0;
      }
    }
  }

  /**
   * A harness describing the machine it runs on.
   *
   * Unscoped, because it changes nothing anybody else can see — it is the
   * agent telling its owner where it lives. It is still *untrusted*: an agent
   * key is a credential pasted into a config file, and everything here ends up
   * rendered on the owner's settings page, so `recordHost` normalises it and
   * drops runtime ids that aren't in the catalogue.
   */
  #onAgentHostReport(client: Client, payload: AgentHostReportPayload): void {
    const session = this.#agentSession(client);
    if (!session) return;

    markSeen(session.identity.id);
    const workspacePath = String(payload?.workspacePath ?? '');

    audit(session.identity.id, 'command.host_report', {
      label: payload?.label,
      workspacePath,
      runtimes: payload?.runtimes?.length ?? 0,
    });

    persistHostReport({
      agentId: session.identity.id,
      workspaceId: session.identity.workspaceId,
      ownerUserId: session.identity.ownerUserId,
      // The runtime list is passed through exactly as it arrived, including
      // absent: only the first agent of a fleet scans PATH, and `[]` from the
      // other seven would erase the answer seconds after getting it.
      report: {
        label: payload?.label,
        reposDir: payload?.reposDir,
        ...(payload?.runtimes ? { runtimes: payload.runtimes } : {}),
      },
      workspacePath,
    });
  }

  /**
   * The task an agent is on, for its card — or `null`, for none.
   *
   * Under the `status` scope, like the balloon: it is presence, drawn for
   * everybody in the room. Room state only — a harness says it again when it
   * reconnects, so nothing is persisted, and the leave clears it. A payload
   * that is neither a task nor `null` is refused rather than read as a clear.
   */
  #onAgentTask(client: Client, payload: unknown): void {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;

    markSeen(session.identity.id);
    const task = parseAgentTask(payload);
    if (task === undefined) {
      this.#denyAgent(client, session, 'invalid_payload', 'agent:task wants a task or null.');
      return;
    }
    if (!hasScope(session.identity, 'status')) {
      this.#denyAgent(client, session, 'missing_scope', 'This agent has no "status" scope.');
      return;
    }

    if (applyAgentTask(player, task)) {
      audit(
        session.identity.id,
        'effect.task_changed',
        task
          ? {
              title: task.title,
              repo: task.repo,
              branch: task.branch,
              ...(task.pr ? { pr: task.pr.number, prState: task.pr.state } : {}),
              ...(task.item ? { item: task.item } : {}),
            }
          : { task: null },
      );
    }
    // Every time, not only on a change: the ledger's "last seen" and a
    // harness reconnecting with the same task both need to be heard.
    void this.#ledgerTask(session.identity, task);
  }

  #onAgentLookAround(client: Client, payload: AgentLookAroundPayload): void {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;

    audit(session.identity.id, 'command.look_around', {});
    markSeen(session.identity.id);

    const tile = this.#tileOf(player);
    const zone = zoneAt(this.#map, tile.x, tile.y);
    const result: LookAroundResult = {
      zone: zone ? { id: zone.id, label: zone.label, kind: zone.kind } : null,
      tile,
      occupants: this.#occupantsAround(client.sessionId),
    };
    this.#reply(client, payload?.requestId, result);
  }

  /**
   * Read what was said.
   *
   * This used to be limited to what the agent could plausibly have heard, on
   * the grounds that an agent must not be a way to read the office from a
   * corner of it. Now that a transcript is kept and any member can open any
   * zone's, that limit protected nothing a person could not already do — so
   * an agent reads by the same rule a person does. Private zones will gate
   * both alike when they gate anything.
   */
  async #onAgentMessagesGet(client: Client, payload: AgentMessagesGetPayload): Promise<void> {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;

    const scope =
      payload?.scope === 'zone' || payload?.scope === 'mentions' || payload?.scope === 'channel'
        ? payload.scope
        : 'nearby';
    const limit = Math.min(Math.max(Number(payload?.n) || MESSAGES_GET_MAX, 1), MESSAGES_GET_MAX, 50);
    const before = Number(payload?.before);
    const paging = Number.isFinite(before) && before > 0 ? { before } : {};
    audit(session.identity.id, 'command.messages_get', { scope, n: limit });
    markSeen(session.identity.id);

    const db = getDb();
    const workspaceId = this.#workspaceId;
    let zoneId: string | null = null;
    let channelId: string | null = null;
    let page: MessagePage;
    try {
      if (scope === 'mentions') {
        page = await mentionsOf(db, session.identity.id, { workspaceId, limit, ...paging });
      } else if (scope === 'channel') {
        const channel = this.#channelFor(session.identity.id, payload?.channelId);
        if (!channel) {
          this.#replyError(client, payload?.requestId, {
            code: 'not_found',
            message: 'Not a channel you are in.',
          });
          return;
        }
        channelId = channel.id;
        page = await recentMessages(db, channel.id, { workspaceId, limit, ...paging });
      } else if (scope === 'zone') {
        zoneId = this.#zoneIdFor(player, payload?.zoneId);
        if (zoneId === null) {
          this.#replyError(client, payload?.requestId, {
            code: 'not_found',
            message: 'No such zone.',
          });
          return;
        }
        const conversationId = (await this.#conversations).get(zoneId);
        page = conversationId
          ? await recentMessages(db, conversationId, { workspaceId, limit, ...paging })
          : { messages: [], hasMore: false };
      } else {
        page = await recentMessagesNear(db, {
          workspaceId,
          mapId: this.state.mapId,
          x: player.x,
          y: player.y,
          radius: this.#settings.chatRadiusTiles * this.#map.tileSize,
          limit,
          ...paging,
        });
      }
      if (scope !== 'mentions') {
        const conversationId = channelId ?? (zoneId ? (await this.#conversations).get(zoneId) : undefined);
        const activity = await readActivity(db, workspaceId, { ...(conversationId ? { conversationId } : {}),
          mapId: this.state.mapId, x: player.x, y: player.y,
          radius: this.#settings.chatRadiusTiles * this.#map.tileSize, ...paging });
        if (channelId && !this.#channelFor(session.identity.id, channelId)) return;
        const replies: StoredMessage[] = activity.map((turn): StoredMessage => ({
          id: turn.turnId, conversationId: conversationId ?? '', fromId: turn.agentId, fromKind: 'agent',
          fromName: turn.agentName, text: turn.items.filter(item => item.kind === 'message').map(item => item.text).join('\n\n'),
          sentAt: turn.startedAt, x: null, y: null,
        })).filter(message => message.text.length > 0);
        const combined = [...page.messages, ...replies].sort((a, b) => a.sentAt - b.sentAt);
        page = { messages: combined.slice(-limit), hasMore: page.hasMore || activity.length === 50 || combined.length > limit };
      }
    } catch (error: unknown) {
      logger.error('[office] could not read messages', error);
      this.#replyError(client, payload?.requestId, {
        code: 'unavailable',
        message: 'Could not read messages.',
      });
      return;
    }

    const result: MessagesGetResult = {
      scope,
      zoneId,
      channelId,
      hasMore: page.hasMore,
      messages: page.messages.map((message) => this.#toChatEvent(message, player)),
    };
    this.#reply(client, payload?.requestId, result);
  }

  // --- the board, for agents -----------------------------------------------

  /**
   * An agent's session, if the call is in its `board` scope. Everything on
   * the board is under one scope, reads included: what an agent reads from
   * the board it acts on, and an owner who does not want it taking work from
   * there does not want it reading it either.
   */
  #agentBoardSession(client: Client, payload: AgentRequest | undefined): AgentSession | null {
    const session = this.#agentSession(client);
    if (!session) return null;
    if (!hasScope(session.identity, 'board')) {
      const message = 'This agent has no "board" scope.';
      audit(session.identity.id, 'command.rejected', { code: 'missing_scope', message });
      this.#replyError(client, payload?.requestId, { code: 'missing_scope', message });
      return null;
    }
    return session;
  }

  /**
   * An agent writes on the board as its owner: it holds the pen if its owner
   * does, and hands a note only where its owner could. Read from the row
   * each time, like a person's standing, so an owner who has left takes the
   * agent's pen with them.
   */
  async #agentBoardActor(client: Client, session: AgentSession, requestId: unknown): Promise<ChannelActor | null> {
    const actor = await this.#actorForUser(session.identity.ownerUserId);
    if (!mayWriteBoard(actor)) {
      this.#replyError(client, requestId, {
        code: 'unauthorised',
        message: 'Your owner is not a member of this office, so you have no pen for its board.',
      });
      return null;
    }
    return actor;
  }

  /**
   * Who a note is for, as an agent says it: a name, an id, or "me". Null for
   * nobody. The match is against every agent of the office, present or not,
   * and refused if a name fits more than one — a display name is not an
   * identity. Replies with the refusal itself; the caller only returns.
   */
  async #agentNamedOnBoard(
    client: Client,
    session: AgentSession,
    actor: ChannelActor,
    wanted: unknown,
    requestId: unknown,
  ): Promise<{ id: string } | null | undefined> {
    if (wanted === null || wanted === undefined) return null;
    if (typeof wanted !== 'string' || wanted.trim().length === 0) {
      this.#replyError(client, requestId, { code: 'invalid_payload', message: 'assignee is an agent, by name, or null.' });
      return undefined;
    }
    await this.#boardLoaded;
    const needle = wanted.trim().replace(/^@/, '').toLowerCase();
    const self = session.identity;
    const matches =
      needle === 'me' || needle === self.id || needle === self.name.toLowerCase()
        ? this.#boardAgents.filter((agent) => agent.id === self.id)
        : this.#boardAgents.filter((agent) => agent.id === wanted.trim() || agent.name.toLowerCase() === needle);
    const agent = matches.length === 1 ? matches[0] : undefined;
    if (!agent) {
      this.#replyError(client, requestId, {
        code: 'not_found',
        message:
          matches.length === 0
            ? `No agent here called ${wanted.trim()}. board_list names them.`
            : `More than one agent here is called ${wanted.trim()}.`,
      });
      return undefined;
    }
    if (!mayAssignBoardItem(actor, agent)) {
      this.#replyError(client, requestId, {
        code: 'unauthorised',
        message: `Only ${agent.name}'s owner${agent.ownerName ? `, ${agent.ownerName},` : ''} hands them a note. Say so where you were asked instead, and leave the note on the board.`,
      });
      return undefined;
    }
    return { id: agent.id };
  }

  /**
   * One write's worth of the agent's board pace, or a refusal with how long
   * to wait. Taken before the write, not after: a refused write costs the
   * room nothing, and a harness that backs off on `retryAfterMs` writes the
   * same notes a little later.
   */
  #agentBoardPaced(client: Client, session: AgentSession, requestId: unknown): boolean {
    const now = Date.now();
    if (this.#boardPace.tryConsume(session.identity.id, now)) return true;
    const retryAfterMs = this.#boardPace.retryAfterSeconds(session.identity.id, now) * 1000;
    const message = `Agents may write on the board ${AGENT_BOARD_WRITES_PER_WINDOW} times every ${AGENT_BOARD_WRITE_WINDOW_MS / 1000}s.`;
    audit(session.identity.id, 'command.rejected', { code: 'rate_limited', message });
    this.#replyError(client, requestId, { code: 'rate_limited', message, retryAfterMs });
    return false;
  }

  /** The line to say when a write put a note in another agent's hands; null otherwise. */
  #handoverFor(session: AgentSession, before: BoardItemRef | null, after: BoardItemRef): string | null {
    if (!after.assignee || after.assignee.id === session.identity.id) return null;
    if (before?.assignee?.id === after.assignee.id) return null;
    return assignmentLine(after, after.assignee.name);
  }

  async #onAgentBoardList(client: Client, payload: AgentBoardListPayload): Promise<void> {
    const session = this.#agentBoardSession(client, payload);
    if (!session) return;
    const status = isBoardStatus(payload?.status) ? payload.status : null;
    const mine = payload?.mine === true;
    audit(session.identity.id, 'command.board_list', { status, mine });
    markSeen(session.identity.id);
    await this.#boardLoaded;
    const me = session.identity.id;
    const result: BoardListResult = {
      items: this.#boardItems.filter(
        (item) => (status === null || item.status === status) && (!mine || item.assignee?.id === me),
      ) as BoardItemRef[],
      agents: this.#boardAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        ownerName: agent.ownerName,
        yours: agent.ownerUserId === session.identity.ownerUserId,
      })),
      you: { agentId: me, name: session.identity.name },
    };
    this.#reply(client, payload?.requestId, result);
  }

  async #onAgentBoardGet(client: Client, payload: AgentBoardGetPayload): Promise<void> {
    const session = this.#agentBoardSession(client, payload);
    if (!session) return;
    const number = Number(payload?.number);
    audit(session.identity.id, 'command.board_get', { number });
    markSeen(session.identity.id);
    if (!Number.isSafeInteger(number) || number <= 0) {
      this.#replyError(client, payload?.requestId, { code: 'invalid_payload', message: 'board_get wants a note number.' });
      return;
    }
    try {
      const item = await findBoardItemByNumber(getDb(), this.#workspaceId, number);
      if (!item) {
        this.#replyError(client, payload?.requestId, { code: 'not_found', message: `No note #${number} on this board.` });
        return;
      }
      this.#reply(client, payload?.requestId, { item } satisfies BoardGetResult);
    } catch (error: unknown) {
      logger.error('[office] could not read a board note for an agent', error);
      this.#replyError(client, payload?.requestId, { code: 'unavailable', message: 'Could not read the board.' });
    }
  }

  async #onAgentBoardCreate(client: Client, payload: AgentBoardCreatePayload): Promise<void> {
    const session = this.#agentBoardSession(client, payload);
    if (!session) return;
    markSeen(session.identity.id);
    if (!this.#agentBoardPaced(client, session, payload?.requestId)) return;
    const actor = await this.#agentBoardActor(client, session, payload?.requestId);
    if (!actor) return;
    const assignee = await this.#agentNamedOnBoard(client, session, actor, payload?.assignee, payload?.requestId);
    if (assignee === undefined) return;
    const note = parseBoardCreate({
      title: payload?.title,
      body: payload?.body,
      status: payload?.status,
      color: payload?.color,
      labels: payload?.labels,
      assigneeAgentId: assignee?.id ?? null,
    });
    if (!note) {
      this.#replyError(client, payload?.requestId, {
        code: 'invalid_payload',
        message: 'A note needs a title (one line, 200 characters), and a known column and colour if you name them.',
      });
      return;
    }
    try {
      const item = await createBoardItem(getDb(), {
        workspaceId: this.#workspaceId,
        ...note,
        createdBy: { agentId: session.identity.id },
      });
      audit(session.identity.id, 'command.board_create', {
        number: item.number,
        title: item.title,
        assignee: item.assignee?.name ?? null,
      });
      this.#boardEvent({
        kind: 'item.created',
        actor: { kind: 'agent', id: session.identity.id, name: session.identity.name },
        itemId: item.id,
        payload: { number: item.number, title: item.title, assignee: item.assignee?.name ?? null },
      });
      await this.#refreshBoard();
      this.#reply(client, payload?.requestId, {
        item,
        handover: this.#handoverFor(session, null, item),
      } satisfies BoardWriteResult);
    } catch (error: unknown) {
      this.#agentBoardRefused(client, payload?.requestId, error);
    }
  }

  async #onAgentBoardUpdate(client: Client, payload: AgentBoardUpdatePayload): Promise<void> {
    const session = this.#agentBoardSession(client, payload);
    if (!session) return;
    markSeen(session.identity.id);
    if (!this.#agentBoardPaced(client, session, payload?.requestId)) return;
    const actor = await this.#agentBoardActor(client, session, payload?.requestId);
    if (!actor) return;
    const number = Number(payload?.number);
    if (!Number.isSafeInteger(number) || number <= 0) {
      this.#replyError(client, payload?.requestId, { code: 'invalid_payload', message: 'board_update wants a note number.' });
      return;
    }
    try {
      const db = getDb();
      const before = await findBoardItemByNumber(db, this.#workspaceId, number);
      if (!before) {
        this.#replyError(client, payload?.requestId, { code: 'not_found', message: `No note #${number} on this board.` });
        return;
      }
      const reassign = payload?.assignee !== undefined;
      const assignee = reassign
        ? await this.#agentNamedOnBoard(client, session, actor, payload.assignee, payload?.requestId)
        : null;
      if (assignee === undefined) return;
      const patch = parseBoardUpdate({
        itemId: before.id,
        ...(payload?.title !== undefined ? { title: payload.title } : {}),
        ...(payload?.body !== undefined ? { body: payload.body } : {}),
        ...(payload?.status !== undefined ? { status: payload.status } : {}),
        ...(payload?.color !== undefined ? { color: payload.color } : {}),
        ...(payload?.labels !== undefined ? { labels: payload.labels } : {}),
        ...(reassign ? { assigneeAgentId: assignee?.id ?? null } : {}),
      });
      if (!patch) {
        this.#replyError(client, payload?.requestId, {
          code: 'invalid_payload',
          message: 'Name what changes about the note, and make it something the board takes: a one-line title, a known column, a known colour.',
        });
        return;
      }
      const after = await updateBoardItem(db, { workspaceId: this.#workspaceId, ...patch });
      audit(session.identity.id, 'command.board_update', {
        number: after.number,
        changed: Object.keys(patch).filter((key) => key !== 'itemId'),
        ...(reassign ? { assignee: after.assignee?.name ?? null } : {}),
      });
      this.#boardEvent({
        kind: 'item.updated',
        actor: { kind: 'agent', id: session.identity.id, name: session.identity.name },
        itemId: after.id,
        payload: { number: after.number, changed: Object.keys(patch).filter((key) => key !== 'itemId') },
      });
      await this.#refreshBoard();
      this.#reply(client, payload?.requestId, {
        item: after,
        handover: this.#handoverFor(session, before, after),
      } satisfies BoardWriteResult);
    } catch (error: unknown) {
      this.#agentBoardRefused(client, payload?.requestId, error);
    }
  }

  #agentBoardRefused(client: Client, requestId: unknown, error: unknown): void {
    if (error instanceof BoardItemError) {
      this.#replyError(client, requestId, {
        code: error.reason === 'not_found' ? 'not_found' : error.reason === 'full' ? 'too_large' : 'invalid_payload',
        message: error.message,
      });
      return;
    }
    logger.error('[office] board write by an agent failed', error);
    this.#replyError(client, requestId, { code: 'unavailable', message: 'The board could not be written.' });
  }

  // --- routines ------------------------------------------------------------

  /** The session of an agent that is in the room, by its identity; null when it is away. */
  #agentSessionIdOf(agentId: string): string | null {
    for (const [sessionId, session] of this.#agents) {
      if (session.id === agentId) return sessionId;
    }
    return null;
  }

  /** Whether the agent at this session is on a turn in this conversation right now. */
  #agentBusyIn(sessionId: string, conversationId: string): boolean {
    for (const entry of this.#activity.values()) {
      if (entry.owner === sessionId && entry.conversationId === conversationId && !activityTerminal(entry.value.state)) return true;
    }
    return false;
  }

  /**
   * Every fifteen seconds: what is due, and what was missed and can be made
   * up. Each due slot is claimed by writing its run and moving the routine
   * past it in one transaction — the unique index decides between two rooms
   * of one office — so a slot is handled once whatever came of it. A slot to
   * be spoken is written `missed` and settled as it is spoken, so a room
   * that stops between the two leaves a slot to make up, not a line on the
   * record that nobody heard. See `docs/ROUTINES.md`.
   */
  async #tickRoutines(): Promise<void> {
    if (this.#routineTicking) return;
    this.#routineTicking = true;
    try {
      const db = getDb();
      const now = Date.now();
      for (const routine of await listDueRoutines(db, this.#workspaceId, now)) {
        const dueAt = routine.nextDueAt;
        if (dueAt === null) continue;
        const where = await this.#routineWhere(routine);
        const decision = decideSlot(where.agent);
        const run = await claimRoutineRun(db, {
          routine,
          dueAt,
          outcome: decision.fire ? 'missed' : decision.outcome,
          note: decision.fire ? '' : decision.note,
        });
        if (!run) continue; // another room of this office has the slot
        if (decision.fire) {
          await this.#fireRoutine(routine, run, where, 'fired');
        } else {
          audit(routine.agentId, decision.outcome === 'missed' ? 'routine.missed' : 'routine.skipped', {
            routineId: routine.id,
            name: routine.name,
            dueAt,
            reason: decision.note,
          });
        }
      }
      for (const run of await missedRoutineRuns(db, this.#workspaceId)) {
        const routine = await getRoutine(db, this.#workspaceId, run.routineId);
        if (!routine || routine.paused) continue;
        const where = await this.#routineWhere(routine);
        if (!shouldMakeUp({ now, nextDueAt: routine.nextDueAt, agent: where.agent })) continue;
        await this.#fireRoutine(routine, run, where, 'made_up');
      }
    } catch (error: unknown) {
      logger.error('[office] could not tick routines', error);
    } finally {
      this.#routineTicking = false;
    }
  }

  /**
   * Where a routine would speak, and whether its agent is there to hear:
   * the owner's DM with the agent, opened as the owner would open it, so an
   * owner who has left or an agent without `dm` has no door and the slot
   * says so rather than speaking into nothing.
   */
  async #routineWhere(routine: RoutineSummary): Promise<RoutineWhere> {
    const actor = await this.#actorForUser(routine.agentOwnerUserId);
    const channel = mayManageRoutine(actor, { ownerUserId: routine.agentOwnerUserId })
      ? await this.#dmWith(actor, routine.agentId)
      : null;
    const sessionId = this.#agentSessionIdOf(routine.agentId);
    return {
      actor,
      channel,
      sessionId,
      agent: {
        present: sessionId !== null,
        busyHere: sessionId !== null && channel !== null && this.#agentBusyIn(sessionId, channel.id),
      },
    };
  }

  /**
   * Settle the run as spoken and speak the line in the owner's name, with
   * the brief. The settle is the claim to speak: it moves the run off
   * `missed`, and only the room whose write lands says the line — two rooms
   * making up one slot both try, one speaks — with the line following in the
   * same turn of the event loop, so nothing of the office's comes between.
   * No door — the owner gone, the agent without `dm` or revoked — pauses
   * the routine and records why: a routine that cannot be spoken should not
   * keep trying every slot in silence, and its card should say so.
   */
  async #fireRoutine(
    routine: RoutineSummary,
    run: RoutineRunRef,
    where: RoutineWhere,
    outcome: 'fired' | 'made_up',
  ): Promise<void> {
    const db = getDb();
    const now = Date.now();
    const agent = where.channel ? await findAgentById(db, routine.agentId) : null;
    if (!where.channel || !agent) {
      const note = !where.channel ? (where.actor.role === null ? 'owner_left' : 'no_dm') : 'agent_gone';
      const won = await settleRoutineRun(db, run.id, { outcome: 'skipped', note, firedAt: null, conversationId: null });
      if (!won) return;
      await updateRoutine(db, { workspaceId: this.#workspaceId, routineId: routine.id, paused: true, now });
      audit(routine.agentId, 'routine.skipped', { routineId: routine.id, name: routine.name, dueAt: run.dueAt, reason: note });
      logger.warn(`[office] routine "${routine.name}" paused: ${note}`);
      return;
    }
    // The owner speaks, from their session when they are here and from nowhere when not.
    let ownerSessionId: string | null = null;
    for (const [sessionId, player] of this.state.players) {
      if (player.kind === 'human' && player.userId === routine.agentOwnerUserId) {
        ownerSessionId = sessionId;
        break;
      }
    }
    const command = routine.command ? this.#commands.find((candidate) => candidate.id === routine.command?.id) ?? null : null;
    const won = await settleRoutineRun(db, run.id, { outcome, firedAt: now, conversationId: where.channel.id });
    if (!won) return; // another room of this office spoke it
    this.#deliverChannelChat(
      ownerSessionId,
      { userId: routine.agentOwnerUserId, name: agent.ownerName, kind: 'human' },
      where.channel,
      routineLine(routine),
      undefined,
      routineBrief(routine, command, run.dueAt),
    );
    await markRoutineRan(db, routine, now);
    audit(routine.agentId, outcome === 'fired' ? 'routine.fired' : 'routine.made_up', {
      routineId: routine.id,
      name: routine.name,
      dueAt: run.dueAt,
    });
  }

  // --- the office's commands, for agents -----------------------------------

  /**
   * An agent's session, if the call is in its `commands` scope. Reads are
   * under it too: the instructions are the office's briefs to its agents,
   * and an owner who does not want an agent rewriting them may not want it
   * quoting them either.
   */
  #agentCommandSession(client: Client, payload: AgentRequest | undefined): AgentSession | null {
    const session = this.#agentSession(client);
    if (!session) return null;
    if (!hasScope(session.identity, 'commands')) {
      const message = 'This agent has no "commands" scope.';
      audit(session.identity.id, 'command.rejected', { code: 'missing_scope', message });
      this.#replyError(client, payload?.requestId, { code: 'missing_scope', message });
      return null;
    }
    return session;
  }

  /** A command as an agent reads it, with whether this agent's owner may change it. */
  #agentCommandRef(command: OfficeCommandSummary, actor: ChannelActor): AgentCommandRef {
    return {
      name: command.name,
      summary: command.summary,
      argumentHint: command.argumentHint,
      instructions: command.instructions,
      usage: officeCommandUsage(officeCommandRef(command)),
      defaultTarget: command.defaultTarget ? { kind: command.defaultTarget.kind, name: command.defaultTarget.name } : null,
      by: officeCommandAuthorLabel(command),
      yours: mayEditOfficeCommand(actor, command),
      updatedAt: command.updatedAt,
    };
  }

  /** The command a name says, from the list the room keeps, read fresh so a write just made is found. */
  async #agentCommandNamed(client: Client, wanted: unknown, requestId: unknown): Promise<OfficeCommandSummary | null> {
    const name = normaliseOfficeCommandName(wanted);
    if (name.length === 0) {
      this.#replyError(client, requestId, { code: 'invalid_payload', message: 'Name the command.' });
      return null;
    }
    await this.#refreshChannels();
    const command = this.#commands.find((candidate) => candidate.name === name);
    if (!command) {
      this.#replyError(client, requestId, { code: 'not_found', message: `There is no !${name} in this office. command_list names them.` });
      return null;
    }
    return command;
  }

  /**
   * A default target as an agent says it: an agent or a team of the office,
   * by name. Null for none. `undefined` after a refusal, which is already
   * sent. "me" is the agent itself.
   */
  async #agentCommandTarget(
    client: Client,
    session: AgentSession,
    wanted: unknown,
    requestId: unknown,
  ): Promise<OfficeCommandTargetInput | null | undefined> {
    if (wanted === null || wanted === undefined) return null;
    if (typeof wanted !== 'string') {
      this.#replyError(client, requestId, { code: 'invalid_payload', message: 'defaultTarget is an agent or a team, by name, or null.' });
      return undefined;
    }
    const needle = wanted.trim().replace(/^@/, '').toLowerCase();
    if (needle.length === 0 || needle === 'nobody') return null;
    await this.#boardLoaded;
    const self = session.identity;
    if (needle === 'me' || needle === self.name.toLowerCase()) return { kind: 'agent', id: self.id };
    const agents = this.#boardAgents.filter((agent) => agent.name.toLowerCase() === needle);
    const teams = this.#teams.filter((team) => team.name.toLowerCase() === needle);
    if (agents.length + teams.length !== 1) {
      this.#replyError(client, requestId, {
        code: 'not_found',
        message:
          agents.length + teams.length === 0
            ? `No agent or team here called ${wanted.trim()}.`
            : `More than one agent or team here is called ${wanted.trim()}; leave the default off and say so.`,
      });
      return undefined;
    }
    return agents[0] ? { kind: 'agent', id: agents[0].id } : { kind: 'team', id: teams[0]!.id };
  }

  /** One write's worth of the agent's command pace, or a refusal with how long to wait. */
  #agentCommandPaced(client: Client, session: AgentSession, requestId: unknown): boolean {
    const now = Date.now();
    if (this.#commandPace.tryConsume(session.identity.id, now)) return true;
    const retryAfterMs = this.#commandPace.retryAfterSeconds(session.identity.id, now) * 1000;
    const message = `Agents may write commands ${AGENT_BOARD_WRITES_PER_WINDOW} times every ${AGENT_BOARD_WRITE_WINDOW_MS / 1000}s.`;
    audit(session.identity.id, 'command.rejected', { code: 'rate_limited', message });
    this.#replyError(client, requestId, { code: 'rate_limited', message, retryAfterMs });
    return false;
  }

  #agentCommandRefused(client: Client, requestId: unknown, error: unknown): void {
    if (error instanceof OfficeCommandError) {
      this.#replyError(client, requestId, {
        code: error.reason === 'target' ? 'not_found' : 'invalid_payload',
        message: error.message,
      });
      return;
    }
    logger.error('[office] command write by an agent failed', error);
    this.#replyError(client, requestId, { code: 'unavailable', message: 'The command could not be written.' });
  }

  async #onAgentCommandList(client: Client, payload: AgentCommandListPayload): Promise<void> {
    const session = this.#agentCommandSession(client, payload);
    if (!session) return;
    audit(session.identity.id, 'command.command_list', {});
    markSeen(session.identity.id);
    const actor = await this.#actorForUser(session.identity.ownerUserId);
    await this.#refreshChannels();
    const result: CommandListResult = {
      commands: this.#commands.map((command) => this.#agentCommandRef(command, actor)),
    };
    this.#reply(client, payload?.requestId, result);
  }

  async #onAgentCommandGet(client: Client, payload: AgentCommandGetPayload): Promise<void> {
    const session = this.#agentCommandSession(client, payload);
    if (!session) return;
    audit(session.identity.id, 'command.command_get', { name: String(payload?.name ?? '') });
    markSeen(session.identity.id);
    const command = await this.#agentCommandNamed(client, payload?.name, payload?.requestId);
    if (!command) return;
    const actor = await this.#actorForUser(session.identity.ownerUserId);
    this.#reply(client, payload?.requestId, { command: this.#agentCommandRef(command, actor) } satisfies CommandGetResult);
  }

  /**
   * An agent makes a command as its owner: it may where its owner may, and
   * the row records both. The name rules are the database's, as for a
   * person, and come back as a sentence the agent can say.
   */
  async #onAgentCommandCreate(client: Client, payload: AgentCommandCreatePayload): Promise<void> {
    const session = this.#agentCommandSession(client, payload);
    if (!session) return;
    markSeen(session.identity.id);
    if (!this.#agentCommandPaced(client, session, payload?.requestId)) return;
    const actor = await this.#actorForUser(session.identity.ownerUserId);
    if (!mayCreateOfficeCommands(actor)) {
      this.#replyError(client, payload?.requestId, {
        code: 'unauthorised',
        message: 'Your owner is not a member of this office, so you cannot make commands for it.',
      });
      return;
    }
    const target = await this.#agentCommandTarget(client, session, payload?.defaultTarget, payload?.requestId);
    if (target === undefined) return;
    try {
      const made = await createOfficeCommand(getDb(), {
        workspaceId: this.#workspaceId,
        name: String(payload?.name ?? ''),
        summary: typeof payload?.summary === 'string' ? payload.summary : undefined,
        argumentHint: typeof payload?.argumentHint === 'string' ? payload.argumentHint : undefined,
        instructions: typeof payload?.instructions === 'string' ? payload.instructions : undefined,
        defaultTarget: target,
        createdBy: session.identity.ownerUserId,
        writtenByAgentId: session.identity.id,
      });
      audit(session.identity.id, 'command.command_create', { name: made.name, defaultTarget: made.defaultTarget?.name ?? null });
      await this.#refreshChannels();
      this.#reply(client, payload?.requestId, { command: this.#agentCommandRef(made, actor) } satisfies CommandWriteResult);
    } catch (error: unknown) {
      this.#agentCommandRefused(client, payload?.requestId, error);
    }
  }

  /** Change a command its owner may change. The agent becomes its "via". */
  async #onAgentCommandUpdate(client: Client, payload: AgentCommandUpdatePayload): Promise<void> {
    const session = this.#agentCommandSession(client, payload);
    if (!session) return;
    markSeen(session.identity.id);
    if (!this.#agentCommandPaced(client, session, payload?.requestId)) return;
    const command = await this.#agentCommandNamed(client, payload?.name, payload?.requestId);
    if (!command) return;
    const actor = await this.#actorForUser(session.identity.ownerUserId);
    if (!mayEditOfficeCommand(actor, command)) {
      this.#replyError(client, payload?.requestId, {
        code: 'unauthorised',
        message: `!${command.name} was made by ${command.createdByName || 'somebody else'}; only they, or an office admin, change it. Say what you would have changed instead.`,
      });
      return;
    }
    const target =
      'defaultTarget' in (payload ?? {})
        ? await this.#agentCommandTarget(client, session, payload.defaultTarget, payload.requestId)
        : null;
    if (target === undefined) return;
    const patch = {
      ...(typeof payload?.newName === 'string' ? { name: payload.newName } : {}),
      ...(typeof payload?.summary === 'string' ? { summary: payload.summary } : {}),
      ...(typeof payload?.argumentHint === 'string' ? { argumentHint: payload.argumentHint } : {}),
      ...(typeof payload?.instructions === 'string' ? { instructions: payload.instructions } : {}),
      ...('defaultTarget' in (payload ?? {}) ? { defaultTarget: target } : {}),
    };
    if (Object.keys(patch).length === 0) {
      this.#replyError(client, payload?.requestId, { code: 'invalid_payload', message: `command_update !${command.name}: say what changes.` });
      return;
    }
    try {
      await updateOfficeCommand(getDb(), {
        workspaceId: this.#workspaceId,
        commandId: command.id,
        ...patch,
        writtenBy: { userId: session.identity.ownerUserId, agentId: session.identity.id },
      });
      audit(session.identity.id, 'command.command_update', { name: command.name, fields: Object.keys(patch) });
      await this.#refreshChannels();
      const after = this.#commands.find((candidate) => candidate.id === command.id) ?? command;
      this.#reply(client, payload?.requestId, { command: this.#agentCommandRef(after, actor) } satisfies CommandWriteResult);
    } catch (error: unknown) {
      this.#agentCommandRefused(client, payload?.requestId, error);
    }
  }

  async #onAgentMemoryGet(client: Client, payload: AgentMemoryGetPayload): Promise<void> {
    const session = this.#agentSession(client);
    if (!session) return;

    const slug = String(payload?.slug ?? '');
    audit(session.identity.id, 'command.memory_get', { slug });
    markSeen(session.identity.id);

    try {
      const row = await getAgentMemory(getDb(), session.identity.id, this.#workspaceId, slug);
      const result: MemoryGetResult = {
        slug,
        content: row?.content ?? '',
        updatedAt: row?.updatedAt ?? null,
        bytes: Buffer.byteLength(row?.content ?? '', 'utf8'),
        limitBytes: memoryLimitFor(slug),
        // The hash of nothing for an unwritten slug, so "write only if still
        // absent" is a thing a harness can ask for.
        hash: row?.hash ?? memoryHash(''),
      };
      this.#reply(client, payload?.requestId, result);
    } catch (error: unknown) {
      this.#replyError(client, payload?.requestId, this.#memoryError(error));
    }
  }

  async #onAgentMemorySet(client: Client, payload: AgentMemorySetPayload): Promise<void> {
    const session = this.#agentSession(client);
    if (!session) return;

    const slug = String(payload?.slug ?? '');
    const content = String(payload?.content ?? '');
    const expectedHash =
      typeof payload?.expectedHash === 'string' && payload.expectedHash.length > 0
        ? payload.expectedHash
        : undefined;
    audit(session.identity.id, 'command.memory_set', {
      slug,
      bytes: Buffer.byteLength(content, 'utf8'),
      ...(expectedHash !== undefined ? { expectedHash } : {}),
    });
    markSeen(session.identity.id);

    try {
      const written = await setAgentMemory(
        getDb(),
        session.identity.id,
        slug,
        content,
        expectedHash,
      );
      audit(session.identity.id, 'effect.memory_written', written);
      const result: MemorySetResult = { ...written, limitBytes: memoryLimitFor(slug) };
      this.#reply(client, payload?.requestId, result);
    } catch (error: unknown) {
      const failure = this.#memoryError(error);
      audit(session.identity.id, 'command.rejected', { command: 'memory_set', slug, ...failure });
      this.#replyError(client, payload?.requestId, failure);
    }
  }

  #memoryError(error: unknown): AgentErrorPayload {
    if (error instanceof MemoryLimitError) {
      return { code: 'too_large', message: error.message };
    }
    if (error instanceof MemoryConflictError) {
      return { code: 'conflict', message: error.message };
    }
    if (error instanceof MemorySlugError) {
      return { code: 'invalid_payload', message: error.message };
    }
    logger.error('[agent] memory operation failed', error);
    return { code: 'invalid_payload', message: 'Memory operation failed.' };
  }

  // --- outbound to agents --------------------------------------------------

  #occupantsAround(sessionId: string): AgentOccupant[] {
    const self = this.state.players.get(sessionId);
    if (!self) return [];

    const occupants: AgentOccupant[] = [];
    for (const [otherId, other] of this.state.players) {
      if (otherId === sessionId) continue;
      const tile = this.#tileOf(other);
      occupants.push({
        sessionId: otherId,
        userId: other.userId,
        name: other.name,
        kind: other.kind,
        status: other.status,
        distance: round(this.#tileDistance(self, other)),
        zoneId: zoneAt(this.#map, tile.x, tile.y)?.id ?? null,
      });
    }
    occupants.sort((a, b) => a.distance - b.distance);
    return occupants;
  }

  #sendRoster(sessionId: string): void {
    const client = this.clients.getById(sessionId);
    const player = this.state.players.get(sessionId);
    if (!client || !player) return;

    const tile = this.#tileOf(player);
    const zone: MapZone | null = zoneAt(this.#map, tile.x, tile.y);
    const event: AgentRosterEvent = {
      zone: zone ? { id: zone.id, label: zone.label, kind: zone.kind } : null,
      occupants: this.#occupantsAround(sessionId),
      at: Date.now(),
    };
    client.send(AgentServerMessage.Roster, event);
  }

  #broadcastRosterToAgents(): void {
    for (const sessionId of this.#agents.keys()) this.#sendRoster(sessionId);
  }

  #sendHeartbeats(): void {
    for (const sessionId of this.#agents.keys()) {
      const client = this.clients.getById(sessionId);
      const player = this.state.players.get(sessionId);
      if (!client || !player) continue;
      client.send(AgentServerMessage.Heartbeat, {
        serverTime: Date.now(),
        tile: this.#tileOf(player),
        moving: player.moving,
      });
    }
  }

  /**
   * Kick agents whose keys were revoked. Revocation happens in the web app,
   * which in development is a different process — so this polls rather than
   * listens, and an agent goes within AGENT_REVOCATION_POLL_MS rather than
   * instantly. The audit log records the kick, not just the revocation.
   */
  async #kickRevokedAgents(): Promise<void> {
    if (this.#agents.size === 0) return;

    const byAgentId = new Map<string, string>();
    for (const [sessionId, identity] of this.#agents) byAgentId.set(identity.id, sessionId);

    const revoked = await findRevoked([...byAgentId.keys()]);
    for (const agentId of revoked) {
      const sessionId = byAgentId.get(agentId);
      if (!sessionId) continue;

      audit(agentId, 'session.revoked', { sessionId, reason: 'key revoked' });
      logger.info(`[office] kicking revoked agent ${agentId} (${sessionId})`);

      const client = this.clients.getById(sessionId);
      client?.send(AgentServerMessage.Error, {
        code: 'missing_scope',
        message: 'This agent key has been revoked.',
      } satisfies AgentErrorPayload);
      // Consented close: no reconnection window for a revoked key.
      client?.leave(4000);
      this.#removePlayer(sessionId);
    }

    if (revoked.size > 0) this.#broadcastRosterToAgents();
  }

  #denyAgent(
    client: Client,
    session: AgentSession,
    code: AgentErrorPayload['code'],
    message: string,
    retryAfterMs?: number,
  ): void {
    audit(session.identity.id, 'command.rejected', { code, message });
    const payload: AgentErrorPayload = { code, message };
    if (retryAfterMs !== undefined) payload.retryAfterMs = Math.ceil(retryAfterMs);
    client.send(AgentServerMessage.Error, payload);
  }

  #reply(client: Client, requestId: unknown, data: unknown): void {
    if (typeof requestId !== 'string' || requestId.length === 0) return;
    client.send(AgentServerMessage.Result, {
      requestId,
      ok: true,
      data,
    } satisfies AgentResultPayload);
  }

  #replyError(client: Client, requestId: unknown, error: AgentErrorPayload): void {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      client.send(AgentServerMessage.Error, error);
      return;
    }
    client.send(AgentServerMessage.Result, {
      requestId,
      ok: false,
      error,
    } satisfies AgentResultPayload);
  }

  // --- idle life -----------------------------------------------------------

  /**
   * Something happened to or by this agent.
   *
   * Restarts its idle clock and, if it was wandering, dozing or stopped for
   * a chat, ends that at once: the walk is cancelled, the balloon comes
   * down, a partner is released. Cheap enough to call from every message
   * an agent sends or receives, which is exactly where it is called from.
   */
  #noteActivity(sessionId: string, forced = false): void {
    const record = this.#idle.get(sessionId);
    if (!record) return;
    // The office asked for a line; the status flips, the say and the emote
    // that answering takes are the exchange, not an interruption of it. A
    // person speaking to it is (`forced`), and ends the exchange.
    if (!forced && record.talk?.banter) return;
    touch(record, Date.now());
    if (record.phase !== 'active') this.#endIdle(sessionId, record);
  }

  #endIdle(sessionId: string, record: IdleRecord): void {
    const talk = record.talk;
    wake(record);

    const sim = this.#sims.get(sessionId);
    if (sim?.idleWalk) {
      sim.path = [];
      sim.idleWalk = false;
    }
    const player = this.state.players.get(sessionId);
    if (player) {
      if (player.idle) player.idle = false;
      if (player.moving && sim?.path.length === 0) player.moving = false;
    }
    this.#dropIdleBalloon(sessionId, record);

    if (talk) this.#endTalkWith(talk.partner, sessionId);
  }

  /** Take down the balloon idle life put up — and only that one. */
  #dropIdleBalloon(sessionId: string, record: IdleRecord): void {
    const player = this.state.players.get(sessionId);
    if (player && record.balloon.length > 0 && player.emote === record.balloon) {
      player.emote = '';
      player.emoteUntil = 0;
    }
    record.balloon = '';
  }

  #idleBalloon(sessionId: string, record: IdleRecord, emote: string, ttlMs: number): void {
    const session = this.#sims.get(sessionId)?.agent;
    if (!session) return;
    // Not `chosen`: the agent did not ask, so there is nothing to log.
    this.#applyEmote(sessionId, session, { emote, ttlMs, chosen: false });
    record.balloon = emote;
  }

  /** `partner` was talking with `leaving`; let them go on with their idling. */
  #endTalkWith(partner: string, leaving: string): void {
    const record = this.#idle.get(partner);
    if (!record?.talk || record.talk.partner !== leaving) return;
    record.talk = null;
    this.#dropIdleBalloon(partner, record);
    // Soon, not now: they drift apart rather than turning on their heel.
    record.nextDecisionAt = Date.now() + between(Math.random, 2_000, 6_000);
  }

  /**
   * Once a second: every agent is drawn the way its state calls for.
   *
   * The rules live in `seating.ts`. A change to `work` or `sit` sends the
   * agent to its desk (giving it one if it has none) and seats it on
   * arrival; a change to `stand` gets it up, a step off the chair, and
   * leaves the rest to idle life. Between changes nothing moves: an agent
   * its model walked somewhere mid-turn is standing there on purpose. A
   * seated agent that is moved by anything is standing again, whatever its
   * state says, because a body cannot sit on a tile it is not on.
   */
  #stepSeating(now: number): void {
    for (const [sessionId, sim] of this.#sims) {
      const player = this.state.players.get(sessionId);
      if (!sim.agent || !player || sim.away) continue;

      const agentId = sim.agent.identity.id;
      const seat = this.#seatOf(agentId);
      const atSeat = seat !== null && this.#onTile(player, seat.tile) && sim.path.length === 0;
      if (seated(player.pose) && !atSeat) player.pose = 'stand';

      const wanted = wantedPose({ busy: !idleCapable(player.status), onTask: player.taskBranch.length > 0 });
      const plan = this.#seats.plan(
        { agentId, wanted, arranged: sim.arranged, atSeat, canMove: hasScope(sim.agent.identity, 'move') },
        now,
      );
      switch (plan.kind) {
        case 'wait':
          // Every desk is held by somebody here. Nothing arranged, nothing
          // recorded: the next sweep asks again, and the first desk a leaver
          // frees is this one's.
          break;
        case 'stay':
          if (!seated(wanted)) sim.arranged = 'stand';
          // Still wanted at the desk and already there: keep the drawing honest.
          else if (atSeat && player.pose !== wanted) player.pose = wanted;
          break;
        case 'rise': {
          // Up from the chair, so it is not left standing on one: a chair is
          // nobody's floor, and idle life could never wander it off from there.
          sim.arranged = 'stand';
          const chair = this.#seatNamed(plan.seat);
          const beside = chair && tileBeside(this.#map, chair.tile.x, chair.tile.y);
          if (beside && this.walkTo(sessionId, beside.x, beside.y)) sim.idleWalk = true;
          break;
        }
        case 'settle':
          sim.arranged = plan.pose;
          this.#settle(sessionId, sim, player);
          break;
        case 'walk': {
          const chair = this.#seatNamed(plan.seat);
          // Arranged only once the walk is under way: a desk it cannot reach
          // from here is asked about again, not written off.
          if (chair && this.walkTo(sessionId, chair.tile.x, chair.tile.y)) {
            sim.arranged = plan.pose;
            sim.seatWalk = true;
          }
          break;
        }
      }
    }
  }

  /** On the chair: face the desk and take the pose the state calls for. */
  #settle(sessionId: string, sim: PlayerSim, player: OfficePlayer): void {
    const seat = sim.agent ? this.#seatOf(sim.agent.identity.id) : null;
    const wanted = sim.arranged ?? 'stand';
    if (!seat || !this.#onTile(player, seat.tile) || !seated(wanted)) return;
    if (player.seat !== seat.id) player.seat = seat.id;
    if (player.dir !== seat.facing) player.dir = seat.facing;
    if (player.pose !== wanted) player.pose = wanted;
    // Sitting down is something happening: it is not idle, whatever the clock says.
    this.#noteActivity(sessionId);
  }

  #onTile(player: OfficePlayer, tile: TilePoint): boolean {
    const at = this.#tileOf(player);
    return at.x === tile.x && at.y === tile.y;
  }

  /**
   * Once a second: every agent with nothing to do gets a look.
   *
   * The rules live in `idle-life.ts`; this applies what they decide to the
   * room. Turned off in settings, it only ever ends idle lives, so a switch
   * flipped mid-wander stops the wander.
   */
  #stepIdleLife(now: number): void {
    if (!this.#settings.idleLife) {
      for (const [sessionId, record] of this.#idle) {
        if (record.phase !== 'active') this.#endIdle(sessionId, record);
      }
      return;
    }

    /** Idle, awake, unengaged and able to walk, by home zone — the chat pool. */
    const free = new Map<string, string[]>();

    for (const [sessionId, record] of this.#idle) {
      const sim = this.#sims.get(sessionId);
      const player = this.state.players.get(sessionId);
      if (!sim?.agent || !player || sim.away) continue;

      const tile = this.#tileOf(player);
      // Thinking of a line is the banter, not work that ends it. A desk to
      // be at is, so an agent on a task sits rather than wanders.
      const busy = record.talk?.banter ? false : !idleCapable(player.status) || seated(sim.arranged ?? 'stand');
      const action = stepIdle(record, { now, busy, zoneId: zoneIdAt(this.#map, tile) }, Math.random);

      switch (action.kind) {
        case 'wake':
          this.#endIdle(sessionId, record);
          continue;
        case 'sleep':
          if (sim.idleWalk) {
            sim.path = [];
            sim.idleWalk = false;
          }
          if (!player.idle) player.idle = true;
          this.#idleBalloon(sessionId, record, 'sleep', 0);
          continue;
        case 'wander': {
          if (sim.path.length === 0 && hasScope(sim.agent.identity, 'move')) {
            const target = wanderTarget(this.#map, tile, record.homeZone, Math.random);
            if (target && this.walkTo(sessionId, target.x, target.y)) sim.idleWalk = true;
          }
          break;
        }
        case 'none':
          break;
      }

      if (record.phase !== 'wandering') continue;
      if (!player.idle) player.idle = true;

      if (record.talk) {
        this.#stepTalk(sessionId, record, now);
      } else if (sim.path.length === 0 && hasScope(sim.agent.identity, 'move')) {
        const pool = free.get(record.homeZone) ?? [];
        pool.push(sessionId);
        free.set(record.homeZone, pool);
      }
    }

    for (const [a, b] of pickSmallTalk(free, this.#nextTalkAt, now, Math.random)) {
      this.#startTalk(a, b);
    }
  }

  /** `a` walks over to stand beside `b`. */
  #startTalk(a: string, b: string): void {
    const recordA = this.#idle.get(a);
    const recordB = this.#idle.get(b);
    const playerB = this.state.players.get(b);
    const simA = this.#sims.get(a);
    if (!recordA || !recordB || !playerB || !simA) return;

    const taken = new Set<string>();
    for (const [, player] of this.state.players) {
      const tile = this.#tileOf(player);
      taken.add(`${tile.x},${tile.y}`);
    }
    const target = this.#tileOf(playerB);
    const beside = tileBeside(this.#map, target.x, target.y, taken, 2);
    if (!beside) return;
    // Beside them, but still at home: a chat is not a reason to leave the zone.
    if (zoneIdAt(this.#map, beside) !== recordA.homeZone) return;
    if (!this.walkTo(a, beside.x, beside.y)) return;
    simA.idleWalk = true;

    recordA.talk = { partner: b, initiator: true, startedAt: 0, answered: false, banter: null };
    recordB.talk = { partner: a, initiator: false, startedAt: 0, answered: false, banter: null };
  }

  /**
   * A small talk, second by second, driven by the one who walked over: face
   * each other once there, a balloon, an answering balloon, and after a
   * moment both go back to their own idling.
   */
  #stepTalk(sessionId: string, record: IdleRecord, now: number): void {
    const talk = record.talk;
    if (!talk) return;
    const partner = this.#idle.get(talk.partner);
    const player = this.state.players.get(sessionId);
    const other = this.state.players.get(talk.partner);
    if (!partner?.talk || partner.talk.partner !== sessionId || !player || !other) {
      record.talk = null;
      this.#dropIdleBalloon(sessionId, record);
      return;
    }
    if (!talk.initiator) return;

    const sim = this.#sims.get(sessionId);
    if (talk.startedAt === 0) {
      if (sim && sim.path.length > 0) return; // still walking over
      // Arrived — or the walk was lost. Only a real arrival starts a chat.
      if (this.#tileDistance(player, other) > 2) {
        this.#endTalkWith(talk.partner, sessionId);
        this.#endTalkWith(sessionId, talk.partner);
        return;
      }
      this.#faceEachOther(player, other);
      talk.startedAt = now;
      partner.talk.startedAt = now;
      // With words, when the office allows it; with balloons otherwise.
      if (this.#tryBanter(sessionId, record, talk.partner, partner, now)) return;
      this.#idleBalloon(sessionId, record, 'dots', SMALL_TALK_MS);
      return;
    }

    if (talk.banter) {
      this.#stepBanter(sessionId, talk.partner, talk.banter, now);
      return;
    }

    if (!partner.talk.answered && now >= talk.startedAt + SMALL_TALK_REPLY_MS) {
      partner.talk.answered = true;
      const answer = Math.random() < 0.5 ? 'dots' : 'laugh';
      this.#idleBalloon(talk.partner, partner, answer, SMALL_TALK_MS - SMALL_TALK_REPLY_MS);
    }

    if (now >= talk.startedAt + SMALL_TALK_MS) {
      this.#endTalkWith(talk.partner, sessionId);
      this.#endTalkWith(sessionId, talk.partner);
    }
  }

  // --- banter ---------------------------------------------------------------

  /**
   * Turn this small talk into one where the agents speak, if the office
   * allows it right now. Spends the budget and asks the first for a line.
   */
  #tryBanter(a: string, recordA: IdleRecord, b: string, recordB: IdleRecord, now: number): boolean {
    const simA = this.#sims.get(a);
    const simB = this.#sims.get(b);
    const playerB = this.state.players.get(b);
    const client = this.clients.getById(a);
    if (!simA?.agent || !simB?.agent || !playerB || !client) return false;
    if (!recordA.talk || !recordB.talk) return false;
    if (!hasScope(simA.agent.identity, 'chat') || !hasScope(simB.agent.identity, 'chat')) {
      return false;
    }

    const idA = simA.agent.identity.id;
    const idB = simB.agent.identity.id;
    const allowed = mayBanter(
      {
        setting: this.#settings.banter,
        humansPresent: this.#humansPresent(),
        a: idA,
        b: idB,
        now,
      },
      this.#banter,
    );
    if (!allowed) return false;

    noteBanter(this.#banter, idA, idB, now);
    recordA.talk.banter = { stage: 'asked_a', since: now };
    recordB.talk.banter = { stage: 'listening', since: now };
    this.#sendBanter(client, { id: idB, name: playerB.name }, null, now);
    audit(idA, 'effect.banter', { with: idB });
    return true;
  }

  #sendBanter(
    client: Client,
    partner: { id: string; name: string },
    line: string | null,
    now: number,
  ): void {
    const player = this.state.players.get(client.sessionId);
    const tile = player ? this.#tileOf(player) : null;
    client.send(AgentServerMessage.Banter, {
      partner,
      line,
      zoneId: tile ? (zoneAt(this.#map, tile.x, tile.y)?.id ?? null) : null,
      expiresAt: now + BANTER_STAGE_MS,
    } satisfies AgentBanterEvent);
  }

  /**
   * A line said aloud by somebody the office asked for one. The first line
   * is passed to the partner as their invitation; the partner's line ends
   * the exchange after a moment. Any other line is just speech.
   */
  #onBanterLine(sessionId: string, speaker: OfficePlayer, text: string, now: number): void {
    const talk = this.#idle.get(sessionId)?.talk;
    if (!talk?.banter) return;

    if (talk.initiator) {
      if (talk.banter.stage !== 'asked_a') return;
      const partnerClient = this.clients.getById(talk.partner);
      const me = this.#sims.get(sessionId)?.agent?.identity.id;
      if (!partnerClient || !me) {
        this.#endTalkWith(talk.partner, sessionId);
        this.#endTalkWith(sessionId, talk.partner);
        return;
      }
      talk.banter = { stage: 'asked_b', since: now };
      this.#sendBanter(partnerClient, { id: me, name: speaker.name }, text, now);
      return;
    }

    const initiator = this.#idle.get(talk.partner)?.talk?.banter;
    if (initiator?.stage === 'asked_b') {
      initiator.stage = 'done';
      initiator.since = now;
    }
  }

  /**
   * The initiator's clock on the exchange: a deadline per stage, then apart.
   *
   * Reached only from the initiator's side of `#stepTalk` — the partner
   * returns before it — and `banterOver` refuses to time a `listening`
   * stage besides, so a partner asked late is never cut off by a clock
   * that started before it was asked.
   */
  #stepBanter(a: string, b: string, banter: Banter, now: number): void {
    if (!banterOver(banter, now)) return;
    // The moment passed, or was had. Either way, back to idling.
    this.#endTalkWith(b, a);
    this.#endTalkWith(a, b);
  }

  /** Is anybody here to overhear? Nobody performs to an empty room. */
  #humansPresent(): boolean {
    for (const [sessionId, player] of this.state.players) {
      if (player.kind === 'human' && !this.#sims.get(sessionId)?.away) return true;
    }
    return false;
  }

  #faceEachOther(a: OfficePlayer, b: OfficePlayer): void {
    const from = this.#tileOf(a);
    const to = this.#tileOf(b);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const towards: Direction =
      Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    const back: Direction =
      towards === 'right' ? 'left' : towards === 'left' ? 'right' : towards === 'down' ? 'up' : 'down';
    if (a.dir !== towards) a.dir = towards;
    if (b.dir !== back) b.dir = back;
  }

  // --- helpers -------------------------------------------------------------

  /**
   * A free tile inside the agent_area zone, or the map's agent spawn.
   *
   * Agents are spaced out rather than packed in. Adjacent avatars overlap their
   * nameplates into an unreadable smear, and a nameplate you cannot read is a
   * legible worker you cannot identify — which is the entire point of them.
   */
  #agentSpawn(): TilePoint {
    const bay = this.#map.zones.find((zone) => zone.kind === 'agent_area');
    if (bay) {
      const occupied: TilePoint[] = [];
      for (const [, player] of this.state.players) occupied.push(this.#tileOf(player));

      const clearOf = (candidate: TilePoint, gap: number): boolean =>
        occupied.every(
          (tile) =>
            Math.max(Math.abs(tile.x - candidate.x), Math.abs(tile.y - candidate.y)) >= gap,
        );

      // Try for elbow room first, then settle for anywhere free.
      for (const gap of [AGENT_SPAWN_GAP_TILES, 1]) {
        for (let y = bay.bounds.y; y < bay.bounds.y + bay.bounds.height; y += 1) {
          for (let x = bay.bounds.x; x < bay.bounds.x + bay.bounds.width; x += 1) {
            const candidate = { x, y };
            if (!clearOf(candidate, gap)) continue;
            const free = nearestWalkable(this.#map, candidate, 0);
            if (free) return free;
          }
        }
      }
    }

    const spawn = spawnFor(this.#map, 'agent');
    return { x: spawn.x, y: spawn.y };
  }

  #earshotCount(speaker: OfficePlayer): number {
    let count = 0;
    for (const [, listener] of this.state.players) {
      if (listener === speaker) continue;
      if (this.#tileDistance(speaker, listener) <= this.#settings.chatRadiusTiles) count += 1;
    }
    return count;
  }

  /**
   * The person holding a session, as the voice relay may know them — or
   * null. Null for an agent is the whole "agents have no voice" rule from
   * the door's side; `EarshotTracker` is the same rule from the graph's.
   */
  #voiceHuman(sessionId: string): { name: string; userId: string } | null {
    const player = this.state.players.get(sessionId);
    const sim = this.#sims.get(sessionId);
    if (!player || !sim || sim.away || sim.agent || this.#agents.has(sessionId)) return null;
    return { name: player.name, userId: player.userId };
  }

  #sweepEarshot(): void {
    const players: EarshotPlayer[] = [];
    for (const [sessionId, player] of this.state.players) {
      // The same question the door asks, so the graph and the door can never
      // disagree about who is a person: away seats are out, agents are agents.
      if (!this.#sims.has(sessionId)) continue;
      players.push({
        id: sessionId,
        kind: this.#voiceHuman(sessionId) ? 'human' : 'agent',
        x: player.x / this.#map.tileSize,
        y: player.y / this.#map.tileSize,
      });
    }
    // Voice carries as far as your voice would: the chat radius, literally.
    const deltas = this.#earshot.update(players, this.#settings.chatRadiusTiles);
    if (deltas.length > 0) voiceRelay.updatePeers(this.roomId, deltas);
  }

  #removePlayer(sessionId: string): void {
    // Read before the player goes: the cursors are keyed by who they were.
    const leaving = this.state.players.get(sessionId)?.userId;
    voiceRelay.sessionLeft(this.roomId, sessionId);
    const ended = this.#earshot.remove(sessionId);
    if (ended.length > 0) voiceRelay.updatePeers(this.roomId, ended);
    // Whoever it was chatting with is released before the record goes.
    const record = this.#idle.get(sessionId);
    if (record?.talk) this.#endTalkWith(record.talk.partner, sessionId);
    this.#idle.delete(sessionId);
    const agentLeaving = this.#agents.get(sessionId);
    this.#roles.delete(sessionId);
    this.state.players.delete(sessionId);
    this.#sims.delete(sessionId);
    this.#agents.delete(sessionId);
    // Its desk is up for taking only once its last session is gone. A fresh
    // connection can arrive while the old socket is still in its reconnection
    // grace, and that old session timing out must not put a present agent's
    // chair under somebody else — with the agent still standing on it, on a
    // map that no longer opens that tile to it.
    if (agentLeaving && !this.#hasAgentSession(agentLeaving.id)) {
      this.#seats.left(agentLeaving.id, Date.now());
    }
    this.#credentials.delete(sessionId);
    this.#chatLimiter.forget(sessionId);
    this.#readLimiter.forget(sessionId);
    this.#channelsSent.forget(sessionId);
    this.#mcpSent.delete(sessionId);
    // Their cursors stay while any session of theirs does — two tabs are one
    // reader — and go with the last one. The database keeps the durable copy.
    if (leaving !== undefined && !this.#hasSessionFor(leaving)) {
      this.#readCursors.delete(leaving);
    }
    this.#followed.delete(sessionId);
    this.#wakeHops.forget(sessionId);
    const later = this.#emoteLater.get(sessionId);
    if (later) {
      clearTimeout(later.timer);
      this.#emoteLater.delete(sessionId);
    }
    // Nothing about what they said is forgotten. It used to be: leaving the
    // room erased your lines from everybody else's history.
  }

  #tileOf(player: OfficePlayer): TilePoint {
    return {
      x: toTile(player.x, this.#map.tileSize),
      y: toTile(player.y, this.#map.tileSize),
    };
  }

  #tileDistance(a: OfficePlayer, b: OfficePlayer): number {
    return Math.hypot(a.x - b.x, a.y - b.y) / this.#map.tileSize;
  }

  #sendError(
    client: Client,
    code: ErrorPayload['code'],
    message: string,
    requestId?: string,
  ): void {
    client.send(ServerMessage.Error, {
      code,
      message,
      ...(requestId ? { requestId } : {}),
    } satisfies ErrorPayload);
  }
}

function clampAxis(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(-1, Math.min(1, parsed));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
