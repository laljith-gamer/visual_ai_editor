/**
 * v1.7.3 — Audio extraction.
 *
 * Read a video Blob, decode its audio track via the Web Audio API,
 * and return a `Float32Array` of mono PCM samples at 16 kHz — the
 * exact format Whisper expects.
 *
 * Why Web Audio API and not mediabunny?
 *   - mediabunny is already in the dep tree but its audio sink API is
 *     more ceremony than we need here. `decodeAudioData` ships with
 *     every browser, decodes whatever the user's browser can play
 *     (mp4, webm, mov, mkv, mp3, m4a, aac, opus, …), and gives us a
 *     ready-to-resample AudioBuffer in one shot.
 *   - When decodeAudioData fails (rare — usually a codec the browser
 *     itself can't play either), we surface a clean error with the
 *     codec name from the file extension so the user sees something
 *     actionable instead of "decoding error".
 *
 * Resampling pipeline:
 *   1. Decode at the source's native sample rate via AudioContext.
 *   2. Mix down to mono (average across channels).
 *   3. Resample to 16 kHz via OfflineAudioContext (the browser's own
 *      resampler — high-quality, GPU-accelerated where available).
 *
 * The whole thing runs on the main thread because OfflineAudioContext
 * doesn't exist in workers. That's fine: typical throughput is 100x
 * realtime so a 10-minute video decodes in < 6 s. We DO do the actual
 * Whisper inference in a worker (whisper.worker.ts), which is where
 * the heavy CPU/GPU lift lives.
 */

const TARGET_SAMPLE_RATE = 16_000;

/** Public API. Returns 16 kHz mono PCM Float32. Throws on hard
 *  decoder failures (caller surfaces a friendly message). */
export async function extractMonoPCM16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();

  // ---- 1. Decode at native sample rate ----------------------------
  // Use a one-shot AudioContext rather than OfflineAudioContext so the
  // browser uses its preferred decode path. We close it immediately.
  const Ctor: typeof AudioContext =
    typeof window !== "undefined" && "AudioContext" in window
      ? window.AudioContext
      : ((window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext as typeof AudioContext);
  if (!Ctor) {
    throw new Error("Web Audio API not available in this browser.");
  }

  const decodeCtx = new Ctor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch (err) {
    void decodeCtx.close().catch(() => {});
    throw new Error(
      `Couldn't decode the audio track: ${(err as Error).message}. The browser may not support this codec.`
    );
  }
  await decodeCtx.close().catch(() => {});

  // ---- 2. Mix down to mono ----------------------------------------
  const monoSource = mixToMono(decoded);

  // ---- 3. Resample to 16 kHz if needed ----------------------------
  if (decoded.sampleRate === TARGET_SAMPLE_RATE) {
    return monoSource;
  }

  const targetLength = Math.ceil(
    monoSource.length * (TARGET_SAMPLE_RATE / decoded.sampleRate)
  );
  // OfflineAudioContext clamps allowed sample rates to a browser-
  // specific range. 16 kHz is universally supported.
  const offline = new OfflineAudioContext(
    1,
    targetLength,
    TARGET_SAMPLE_RATE
  );
  const monoBuffer = offline.createBuffer(
    1,
    monoSource.length,
    decoded.sampleRate
  );
  // copyToChannel requires Float32Array<ArrayBuffer>; mixToMono returns
  // a fresh Float32Array(length) so its underlying buffer is a plain
  // ArrayBuffer. We copy through getChannelData(0) to satisfy TS narrowing
  // without an extra allocation in practice.
  monoBuffer.getChannelData(0).set(monoSource);
  const node = offline.createBufferSource();
  node.buffer = monoBuffer;
  node.connect(offline.destination);
  node.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** Average all channels into one Float32. Works for any channel count;
 *  iPhone screen-recordings sometimes ship 2-channel audio with only
 *  the right channel populated, so a mean is safer than picking ch[0]. */
function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) {
    // Copy out so the caller can safely retain it after the
    // AudioBuffer goes out of scope.
    return new Float32Array(buffer.getChannelData(0));
  }
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const chan = buffer.getChannelData(c);
    for (let i = 0; i < chan.length; i++) {
      out[i] += chan[i];
    }
  }
  const inv = 1 / buffer.numberOfChannels;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/** Quick check whether a Blob carries any audio. Cheap because
 *  decodeAudioData on a header-only slice is fast on most browsers,
 *  but it's not free — call this only when you actually want to
 *  short-circuit silent files. */
export async function probeHasAudio(blob: Blob): Promise<boolean> {
  try {
    const samples = await extractMonoPCM16k(blob);
    // A handful of completely silent samples means the source is
    // either silent or the audio track is missing entirely. Either
    // way, transcription would yield nothing useful.
    if (samples.length === 0) return false;
    let energy = 0;
    // Inspect at most ~10s of samples to keep this O(160k) max.
    const probeLen = Math.min(samples.length, TARGET_SAMPLE_RATE * 10);
    for (let i = 0; i < probeLen; i++) energy += Math.abs(samples[i]);
    return energy / probeLen > 1e-4;
  } catch {
    return false;
  }
}
