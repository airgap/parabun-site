---
title: bun:audio
tagline: WAV / MP3 / Opus codecs, biquads, FFT, mel spectrograms, voice activity detection, denoising, AGC, dynamics, and ALSA capture / playback.
section: modules
---

```ts
import audio from "bun:audio";
```

A from-scratch audio toolkit. Heavy codecs (libopus 1.6.1, minimp3, rnnoise) are vendored statically. The DSP surface is enough for a full voice-call pipeline plus the audio frontend that feeds [Whisper STT](llm/#whispermodel--speech-to-text).

## File I/O

### `readWav(bytes)` / `writeWav(samples, opts)`

WAV decode + encode. Handles 8/16/24/32-bit PCM, IEEE-float, mono / stereo / multichannel.

```ts
const wav = audio.readWav(new Uint8Array(await Bun.file("clip.wav").arrayBuffer()));
// { sampleRate: 48000, channels: 1, samples: Float32Array, bitDepth: 16 }
const out = audio.writeWav(wav.samples, { sampleRate: 48000, channels: 1, bitDepth: 16 });
await Bun.write("normalized.wav", out);
```

### `decodeMp3(bytes)`

minimp3-backed decoder. Returns `{ sampleRate, channels, samples }` with PCM as interleaved Float32.

## Opus codec

```ts
const enc = new audio.OpusEncoder({ sampleRate: 48000, channels: 1, application: "voip" });
const dec = new audio.OpusDecoder({ sampleRate: 48000, channels: 1 });

const opus = enc.encode(f32Frame);          // Uint8Array
const f32 = dec.decode(opus);
```

`application` is `"voip" | "audio" | "lowdelay"`. Frame sizes are the Opus standard (2.5 / 5 / 10 / 20 / 40 / 60 ms at 48 kHz). Bitrate, complexity, FEC, DTX, in-band PLC are all knobs on the encoder constructor; see source for the full option set.

Pair with [`bun:rtp`](rtp/) for a wire-format Opus / RTP stream.

## Biquad filters (RBJ Audio EQ Cookbook)

Stateless functions that return a new `Float32Array`:

| Function | Description |
| --- | --- |
| `lowpass(samples, sr, freq, q?)` | Q defaults to 0.707 (Butterworth). |
| `highpass(samples, sr, freq, q?)` | |
| `bandpass(samples, sr, freq, q?)` | |
| `notch(samples, sr, freq, q?)` | |

Each does a single second-order IIR pass — chain them for steeper rolloff.

## Mixing, level, conversion

| Function | Description |
| --- | --- |
| `mix(a, b, gainA?, gainB?)` | Sample-wise mix into a new `Float32Array`. |
| `normalize(samples, target?)` | Scale to target peak. Default `target = 0.95`. |
| `peak(samples)` / `rms(samples)` | Whole-buffer level. |
| `envelope(samples, windowMs, sampleRate)` | Sliding-window RMS envelope. |
| `i16ToF32(int16)` / `f32ToI16(float32)` | PCM type conversion. |
| `interleave(channels)` / `deinterleave(samples, n)` | Frame-major ⇄ planar. |
| `resample(samples, from, to)` | Sinc-windowed resample. |

## FFT

Cooley-Tukey radix-2, in place:

```ts
const x = new Float32Array(1024);     // real input
const X = audio.fft(x);                // complex Float32Array, length 2048 (interleaved Re/Im)
const back = audio.ifft(X);            // round-trips to ~1e-5
```

`fft` accepts either a real signal (length must be power of two) or an interleaved-complex buffer (length must be even). `ifft` returns the real part of the inverse — the imaginary part is dropped.

## Spectrograms

### `spectrogram(samples, { window, hop })`

STFT magnitudes. Returns `Float32Array[]` — one frame per window position, each `(window/2 + 1)` long. Hann window applied before each FFT.

### `melSpectrogram(samples, opts?)`

Slaney-normalized triangular mel filterbank — the standard preprocessing frontend for Whisper / Wav2Vec2.

```ts
const mel = audio.melSpectrogram(samples, {
  sampleRate: 16000,
  nMels: 80,
  windowSize: 400,
  hop: 160,
  nFft: 512,
  mode: "whisper",
});
// { frames: Float32Array[], nMels: 80, nFft: 512, hop: 160 }
```

| Option | Default | Description |
| --- | --- | --- |
| `sampleRate` | `16000` | Whisper's rate. |
| `nMels` | `80` | Whisper's count. Wav2Vec2 uses 128. |
| `windowSize` | `400` | 25 ms at 16 kHz. |
| `hop` | `160` | 10 ms at 16 kHz. |
| `nFft` | `nextPow2(windowSize)` | Must be a power of 2 ≥ windowSize. |
| `mode` | `"whisper"` | `"log10"` returns dB-style log10(power). `"whisper"` clips to 8 dB dynamic range and rescales to ~[-1, 1]. |

The mel filter bank matches `librosa.filters.mel(htk=False)`.

## Voice activity detection

```ts
const vad = audio.detectVoice(samples, { frameSize: 480, ratio: 3.0, noiseWindow: 100 });
// { energies: Float32Array, speech: boolean[], noiseFloor: number }
```

Adaptive RMS-vs-noise-floor classifier. The noise floor is a sliding-window minimum of frame energies; a frame is "speech" when its RMS exceeds `noiseFloor × ratio`. Defaults track 30 ms frames (480 samples at 16 kHz) and a 3-second noise-window memory.

For utterance-level segmentation (pre-roll, hangover, minimum length filtering) use [`speech.listen`](speech/) — it's a wrapper around `detectVoice` that yields one segment per speech burst.

## Dynamics

In-place processors with persistent state — useful for live streams. Call `.process(buffer)` to apply, `.reset()` to clear state.

```ts
const den = new audio.Denoiser();        // rnnoise, 480-sample frames at 48 kHz
den.process(f32);                         // suppresses background noise

const gain = new audio.Gain({ targetLevel: 0.1 });    // simple AGC
gain.process(f32);

const comp = new audio.Compressor({
  threshold: -20, ratio: 4, attack: 5, release: 50, knee: 6, makeupGain: 0,
});
comp.process(f32);

const lim = new audio.Limiter({ ceiling: -1, release: 50 });
lim.process(f32);
```

Compressor / Limiter run feed-forward dynamics on the same shape as the Gain class — process / reset / persistent state. The Limiter is brick-wall: instant-rise envelope (no smoothing on rise), so the ceiling is enforced sample-accurate.

## OS audio I/O — Linux today

Live ALSA capture + playback. CoreAudio (macOS) and WASAPI (Windows) follow on the same surface.

### `devices()`

Returns `{ name, description, id, type: "capture" | "playback" }[]` from ALSA.

### `capture(opts)`

```ts
await using mic = await audio.capture({
  sampleRate: 16000,
  channels: 1,
  device: "default",        // or one of the ids from devices()
  bufferMs: 30,              // analysis frame length
});
for await (const frame of mic.frames()) {
  // frame is { samples: Float32Array, timestampMs: number }
}
```

`mic` is `AsyncDisposable` — `await using` releases the ALSA handle on scope exit. `mic.frames()` is an async iterator of float32 PCM frames; on the wire, ALSA delivers S16_LE which is converted in-place.

### `play(opts)`

```ts
await using spk = await audio.play({ sampleRate: 48000, channels: 2 });
await spk.write(f32Frame);
```

`spk.write` returns when the frame is queued (not when it finishes playing). On scope exit, the buffer drains before close. Three explicit verbs:

- `spk.write(samples)` — queue more audio into ALSA.
- `spk.drain()` — block until everything queued has played out.
- `spk.stop()` — discard whatever is queued **immediately** and re-prepare the stream so subsequent `write` calls work. The barge-in cancel verb: cut the current playback short the moment a higher layer (VAD, UI button) decides the user wants to talk. `bot.interrupt()` in [`bun:assistant`](assistant/) calls this under the hood.

`spk.queuedMs: Signal<number>` reports the current depth of the kernel ring buffer in milliseconds. Updates after every `write` / `drain` / `stop` and on a low-frequency 100 ms poll while audio is queued — wire it into a UI for backpressure feedback ("can I write a few more sentences?") or into an `effect` that holds off speak() until the queue drains. The signal converges to 0 a few ms after the buffer empties; rate-limit matches `mic.peakLevel` / `listen().noiseFloor` to keep effects from thrashing.

## Limits

- Opus encoder doesn't expose `OPUS_SET_FORCE_MODE` or `OPUS_SET_PACKET_LOSS_PERC` directly — open an issue if you need them.
- `decodeMp3` is one-shot (no streaming). For very large files, decode in chunks at the file level.
- Resample uses a fixed-quality kernel; high-ratio resampling (>4x) trades CPU for quality. SoX-class polyphase is on the roadmap.
