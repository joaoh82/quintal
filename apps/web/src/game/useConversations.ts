'use client';

import {
  FLOOR_ZONE_ID,
  type ChannelRef,
  type ChatBroadcastPayload,
  type MapZone,
} from '@quintal/shared';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { gameBridge } from './bridge';
import type { OfficeSession } from './createGame';
import { parseSlashCommand } from './ui/slash';

/**
 * Every conversation this client can read, and which one it is looking at.
 *
 * One store, two chromes. The corner box and the overlay are views on the
 * same transcripts — the corner box is the `nearby` one, plus whatever
 * channel tab is up — so a line heard in one is a line heard in the other,
 * and history loaded for a channel in the overlay is already there when the
 * corner box switches to it.
 *
 * Keys are strings so a Record can hold them: `nearby`, `zone:<id>`,
 * `channel:<id>` (DMs are channels here; the distinction is the ref's kind).
 */

export type ConversationKey = string;

export const NEARBY: ConversationKey = 'nearby';
export const zoneKey = (zoneId: string): ConversationKey => `zone:${zoneId}`;
export const channelKey = (channelId: string): ConversationKey => `channel:${channelId}`;

export function parseKey(key: ConversationKey): { zoneId?: string; channelId?: string } {
  if (key.startsWith('zone:')) return { zoneId: key.slice(5) };
  if (key.startsWith('channel:')) return { channelId: key.slice(8) };
  return {};
}

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
}

export function useConversations(sessionRef: RefObject<OfficeSession | null>): Conversations {
  const [transcripts, setTranscripts] = useState<Record<ConversationKey, Transcript>>({
    [NEARBY]: { ...EMPTY, loading: true },
  });
  const [channels, setChannels] = useState<ChannelRef[]>([]);
  const [available, setAvailable] = useState<ChannelRef[]>([]);
  const [zones, setZones] = useState<MapZone[]>([]);
  const [myZone, setMyZone] = useState<string>(FLOOR_ZONE_ID);
  const [active, setActive] = useState<ConversationKey>(NEARBY);
  const [notice, setNotice] = useState('');
  const activeRef = useRef(active);
  activeRef.current = active;

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
      gameBridge.on('chat', (line) => patch(NEARBY, (t) => append(t, line))),
      gameBridge.on('zoneChat', (line) => patch(zoneKey(line.zoneId), (t) => append(t, line))),
      gameBridge.on('channelChat', (line) =>
        patch(channelKey(line.channel.id), (t) => append(t, line)),
      ),
      gameBridge.on('history', ({ zoneId, channelId, messages, hasMore }) => {
        const key = channelId ? channelKey(channelId) : zoneId ? zoneKey(zoneId) : NEARBY;
        patch(key, (t) => prepend(t, messages, hasMore));
      }),
      gameBridge.on('channels', ({ channels: mine, available: open }) => {
        setChannels(mine);
        setAvailable(open);
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
  }, [patch]);

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
          case 'join':
            if (slash.slug.length === 0) setNotice('Which? /join channel');
            else session.joinChannel(slash.slug);
            return;
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
    [channels, myZone, sessionRef],
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
  };
}
