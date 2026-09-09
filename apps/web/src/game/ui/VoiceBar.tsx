'use client';

import type { VoiceUiState } from '@quintal/shared';

import { UNSUPPORTED_NOTICE } from '../voice/support';

/**
 * The microphone, in the bottom bar.
 *
 * One button that says the truth about the mic — off, muted, live — and
 * flips it; a hint for push-to-talk; the device list once there is one;
 * and the one-line reason when something did not work. Nothing here
 * decides who hears whom: the ring on an avatar and the socket state are
 * reported, not controlled.
 */
export function VoiceBar({
  state,
  onToggleMute,
  onDevice,
}: {
  state: VoiceUiState | null;
  onToggleMute: () => void;
  onDevice: (deviceId: string) => void;
}) {
  if (!state) return null;

  if (state.support === 'unsupported') {
    return <span className="text-white/45">{UNSUPPORTED_NOTICE}</span>;
  }

  const live = state.mic === 'live';
  const label =
    state.mic === 'off' ? 'Mic off' : live ? (state.talking ? 'Talking' : 'Mic live') : 'Muted';
  const tone = live
    ? 'border-emerald-400/70 bg-emerald-400/15 text-emerald-200'
    : state.mic === 'muted'
      ? 'border-amber-400/60 text-amber-200'
      : 'border-white/20 text-white/70';

  return (
    <span className="pointer-events-auto flex items-center gap-2">
      <button
        type="button"
        onClick={onToggleMute}
        aria-pressed={live}
        title="M to toggle · hold Space to talk"
        className={`rounded border px-1.5 leading-5 hover:bg-white/10 ${tone}`}
      >
        {label}
      </button>
      {state.socket === 'open' ? (
        <span className="text-white/45">
          {state.peers === 0
            ? 'nobody in earshot'
            : `${state.peers} in earshot${state.speaking.length > 0 ? ' · talking' : ''}`}
        </span>
      ) : (
        <span className="text-white/35">voice off — nobody near</span>
      )}
      {state.devices.length > 1 ? (
        <select
          aria-label="Microphone"
          value={state.deviceId ?? ''}
          onChange={(event) => onDevice(event.target.value)}
          className="rounded border border-white/20 bg-black/40 px-1 text-[11px] text-white/80"
        >
          {state.devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
      ) : null}
      {state.error ? <span className="text-amber-300">{state.error}</span> : null}
    </span>
  );
}
