'use client';

import type {
  BoardCreatePayload,
  BoardPayload,
  BoardUpdatePayload,
} from '@quintal/shared';
import { useCallback, useEffect, useState, type RefObject } from 'react';

import { gameBridge } from './bridge';
import type { OfficeSession } from './createGame';

/**
 * The office board, as React holds it.
 *
 * The office sends the whole board whenever it changes, for anybody's
 * reason — a note written here, one written from another browser, one an
 * agent put up. Nothing is updated optimistically: the office answers
 * fast, and a note that appears before the office has it is a note that
 * can vanish.
 */
export interface Board extends BoardPayload {
  /** Whether the office has said anything yet. Before that the board is not empty, it is unknown. */
  loaded: boolean;
  create: (note: BoardCreatePayload) => void;
  update: (patch: BoardUpdatePayload) => void;
  remove: (itemId: string) => void;
}

const EMPTY: BoardPayload = { items: [], agents: [], you: { userId: '', role: null } };

export function useBoard(sessionRef: RefObject<OfficeSession | null>): Board {
  const [board, setBoard] = useState<BoardPayload>(EMPTY);
  const [loaded, setLoaded] = useState(false);

  useEffect(
    () =>
      gameBridge.on('board', (payload) => {
        setBoard(payload);
        setLoaded(true);
      }),
    [],
  );

  const create = useCallback(
    (note: BoardCreatePayload) => sessionRef.current?.createBoardItem(note),
    [sessionRef],
  );
  const update = useCallback(
    (patch: BoardUpdatePayload) => sessionRef.current?.updateBoardItem(patch),
    [sessionRef],
  );
  const remove = useCallback(
    (itemId: string) => sessionRef.current?.deleteBoardItem(itemId),
    [sessionRef],
  );

  return { ...board, loaded, create, update, remove };
}
