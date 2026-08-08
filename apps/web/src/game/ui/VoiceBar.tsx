'use client';

import { useEffect, useState } from 'react';

import type { VoiceSnapshot } from '../voice/VoiceManager';

interface VoiceBarProps {
  voice: VoiceSnapshot;
  onToggleMute: () => void;
  onPickDevice: (deviceId: string) => void;
  onEnableAudio: () => void;
}

/**
 * Mic state, in the corner, saying only what is true right now.
 *
 * The states people actually hit are `idle` (nobody else here) and `connected`.
 * The rest exist because silently doing nothing is the worst way for audio to
 * fail: a person who cannot hear a colleague needs to know whether the office
 * has no voice configured, whether the browser is blocking it, or whether they
 * are simply alone.
 */
export function VoiceBar({
  voice,
  onToggleMute,
  onPickDevice,
  onEnableAudio,
}: VoiceBarProps) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);

  // Device labels are empty until the page holds a mic permission, so this is
  // re-read once we are connected rather than on mount.
  useEffect(() => {
    if (voice.state !== 'connected') return;
    let alive = true;
    const read = (): void => {
      void navigator.mediaDevices?.enumerateDevices().then((devices) => {
        if (alive) setMics(devices.filter((device) => device.kind === 'audioinput'));
      });
    };
    read();
    navigator.mediaDevices?.addEventListener('devicechange', read);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener('devicechange', read);
    };
  }, [voice.state]);

  if (voice.state === 'idle') {
    return (
      <span className="pointer-events-none text-white/35">
        voice · alone
      </span>
    );
  }

  if (voice.state === 'unavailable') {
    return (
      <span className="pointer-events-none text-white/35" title={voice.detail}>
        voice · not configured
      </span>
    );
  }

  if (voice.state === 'connecting') {
    return <span className="pointer-events-none text-amber-300/80">voice · connecting…</span>;
  }

  if (voice.state === 'error') {
    return (
      <span className="pointer-events-none text-rose-300" title={voice.detail}>
        voice · failed
      </span>
    );
  }

  if (voice.state === 'blocked') {
    return (
      <button
        type="button"
        onClick={onEnableAudio}
        className="pointer-events-auto rounded border border-amber-300/40 px-2 text-amber-200 hover:bg-white/10"
      >
        click to enable audio
      </button>
    );
  }

  return (
    <span className="pointer-events-auto flex items-center gap-2">
      <button
        type="button"
        onClick={onToggleMute}
        title={voice.muted ? 'Unmute (M, or hold Space)' : 'Mute (M)'}
        className={`rounded border px-2 ${
          voice.muted
            ? 'border-white/20 text-white/60 hover:bg-white/10'
            : 'border-emerald-400/50 bg-emerald-400/15 text-emerald-200'
        }`}
      >
        {voice.muted ? '🔇 muted' : '🎙 live'}
      </button>

      <span className="text-white/40">
        {voice.hearing.length === 0
          ? 'nobody in range'
          : `hearing ${voice.hearing.length}`}
      </span>

      {mics.length > 1 ? (
        <select
          onChange={(event) => onPickDevice(event.target.value)}
          className="max-w-36 truncate rounded border border-white/15 bg-black/40 px-1 text-[10px] text-white/70"
          aria-label="Microphone"
        >
          {mics.map((mic) => (
            <option key={mic.deviceId} value={mic.deviceId}>
              {mic.label || 'Microphone'}
            </option>
          ))}
        </select>
      ) : null}
    </span>
  );
}
