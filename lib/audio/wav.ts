// =====================================================================
// lib/audio/wav.ts
//
// Tiny, dependency-free encoder that turns the mono 16 kHz Float32 PCM
// produced by extractMonoPCM16k() into a 16-bit PCM WAV and then base64.
//
// Used ONLY by the cloud-analysis transcription path: OpenRouter's
// `input_audio` content part needs a real audio container (wav/mp3), not
// raw Float32 samples. The on-device Whisper path keeps using the Float32
// PCM directly and never touches this module.
// =====================================================================

/** Encode mono Float32 PCM (range -1..1) as a 16-bit PCM WAV Blob. */
export function encodeWav(pcm: Float32Array, sampleRate = 16_000): Blob {
  const numSamples = pcm.length;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Samples: clamp + scale to signed 16-bit.
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Encode mono Float32 PCM as a base64 WAV string (no data: prefix). */
export async function encodeWavBase64(
  pcm: Float32Array,
  sampleRate = 16_000
): Promise<string> {
  const blob = encodeWav(pcm, sampleRate);
  const buf = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** Chunked base64 so a multi-MB buffer never blows the call stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000; // 32 KB per String.fromCharCode call
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
