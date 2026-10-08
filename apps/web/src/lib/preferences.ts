/**
 * Preferences that belong to this device, not to the account.
 *
 * A keyboard binding is a fact about the keyboard in front of you — a
 * Portuguese layout puts the backtick somewhere else — so it lives in the
 * browser's storage rather than in a users row. Every read tolerates storage
 * being absent or refusing: a private window, a locked-down profile, a
 * thumbnail render. The default is always a real answer.
 */

export const OVERLAY_KEY_DEFAULT = '`';
const OVERLAY_KEY = 'quintal.overlayKey';

export function getOverlayKey(): string {
  try {
    const stored = window.localStorage.getItem(OVERLAY_KEY);
    return stored && stored.length > 0 ? stored : OVERLAY_KEY_DEFAULT;
  } catch {
    return OVERLAY_KEY_DEFAULT;
  }
}

export function setOverlayKey(key: string): void {
  try {
    if (key === OVERLAY_KEY_DEFAULT) window.localStorage.removeItem(OVERLAY_KEY);
    else window.localStorage.setItem(OVERLAY_KEY, key);
  } catch {
    // Nowhere to keep it. The default still works.
  }
}

/**
 * Keys that may not be the overlay toggle: the ones the office already
 * means something by, and the ones that are not a key so much as a modifier.
 */
const RESERVED = new Set(['Enter', 'Escape', 'Tab', ' ', 'Shift', 'Control', 'Alt', 'Meta']);

export function isBindableKey(key: string): boolean {
  if (RESERVED.has(key)) return false;
  // WASD and arrows walk; `?` is help; `z` is zones; `n` goes to whoever is
  // waiting on you; `@`, `!`, `/` start things in chat.
  if (/^[wasdznWASDZN?@!/]$/.test(key)) return false;
  if (key.startsWith('Arrow')) return false;
  return key.length === 1 || /^F\d{1,2}$/.test(key);
}

/**
 * How this device tells you an agent needs you while you are not looking.
 *
 * On the device rather than the account for the same reason the key is: a
 * laptop in a meeting and a desktop at home want different answers from the
 * same person.
 */
export interface AlertPreferences {
  /** A system notification. */
  notify: boolean;
  /** A short chime. */
  sound: boolean;
  /** Also when one of your agents finishes a turn, not only when it asks. */
  done: boolean;
}

export const ALERT_DEFAULTS: AlertPreferences = { notify: true, sound: true, done: true };
const ALERTS_KEY = 'quintal.alerts';

/** Whatever was stored, made into a whole answer. Anything odd is the default. */
export function parseAlertPreferences(stored: string | null): AlertPreferences {
  if (!stored) return ALERT_DEFAULTS;
  try {
    const value = JSON.parse(stored) as Partial<Record<keyof AlertPreferences, unknown>>;
    const pick = (key: keyof AlertPreferences): boolean =>
      typeof value?.[key] === 'boolean' ? (value[key] as boolean) : ALERT_DEFAULTS[key];
    return { notify: pick('notify'), sound: pick('sound'), done: pick('done') };
  } catch {
    return ALERT_DEFAULTS;
  }
}

export function getAlertPreferences(): AlertPreferences {
  try {
    return parseAlertPreferences(window.localStorage.getItem(ALERTS_KEY));
  } catch {
    return ALERT_DEFAULTS;
  }
}

export function setAlertPreferences(preferences: AlertPreferences): void {
  try {
    window.localStorage.setItem(ALERTS_KEY, JSON.stringify(preferences));
  } catch {
    // Nowhere to keep it. The defaults still work.
  }
}
