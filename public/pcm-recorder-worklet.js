/* A single continuous audio graph. Local saves never stop this processor. */
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(2400); this.used = 0; this.paused = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'resume') this.paused = false;
      if (data.type === 'flush' || data.type === 'pause') {
        this.flush(); if (data.type === 'pause') this.paused = true;
        this.port.postMessage({ type: 'flushed', id: data.id });
      }
    };
  }
  flush() {
    if (!this.used) return;
    const samples = this.buffer.slice(0, this.used);
    this.port.postMessage({ type: 'samples', samples }, [samples.buffer]); this.used = 0;
  }
  process(inputs) {
    if (this.paused) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] ?? 0;
      this.buffer[this.used++] = sample / channels.length;
      if (this.used === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PcmRecorderProcessor);
