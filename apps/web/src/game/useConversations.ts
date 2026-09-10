'use client';

import {
  FLOOR_ZONE_ID,
  type ChannelRef,
  type ChatBroadcastPayload,
  type MapZone,
} from '@quintal/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { gameBridge } from './bridge';
import { NEARBY, channelKey, parseKey, zoneKey, type ConversationKey } from './conversationKey';
import type { OfficeSession } from './createGame';
import { resolveJoin } from './ui/join';
import { parseSlashCommand } from './ui/slash';
import {
  EMPTY_READ_STATE,
  caughtUp,
  heard,
  loadLastRead,
  read,
  saveLastRead,
  type Listener,
  type ReadState,
  type Unread,
} from './unread';

/**
 * Every conversation this client can read, and which one it is looking at.
 *
 * One store, two chromes. The corner box and the overlay are views on the
 * same transcripts — the corner box is the `nearby` one, plus whatever
 * channel tab is up — so a line heard in one is a line heard in the other,
 * and history loaded for a channel in the overlay is already there when the
 * corner box switches to it.
 *
 * Keys are strings so a Record can hold them — see `conversationKey.ts`,
 * re-exported here so the chromes have one import.
 */

export { NEARBY, channelKey, parseKey, zoneKey, type ConversationKey };

export interface Transcript {
  messages: ChatBroadcastPayload[];
  /** The office has more before the first line here. */
  hasMore: boolean;
  /** A page has been asked for and has come back at least once. */
  loaded: boolean;
  /** A page is on its way. */
  loading: boolean;
}

const EMPTY: Transcript = { messages: [], hasMore: false, loaded: false, loading: false };

/** Lines kept per transcript. Paging back grows towards this; live lines roll it. */
const KEEP = 500;

const identity = (m: ChatBroadcastPayload): string => `${m.sentAt} ${m.fromName} ${m.text}`;

/**
 * What was said before we were listening goes in front of what we have heard
 * since. A line can be in both — said after we joined, before the page came
 * back — and a message read from history carries a different `from` than
 * the same message heard live, so identity is the words.
 */
function prepend(
  current: Transcript,
  earlier: ChatBroadcastPayload[],
  hasMore: boolean,
): Transcript {
  const seen = new Set(current.messages.map(identity));
  const unseen = earlier.filter((m) => !seen.has(identity(m)));
  return {
    messages: [...unseen, ...current.messages].slice(-KEEP),
    hasMore,
    loaded: true,
    loading: false,
  };
}

function append(current: Transcript, line: ChatBroadcastPayload): Transcript {
  return { ...current, messages: [...current.messages, line].slice(-KEEP) };
}

export interface Conversations {
  transcripts: Record<ConversationKey, Transcript>;
  /** Channels and DMs we are in. */
  channels: ChannelRef[];
  /** Channels we could join. */
  available: ChannelRef[];
  /** Every zone on the map, once the map has loaded. */
  zones: MapZone[];
  /** The zone we stand in. */
  myZone: string;
  active: ConversationKey;
  activeTranscript: Transcript;
  /** The ref for the active key when it is a channel or DM; null otherwise. */
  activeChannel: ChannelRef | null;
  select: (key: ConversationKey) => void;
  loadEarlier: (key: ConversationKey) => void;
  /** Send a line to the active conversation, or run a slash command. */
  send: (text: string) => void;
  openDm: (target: { memberId?: string; name?: string }) => void;
  joinChannel: (slug: string) => void;
  /** Something the person should be told — a refused command, mostly. */
  notice: string;
  /**
   * What is waiting in conversations not in view: lines since you last
   * looked, and whether one was for you. No entry means nothing is.
   */
  unread: Record<ConversationKey, Unread>;
}

export interface ConversationsView {
  /**
   * Whether the full panel is up. It decides which conversation is in view —
   * the panel's when open, the corner box's when not — and a line landing
   * in the one in view is read, not news.
   */
  overlayOpen: boolean;
}

export function useConversations(
  sessionRef: RefObject<OfficeSession | null>,
  view: ConversationsView,
): Conversations {
  const [transcripts, setTranscripts] = useState<Record<ConversationKey, Transcript>>({
    [NEARBY]: { ...EMPTY, loading: true },
  });
  const [channels, setChannels] = useState<ChannelRef[]>([]);
  const [available, setAvailable] = useState<ChannelRef[]>([]);
  const [zones, setZones] = useState<MapZone[]>([]);
  const [myZone, setMyZone] = useState<string>(FLOOR_ZONE_ID);
  const [active, setActive] = useState<ConversationKey>(NEARBY);
  const [notice, setNotice] = useState('');
  const [readState, setReadState] = useState<ReadState>(EMPTY_READ_STATE);
  const activeRef = useRef(active);
  /** Who I am, from the roster, so my own lines are never news to me. */
  const selfRef = useRef<{ sessionId: string | null; name: string }>({ sessionId: null, name: '' });
  const channelsRef = useRef(channels);
  const transcriptsRef = useRef(transcripts);
  /** Storage has been read; only then is it written, or a reload would wipe it. */
  const rememberedRef = useRef(false);
  /**
   * A channel `/join` asked for that we were not in yet. The office answers
   * a join with a fresh `channels` list rather than a receipt, so the switch
   * to the new tab happens when that list arrives with the slug in it.
   */
  const pendingJoinRef = useRef<string | null>(null);
  activeRef.current = active;
  channelsRef.current = channels;
  transcriptsRef.current = transcripts;

  // What is in view. The corner box only ever shows nearby or a channel; a
  // zone opened in the panel is in view only while the panel is.
  const visible = useMemo<ConversationKey[]>(() => {
    if (view.overlayOpen) return [active];
    const { channelId } = parseKey(active);
    return [channelId ? active : NEARBY];
  }, [active, view.overlayOpen]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const listenerFor = useCallback((key: ConversationKey): Listener => {
    const { channelId } = parseKey(key);
    return {
      selfSessionId: selfRef.current.sessionId,
      myName: selfRef.current.name,
      visible: visibleRef.current,
      isDm: channelsRef.current.some((channel) => channel.id === channelId && channel.kind === 'dm'),
    };
  }, []);

  /** A line has landed: read if in view, news otherwise. */
  const note = useCallback(
    (key: ConversationKey, line: ChatBroadcastPayload) => {
      setReadState((state) => heard(state, key, line, listenerFor(key), Date.now()));
    },
    [listenerFor],
  );

  // When you last looked, from the last visit. Read after mount rather than
  // in the initial state: the server renders this page too, with no storage
  // to read, and the first paint has to agree with it.
  useEffect(() => {
    const remembered = loadLastRead(window.localStorage);
    rememberedRef.current = true;
    setReadState((state) => ({
      ...state,
      lastReadAt: { ...remembered, ...state.lastReadAt },
    }));
  }, []);

  // Looking at a conversation reads it — as of now, or as of its newest line
  // if the line's clock is ahead of ours, so it stays read after a reload.
  useEffect(() => {
    setReadState((state) => {
      let next = state;
      for (const key of visible) {
        const newest = transcriptsRef.current[key]?.messages.at(-1)?.sentAt ?? 0;
        next = read(next, key, Math.max(Date.now(), newest));
      }
      return next;
    });
  }, [visible]);

  useEffect(() => {
    if (rememberedRef.current) saveLastRead(window.localStorage, readState.lastReadAt);
  }, [readState.lastReadAt]);

  const patch = useCallback((key: ConversationKey, fn: (current: Transcript) => Transcript) => {
    setTranscripts((prev) => ({ ...prev, [key]: fn(prev[key] ?? EMPTY) }));
  }, []);

  const load = useCallback(
    (key: ConversationKey, before?: number) => {
      const session = sessionRef.current;
      if (!session) return;
      patch(key, (current) => ({ ...current, loading: true }));
      session.loadHistory({ ...parseKey(key), ...(before ? { before } : {}) });
    },
    [patch, sessionRef],
  );

  useEffect(() => {
    const off = [
      gameBridge.on('ready', ({ zones: mapZones }) => setZones(mapZones)),
      gameBridge.on('zone', ({ zone }) => setMyZone(zone?.id ?? FLOOR_ZONE_ID)),
      gameBridge.on('roster', ({ players, selfSessionId }) => {
        const self = players.find((player) => player.isSelf);
        selfRef.current = { sessionId: selfSessionId, name: self?.name ?? '' };
      }),
      gameBridge.on('chat', (line) => {
        patch(NEARBY, (t) => append(t, line));
        note(NEARBY, line);
      }),
      gameBridge.on('zoneChat', (line) => {
        patch(zoneKey(line.zoneId), (t) => append(t, line));
        note(zoneKey(line.zoneId), line);
      }),
      gameBridge.on('channelChat', (line) => {
        patch(channelKey(line.channel.id), (t) => append(t, line));
        note(channelKey(line.channel.id), line);
      }),
      gameBridge.on('history', ({ zoneId, channelId, messages, hasMore }) => {
        const key = channelId ? channelKey(channelId) : zoneId ? zoneKey(zoneId) : NEARBY;
        patch(key, (t) => prepend(t, messages, hasMore));
      }),
      gameBridge.on('channels', ({ channels: mine, available: open }) => {
        setChannels(mine);
        setAvailable(open);
        // Anything said in them since you last looked is waiting.
        setReadState((state) => caughtUp(state, mine, visibleRef.current));
        // The channel `/join` just asked for: it is ours now, so go there.
        const wanted = pendingJoinRef.current;
        const arrived = wanted
          ? mine.find((channel) => channel.kind === 'channel' && channel.slug === wanted)
          : undefined;
        if (arrived) {
          pendingJoinRef.current = null;
          setActive(channelKey(arrived.id));
          return;
        }
        // A tab for a channel we were taken out of is a tab that can never
        // send again; fall back to nearby rather than leave it selected.
        const { channelId } = parseKey(activeRef.current);
        if (channelId && !mine.some((channel) => channel.id === channelId)) setActive(NEARBY);
      }),
      gameBridge.on('dmOpened', ({ channel }) => {
        setChannels((prev) => (prev.some((c) => c.id === channel.id) ? prev : [...prev, channel]));
        setActive(channelKey(channel.id));
      }),
      gameBridge.on('notice', ({ message }) => setNotice(message)),
    ];
    return () => {
      for (const unsubscribe of off) unsubscribe();
    };
  }, [patch, note]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Reading a zone from elsewhere is a subscription the office has to know
  // about; reading anything else is not. Tell it when the active key changes.
  useEffect(() => {
    const { zoneId } = parseKey(active);
    sessionRef.current?.followZone(zoneId ?? null);
    return () => sessionRef.current?.followZone(null);
  }, [active, sessionRef]);

  // First look at a transcript loads its most recent page, once.
  useEffect(() => {
    const current = transcripts[active];
    if (current === undefined || (!current.loaded && !current.loading)) load(active);
    // `transcripts` is deliberately not a dependency: this is about the first
    // look, and re-running on every line would ask again after each one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, load]);

  const select = useCallback((key: ConversationKey) => setActive(key), []);

  const loadEarlier = useCallback(
    (key: ConversationKey) => {
      const current = transcripts[key];
      if (!current || current.loading || !current.hasMore) return;
      const oldest = current.messages[0];
      if (oldest) load(key, oldest.sentAt);
    },
    [load, transcripts],
  );

  const openDm = useCallback(
    (target: { memberId?: string; name?: string }) => sessionRef.current?.openDm(target),
    [sessionRef],
  );
  const joinChannel = useCallback(
    (slug: string) => sessionRef.current?.joinChannel(slug),
    [sessionRef],
  );

  const send = useCallback(
    (text: string) => {
      const session = sessionRef.current;
      if (!session) return;

      const slash = parseSlashCommand(text);
      if (slash) {
        switch (slash.kind) {
          case 'msg':
            if (slash.name.length === 0) setNotice('Who? /msg name');
            else session.openDm({ name: slash.name });
            return;
          case 'join': {
            // "Take me there", whatever there is — see `resolveJoin`.
            const target = resolveJoin(slash.slug, channels, available);
            switch (target.kind) {
              case 'switch':
                setActive(channelKey(target.channel.id));
                return;
              case 'join':
                pendingJoinRef.current = target.slug;
                session.joinChannel(target.slug);
                return;
              case 'unknown':
                setNotice(`No #${target.slug} here. Type /join to see the channels.`);
                return;
              case 'pick':
                setNotice('Which channel? Type /join and pick one from the list.');
                return;
            }
            return;
          }
          case 'leave': {
            const { channelId } = parseKey(activeRef.current);
            const channel = channels.find((c) => c.id === channelId);
            if (!channel || channel.kind !== 'channel') {
              setNotice('Nothing to leave here.');
              return;
            }
            session.leaveChannel(channel.id);
            setActive(NEARBY);
            return;
          }
          case 'unknown':
            setNotice(`/${slash.name} is not a command. Try /msg, /join, /leave.`);
            return;
        }
      }

      const { zoneId, channelId } = parseKey(activeRef.current);
      if (channelId) {
        session.sayInChannel(channelId, text);
      } else if (zoneId && zoneId !== myZone) {
        // A zone's transcript is readable from anywhere; speaking in it is
        // not. Words are said where you stand.
        setNotice('Walk there to talk — you can read a zone from anywhere, not speak in it.');
      } else {
        session.say(text);
      }
    },
    [channels, myZone, sessionRef, available],
  );

  const activeTranscript = transcripts[active] ?? EMPTY;
  const { channelId: activeChannelId } = parseKey(active);
  const activeChannel = channels.find((channel) => channel.id === activeChannelId) ?? null;

  return {
    transcripts,
    channels,
    available,
    zones,
    myZone,
    active,
    activeTranscript,
    activeChannel,
    select,
    loadEarlier,
    send,
    openDm,
    joinChannel,
    notice,
    unread: readState.unread,
  };
}
