---
title: bun:speech
tagline: VAD-segmented utterance streams + Whisper STT. Compose with bun:audio for a full mic-to-text pipeline.
section: modules
---

```ts
import speech from "bun:speech";
```

A small orchestration module sitting on top of [`bun:audio`](audio/)'s capture + DSP and [`bun:llm`](llm/)'s `WhisperModel`. Three exports:

- `listen(stream, opts?)` — VAD-gated utterance segmentation over any audio chunk iterator. The returned stream exposes reactive `active` / `noiseFloor` / `lastUtterance` signals.
- `transcribe(utterance, opts)` — speech-to-text via Whisper.
- `speak(text, opts)` — text-to-speech via Piper.

For a full mic + STT + LLM + TTS + speaker pipeline composed in three lines, see [`bun:assistant`](assistant/).

## `listen(stream, opts?)`

Takes an `AsyncIterable<{ samples: Float32Array; timestampMs?: number }>` and yields one `Utterance` per detected speech burst. Pair with `audio.capture(...).frames()` for live mic input, or with any frame source you can produce yourself (file readers, websockets, etc.).

```ts
import audio from "bun:audio";
import speech from "bun:speech";

await using mic = await audio.capture({ sampleRate: 16000, channels: 1 });

for await (const utt of speech.listen(mic.frames(), { sampleRate: 16000 })) {
  console.log(`${utt.durationMs.toFixed(0)}ms (${utt.samples.length} samples)`);
}
```

`Utterance`:

```ts
type Utterance = {
  samples: Float32Array;       // single-channel f32 PCM
  durationMs: number;
  startedAtMs: number;          // wall-clock when the burst started
  endedAtMs: number;
};
```

| Option | Default | Description |
| --- | --- | --- |
| `sampleRate` | required | Hz. Used to convert frame count ↔ ms. |
| `channels` | `1` | If `>1`, the stream is downmixed (channel-average) before VAD. |
| `frameSize` | `480` | Samples per VAD analysis frame. Default = 30 ms at 16 kHz. |
| `ratio` | `3.0` | Speech is detected when frame RMS > `noiseFloor × ratio`. Higher = more conservative. |
| `noiseWindow` | `100` | Sliding-window minimum used as the noise-floor estimator (in frames). |
| `preRollMs` | `200` | How many ms of audio leading into the first speech frame to include in the emitted utterance — captures word onsets that fall in the prior silent frame. |
| `hangoverMs` | `600` | Silence duration that closes an utterance. |
| `minUtteranceMs` | `200` | Bursts shorter than this are dropped (clicks, pops, breath sounds). |

### Reactive signals on the listen stream

The object `listen()` returns is the async iterator plus three [`bun:signals`](signals/) Signals — wire them straight into a UI without polling.

| Signal | Type | What it tracks |
| --- | --- | --- |
| `active` | `boolean` | True while a speech burst is in progress, false during silence. |
| `noiseFloor` | `number` | The current noise-floor estimate (linear RMS, same units as the input). |
| `lastUtterance` | `Utterance \| null` | The most recently emitted utterance. Updates after `hangoverMs` of silence closes a burst. |

```ts
import { effect } from "bun:signals";

const listener = speech.listen(mic.frames(), { sampleRate: 16000 });
effect(() => console.log(listener.active.get() ? "🎤 listening" : "…"));
effect(() => console.log(`floor=${listener.noiseFloor.get().toFixed(4)}`));

for await (const utt of listener) {
  // ...
}
```

## `transcribe(utterance, opts)`

Dispatches to [`WhisperModel`](llm/#whispermodel--speech-to-text). Loads the model on first call and caches it per-process, so subsequent calls reuse the device-resident weights.

```ts
const text = await speech.transcribe(utt, {
  engine: "whisper",
  model: "/path/to/ggml-tiny.en.bin",
  language: "auto",          // or "en" / "es" / etc.
});
```

| Option | Description |
| --- | --- |
| `engine` | `"whisper"` (only option today). |
| `model` | Path to a whisper.cpp `ggml-*.bin` file. F32 / F16 / Q4_0 / Q5_0 / Q5_1 / Q8_0 supported. |
| `language` | ISO-639-1 code, or `"auto"` to detect (multilingual models only — english-only silently keeps `"en"`). |

The pipeline shape:

```ts
import audio from "bun:audio";
import speech from "bun:speech";

await using mic = await audio.capture({ sampleRate: 16000, channels: 1 });

for await (const utt of speech.listen(mic.frames(), { sampleRate: 16000 })) {
  const text = await speech.transcribe(utt, {
    engine: "whisper",
    model: "/models/ggml-tiny.en.bin",
  });
  if (text) console.log(`> ${text}`);
}
```

For longer-than-30-s segments, use the underlying `WhisperModel.transcribe` directly — it handles arbitrary-length input by chunking. `speech.listen`'s utterances are typically <10 s so this is rarely an issue.

## `speak(text, opts)`

Synthesizes `text` into f32 mono PCM via Piper. Returns the samples ready for [`audio.play().write()`](audio/#playopts).

```ts
import audio  from "bun:audio";
import speech from "bun:speech";

const out = await speech.speak("Hello world.", {
  engine: "piper",
  model: "/models/en_US-lessac-medium.onnx",
});

await using spk = await audio.play({ sampleRate: out.sampleRate, channels: out.channels });
await spk.write(out.samples);
```

| Option | Description |
| --- | --- |
| `engine` | `"piper"` (only option today). |
| `model` | Path to a Piper voice `.onnx`. Voices: <https://github.com/rhasspy/piper/blob/master/VOICES.md>. |
| `binPath` | Optional override for the `piper` binary. Defaults to PATH lookup. |

Returns:

```ts
type SpokenAudio = {
  samples: Float32Array;       // f32 mono PCM
  sampleRate: number;          // read from the WAV piper emits — typically 22050 Hz
  channels: number;             // always 1 for current voices
};
```

v1 invokes the `piper` binary as a subprocess (text in via stdin, WAV out via a tempfile). v2 will swap in a libpiper FFI binding for lower latency — the JS surface is stable across that transition. Tracked under [LYK-758](https://linear.app/lyku/issue/LYK-758).

## Limits

- `listen` is single-stream (mono). Multi-channel hot-mic detection is doable but not implemented.
- `transcribe`'s model cache is per-process and per-path, not shared across processes. For high-churn deployments (lots of short-lived workers), preload models in a single long-running process and route requests there ([`llm.serve`](llm/#llmserve--openai-compatible-http-server) is one path).
- Live transcription latency = utterance duration + Whisper wall-clock. With `tiny.en` on CUDA at ~7× real-time, an 8-second utterance transcribes in ~1.1 s — acceptable for most use cases, but not "as you speak" streaming.
