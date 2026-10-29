export const SAMPLE_RATE = 24_000;
export function pcm16(samples: Float32Array): Int16Array {
  return Int16Array.from(samples, (value) => Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)));
}
export function wav(samples: Int16Array): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return new Blob([bytes], { type: "audio/wav" });
}
export async function readWav(blob: Blob): Promise<Int16Array> {
  const bytes = await blob.arrayBuffer(); const view = new DataView(bytes);
  if (bytes.byteLength < 44 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645
    || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== SAMPLE_RATE
    || view.getUint16(34, true) !== 16 || view.getUint32(36) !== 0x64617461 || view.getUint32(40, true) !== bytes.byteLength - 44) {
    throw new Error("Deze opname gebruikt een ouder of ongeldig audioformaat. De originele lokale bestanden blijven behouden.");
  }
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] === 1) return new Int16Array(bytes, 44);
  return Int16Array.from({ length: (bytes.byteLength - 44) / 2 }, (_, i) => view.getInt16(44 + i * 2, true));
}
/** Storage boundaries are exact sample boundaries, never recorder restarts. */
export class PcmSegmenter {
  private buffer: Int16Array;
  private used = 0;
  constructor(private readonly size: number, private readonly emit: (samples: Int16Array) => void) {
    if (!Number.isInteger(size) || size < 1) throw new Error("Ongeldige buffergrootte.");
    this.buffer = new Int16Array(size);
  }
  push(samples: Int16Array) {
    for (let offset = 0; offset < samples.length;) {
      const count = Math.min(this.size - this.used, samples.length - offset);
      this.buffer.set(samples.subarray(offset, offset + count), this.used);
      this.used += count; offset += count;
      if (this.used === this.size) { this.emit(this.buffer); this.buffer = new Int16Array(this.size); this.used = 0; }
    }
  }
  flush() { if (this.used) { this.emit(this.buffer.slice(0, this.used)); this.used = 0; } }
}
