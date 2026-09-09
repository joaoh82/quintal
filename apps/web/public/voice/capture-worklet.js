/**
 * The microphone, cut into 20 ms pieces.
 *
 * Runs on the audio thread. The browser hands this 128 samples at a time; the
 * relay wants 960 (20 ms at 48 kHz), which is what one Opus frame is. So this
 * fills a frame and posts it — a transfer, not a copy — and starts the next.
 * Nothing else happens here: no level, no encoding, no decisions. The audio
 * thread is not the place for any of those, and a worklet that does too much
 * is one that drops samples.
 */
class QuintalCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(960);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(960 - this.filled, input.length - offset);
      this.frame.set(input.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === 960) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(960);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('quintal-capture', QuintalCapture);
