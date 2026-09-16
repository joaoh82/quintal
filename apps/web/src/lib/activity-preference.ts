import {
  activityDetailLevel,
  type ActivityDetailLevel,
} from '@quintal/shared';

const EVENT = 'quintal:activity-detail';
const keyFor = (userId: string) => `quintal.user.${userId}.activityDetail`;

/**
 * Notify another open view for the same account while the durable save runs.
 * Storage is only a signal/cache: every fresh page gets the database value
 * from its authenticated server render.
 */
export function announceActivityDetailLevel(
  userId: string,
  level: ActivityDetailLevel,
): void {
  try {
    window.localStorage.setItem(keyFor(userId), level);
  } catch {
    // Persistence is server-side; a locked-down browser only loses live cross-tab sync.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { userId, level } }));
}

export function subscribeActivityDetailLevel(
  userId: string,
  onLevel: (level: ActivityDetailLevel) => void,
): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === keyFor(userId) && event.newValue) {
      onLevel(activityDetailLevel(event.newValue));
    }
  };
  const onEvent = (event: Event): void => {
    const detail = (event as CustomEvent<{ userId?: string; level?: unknown }>).detail;
    if (detail?.userId === userId) onLevel(activityDetailLevel(detail.level));
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(EVENT, onEvent);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(EVENT, onEvent);
  };
}
