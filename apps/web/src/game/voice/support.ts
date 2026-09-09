/**
 * Can this browser do voice?
 *
 * The baseline is WebCodecs Opus: `AudioEncoder` and `AudioDecoder` with
 * `opus`, which every Chromium has, WebKit since Safari 17.4 (the desktop
 * app's webview), and recent Firefox. There is no wasm fallback — a browser
 * without it keeps text and sees a one-line notice, which is what the plan
 * allowed and what a fallback nobody may ever need would cost.
 *
 * Sync and cheap on purpose: it runs at page load to decide whether to draw
 * the mic button at all. The codec is confirmed for real the first time a
 * socket opens, because `isConfigSupported` is async and a browser can
 * advertise the class and refuse the config.
 */
export type VoiceSupport = 'ok' | 'unsupported';

export function voiceSupport(): VoiceSupport {
  if (typeof window === 'undefined') return 'unsupported';
  const w = window as unknown as Record<string, unknown>;
  const has = (name: string): boolean => typeof w[name] === 'function';
  if (!has('AudioEncoder') || !has('AudioDecoder') || !has('AudioContext')) return 'unsupported';
  if (!has('AudioWorkletNode')) return 'unsupported';
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'unsupported';
  return 'ok';
}

/** What to tell a person whose browser cannot. */
export const UNSUPPORTED_NOTICE =
  'Voice needs a newer browser (WebCodecs Opus). Text works as it always did.';
