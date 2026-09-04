'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  OVERLAY_KEY_DEFAULT,
  getOverlayKey,
  isBindableKey,
  setOverlayKey,
} from '@/lib/preferences';

/**
 * Which key opens the conversations panel.
 *
 * Kept on this device, not on the account: it is a fact about the keyboard
 * in front of you. Set by pressing the key, not by typing its name — nobody
 * knows what their layout calls the thing left of 1.
 */
export function OverlayKeyField() {
  const [key, setKey] = useState(OVERLAY_KEY_DEFAULT);
  const [listening, setListening] = useState(false);
  const [refused, setRefused] = useState('');

  useEffect(() => setKey(getOverlayKey()), []);

  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault();
      if (event.key === 'Escape') {
        setListening(false);
        return;
      }
      if (!isBindableKey(event.key)) {
        setRefused(`${event.key === ' ' ? 'Space' : event.key} already means something in the office.`);
        return;
      }
      setOverlayKey(event.key);
      setKey(event.key);
      setRefused('');
      setListening(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listening]);

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <p className="text-sm font-medium">Conversations panel key</p>
      <div className="flex flex-wrap items-center gap-3">
        <kbd className="rounded border px-2 py-1 font-mono text-sm">
          {listening ? 'press a key…' : key === ' ' ? 'Space' : key}
        </kbd>
        <Button type="button" variant="outline" size="sm" onClick={() => setListening(true)}>
          Change
        </Button>
        {key !== OVERLAY_KEY_DEFAULT ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setOverlayKey(OVERLAY_KEY_DEFAULT);
              setKey(OVERLAY_KEY_DEFAULT);
            }}
          >
            Reset to {OVERLAY_KEY_DEFAULT}
          </Button>
        ) : null}
      </div>
      {refused ? (
        <p className="text-destructive text-xs" role="alert">
          {refused}
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">
        Opens the panel with every zone, channel and direct message. Stored on this device.
      </p>
    </div>
  );
}
