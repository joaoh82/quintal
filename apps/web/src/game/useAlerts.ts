'use client';

import type { RosterEntry } from '@quintal/shared';
import { useEffect, useRef } from 'react';

import { deliver } from '@/lib/alert-delivery';
import { getHost } from '@/lib/host';
import { getAlertPreferences } from '@/lib/preferences';

import {
  EMPTY_ALERT_LOG,
  admit,
  approvalAlert,
  doneAlert,
  lineAlert,
  waitingOnMe,
  type Alert,
  type Looking,
} from './alerts';
import { gameBridge } from './bridge';
import { NEARBY, channelKey, parseKey, zoneKey, type ConversationKey } from './conversationKey';
import { visibleKeys, type Conversations } from './useConversations';

/** How often the tray's count is re-derived: a card expiring sends no event. */
const ATTENTION_TICK_MS = 15_000;

/**
 * Raise an alert when an agent needs whoever is signed in here and they are
 * not looking — and keep the desktop tray's count of waiting agents current.
 *
 * Listens to the bridge itself rather than to the conversation store's
 * state: an alert is about an *arrival*, and state only says what is true
 * now. The store is read through a ref for the things that decide whether
 * the arrival is already in front of them.
 */
export function useAlerts(
  conversations: Conversations,
  roster: RosterEntry[],
  overlayOpen: boolean,
  onOpen: (key: ConversationKey) => void,
): void {
  const latest = useRef({ conversations, roster, overlayOpen, onOpen });
  latest.current = { conversations, roster, overlayOpen, onOpen };
  const log = useRef(EMPTY_ALERT_LOG);

  useEffect(() => {
    const looking = (): Looking => ({
      focused: document.visibilityState === 'visible' && document.hasFocus(),
      visible: visibleKeys(latest.current.conversations.active, latest.current.overlayOpen),
    });

    const raise = (alert: Alert | null, agent: string): void => {
      if (!alert) return;
      const verdict = admit(log.current, alert, agent, Date.now());
      log.current = verdict.log;
      if (!verdict.raise) return;
      deliver(alert, getAlertPreferences(), getHost(), (opened) => {
        if (opened.key) latest.current.onOpen(opened.key);
      });
    };

    const self = (): { sessionId: string | null; name: string } => {
      const me = latest.current.roster.find((entry) => entry.isSelf);
      return { sessionId: me?.sessionId ?? null, name: me?.name ?? '' };
    };

    const heard = (
      key: ConversationKey,
      line: Parameters<typeof lineAlert>[1],
    ): void => {
      const { sessionId, name } = self();
      // Before the roster lands we do not know our own name, and a rule that
      // matches on it would match nothing or everything.
      if (name === '') return;
      const { channelId } = parseKey(key);
      const isDm = latest.current.conversations.channels.some(
        (channel) => channel.id === channelId && channel.kind === 'dm',
      );
      raise(
        lineAlert(key, line, { selfSessionId: sessionId, myName: name, isDm }, looking()),
        line.fromName,
      );
    };

    const off = [
      gameBridge.on('approval', (approval) => {
        raise(
          approvalAlert(approval, latest.current.conversations.myUserId, looking()),
          approval.agentName,
        );
      }),
      gameBridge.on('chat', (line) => heard(NEARBY, line)),
      gameBridge.on('zoneChat', (line) => heard(zoneKey(line.zoneId), line)),
      gameBridge.on('channelChat', (line) => heard(channelKey(line.channel.id), line)),
      gameBridge.on('activity', (activity) => {
        const myUserId = latest.current.conversations.myUserId;
        const mine =
          myUserId !== '' &&
          latest.current.roster.some(
            (entry) =>
              entry.kind === 'agent' &&
              entry.identityId === activity.agentId &&
              entry.ownerUserId === myUserId,
          );
        const key = activity.channelId
          ? channelKey(activity.channelId)
          : activity.zoneId
            ? zoneKey(activity.zoneId)
            : null;
        raise(doneAlert(activity, mine, key, looking()), activity.agentName);
      }),
    ];
    return () => {
      for (const unsubscribe of off) unsubscribe();
    };
  }, []);

  // The tray's number, with the soonest deadline so the host can count down
  // without us. Only the app has a tray; a browser has nothing to tell.
  //
  // Nothing is sent on unmount, deliberately. This page unmounts for a visit
  // to Settings, and zero would be a claim about cards that are still open;
  // the deadline is what keeps the last number from outliving them.
  const { approvals, myUserId } = conversations;
  useEffect(() => {
    const host = getHost();
    if (!host) return;
    let last = '';
    const report = (): void => {
      const { waiting, until } = waitingOnMe(approvals, myUserId);
      const key = `${waiting}:${until ?? ''}`;
      if (key === last) return;
      last = key;
      void host.setAttention(waiting, until).catch(() => {});
    };
    report();
    const timer = setInterval(report, ATTENTION_TICK_MS);
    return () => clearInterval(timer);
  }, [approvals, myUserId]);
}
