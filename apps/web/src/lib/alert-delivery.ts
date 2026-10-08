import type { Alert } from '@/game/alerts';

import type { HostBridge } from './host';
import type { AlertPreferences } from './preferences';

/**
 * Telling somebody an agent needs them: a system notification and a chime.
 *
 * The rule for *whether* is `game/alerts.ts`. This is only *how*, and every
 * part of it is allowed to fail quietly — a browser that refused permission,
 * a machine with no notification service, a page that has not been clicked
 * and so may not make a sound. None of those is a reason for the office to
 * do anything but carry on.
 */

export type BrowserPermission = 'granted' | 'denied' | 'default' | 'unsupported';

/** Where a plain browser stands on notifications. The app does not ask this. */
export function browserPermission(): BrowserPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/** Ask, once somebody has said they want this. Never on page load. */
export async function askBrowserPermission(): Promise<BrowserPermission> {
  if (browserPermission() === 'unsupported') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return browserPermission();
  }
}

let audio: AudioContext | null = null;

/**
 * Two short rising notes. Synthesized rather than shipped: no asset to load,
 * nothing to cache, and it cannot 404.
 */
export function chime(): void {
  try {
    audio ??= new AudioContext();
    const context = audio;
    // A context made before the page was ever clicked starts suspended.
    void context.resume();
    const start = context.currentTime;
    for (const [index, frequency] of [660, 880].entries()) {
      const at = start + index * 0.14;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.24);
    }
  } catch {
    // No audio here. The notification, if there is one, still says it.
  }
}

/**
 * Raise one alert the ways this device asked for.
 *
 * `onOpen` is where a click on a browser notification goes. The app's
 * notifications carry no click of their own on a desktop — opening the
 * window and pressing N is the way there.
 */
export function deliver(
  alert: Alert,
  preferences: AlertPreferences,
  host: HostBridge | null,
  onOpen: (alert: Alert) => void,
): void {
  if (alert.kind === 'done' && !preferences.done) return;
  if (preferences.sound) chime();
  if (!preferences.notify) return;

  if (host) {
    void host.notify(alert.title, alert.body).catch(() => {});
    return;
  }
  if (browserPermission() !== 'granted') return;
  try {
    const shown = new Notification(alert.title, { body: alert.body, tag: alert.id });
    shown.onclick = () => {
      window.focus();
      onOpen(alert);
      shown.close();
    };
  } catch {
    // Some browsers only allow these from a service worker. Not worth one.
  }
}
