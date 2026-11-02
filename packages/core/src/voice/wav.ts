export * as VoiceWav from "./wav"

/** whisper.cpp wants 16 kHz mono 16-bit PCM; every recorder produces exactly that. */
export const RATE = 16_000
export const BYTES_PER_SECOND = RATE * 2

/** A WAV file in memory around 16 kHz mono s16le samples. Never written to disk. */
export function encode(pcm: Int16Array) {
  const out = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string) =>
    [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  ascii(0, "RIFF")
  view.setUint32(4, 36 + pcm.byteLength, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, BYTES_PER_SECOND, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, pcm.byteLength, true)
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44)
  return out
}

/** Loudness of a chunk for the level meter, 0..1 (RMS, square-rooted so speech fills the bar). */
export function level(pcm: Int16Array) {
  if (!pcm.length) return 0
  const sum = pcm.reduce((acc, sample) => acc + sample * sample, 0)
  return Math.min(1, Math.sqrt(Math.sqrt(sum / pcm.length) / 32768) * 1.6)
}

/** Float samples (Web Audio, -1..1) to s16le. */
export function fromFloat(samples: Float32Array) {
  return Int16Array.from(samples, (sample) => Math.max(-32768, Math.min(32767, Math.round(sample * 32767))))
}

/** Join recorded chunks into one buffer. */
export function concat(chunks: readonly Int16Array[]) {
  const out = new Int16Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0))
  chunks.reduce((offset, chunk) => {
    out.set(chunk, offset)
    return offset + chunk.length
  }, 0)
  return out
}
