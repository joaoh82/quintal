'use client';

import { useEffect, useState } from 'react';

import {
  askBrowserPermission,
  browserPermission,
  chime,
  type BrowserPermission,
} from '@/lib/alert-delivery';
import {
  ALERT_DEFAULTS,
  getAlertPreferences,
  setAlertPreferences,
  type AlertPreferences,
} from '@/lib/preferences';
import { useHost } from '@/lib/use-host';

/**
 * How this device says an agent needs you while you are looking elsewhere.
 *
 * Works in a browser and in the app. The difference is who shows the
 * notification: the app asks the system directly, and a browser has to be
 * given permission first — asked for here, when somebody ticks the box, and
 * never on page load.
 */
export function AlertsField() {
  const { host, ready } = useHost();
  const [preferences, setPreferences] = useState<AlertPreferences>(ALERT_DEFAULTS);
  const [permission, setPermission] = useState<BrowserPermission>('default');

  useEffect(() => {
    setPreferences(getAlertPreferences());
    setPermission(browserPermission());
  }, []);

  function change(next: AlertPreferences): void {
    setPreferences(next);
    setAlertPreferences(next);
  }

  async function toggleNotify(enabled: boolean): Promise<void> {
    change({ ...preferences, notify: enabled });
    if (enabled && !host && permission === 'default') setPermission(await askBrowserPermission());
  }

  // In a browser, the box being ticked is not the whole answer.
  const blocked =
    ready && !host && preferences.notify
      ? permission === 'denied'
        ? 'This browser is blocking notifications from this site. Allow them in the site settings to get these.'
        : permission === 'unsupported'
          ? 'This browser cannot show notifications.'
          : permission === 'default'
            ? 'Not allowed yet — untick and tick this to be asked.'
            : ''
      : '';

  return (
    <fieldset className="space-y-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">When an agent needs you</legend>
      <p className="text-muted-foreground text-xs">
        One of your agents asking permission, or an agent answering you by name or in a direct
        message, while this window is in the background or on another conversation. Press{' '}
        <kbd className="rounded border px-1 font-mono">N</kbd> in the office to go to whoever is
        waiting. Stored on this device.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={preferences.notify}
          onChange={(event) => void toggleNotify(event.target.checked)}
        />
        Show a notification
      </label>
      {blocked ? (
        <p className="text-destructive text-xs" role="status">
          {blocked}
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={preferences.sound}
          onChange={(event) => {
            change({ ...preferences, sound: event.target.checked });
            if (event.target.checked) chime();
          }}
        />
        Play a sound
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={preferences.done}
          onChange={(event) => change({ ...preferences, done: event.target.checked })}
        />
        Also when one of my agents finishes a turn
      </label>
    </fieldset>
  );
}
