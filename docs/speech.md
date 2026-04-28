---
title: bun:speech
tagline: VAD-segmented utterance streams + Whisper STT. Compose with bun:audio for a full mic-to-text pipeline.
section: modules
---

```ts
import speech from "bun:speech";
```

A small orchestration module sitting on top of [`bun:audio`](audio/)'s capture + DSP and [`bun:llm`](llm/)'s `WhisperModel`. Five exports:

- `listen(stream, opts?)` — VAD-gated utterance segmentation over any audio chunk iterator. The returned stream exposes reactive `active` / `noiseFloor` / `lastUtterance` signals.
- `transcribe(utterance, opts)` — speech-to-text via Whisper.
- `speak(text, opts)` — text-to-speech via Piper.
- `wakeWord(opts)` — Whisper-backed keyword spotter. Composable trigger stream for "hey jetson"-style wake-on-phrase, with reactive `active` / `lastTrigger` signals.
- `matchWakePhrase(text, phrase, strategy?, maxEdits?)` — pure phrase matcher. Substring / exact / fuzzy (Levenshtein) strategies; reusable outside the wake-word stream.

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
  sampleRate: number;          // read from the voice config — 16000 / 22050 depending on quality
  channels: number;             // always 1 for current voices
};
```

The first call for a given `(binPath, model)` pair pays a one-time voice-load cost (~120 ms on a Pi 5, ~15 ms on a desktop with warm caches). Subsequent calls reuse the same long-running `piper --json-input --output_raw` subprocess, so they only pay the inference + IPC cost (~30-50 ms for one short sentence). The cache lives for the process lifetime; call `speech.closePiperSessions()` to tear it down explicitly (handy for hot-reload / test cleanup) — the next `speak()` will lazily respawn.

The full direct-FFI integration (skipping the subprocess entirely) is tracked under [LYK-758](https://linear.app/lyku/issue/LYK-758) for the last few ms of latency. The JS surface is stable across that transition.

## `closePiperSessions()`

```ts
await speech.closePiperSessions();
```

Closes every cached Piper session and frees the underlying subprocesses. Idempotent. Subsequent `speak()` calls re-spawn lazily. The cache is also cleared automatically at process exit, so calling this is only necessary when you want to reclaim those resources mid-process (test teardown, hot-reload, voice swap).

## `wakeWord(opts)`

Composable wake-word stream. Pipes the audio source through `listen()` for VAD-bounded utterances, transcribes each with Whisper, and emits a `WakeTrigger` whenever the transcription matches one of the configured phrases.

```ts
import audio from "bun:audio";
import speech from "bun:speech";

await using mic = await audio.capture({ sampleRate: 16000, channels: 1 });

for await (const trigger of speech.wakeWord({
  source: mic.frames(),
  whisper: "/models/ggml-tiny.en.bin",
  phrase: ["hey jetson", "ok parabun"],
  match: "fuzzy",
  maxEdits: 2,
})) {
  console.log(`woke on ${trigger.phrase} (confidence ${trigger.confidence.toFixed(2)})`);
  // Now run your own listen loop, hand off to bun:assistant, etc.
}
```

`WakeOptions`:

```ts
type WakeOptions = {
  source: AsyncIterable<{ samples: Float32Array; timestampMs?: number }>;
  whisper: string | WhisperModel;             // path or pre-loaded handle
  phrase: string | string[];                   // case-insensitive
  match?: "contains" | "exact" | "fuzzy";      // default "contains"
  maxEdits?: number;                           // default 2 (fuzzy only)
  sampleRate?: number;                         // default 16000
  listenOpts?: Omit<ListenOptions, "sampleRate">;
  language?: string;                           // whisper hint, default "en"
};

type WakeTrigger = {
  phrase: string;                              // matched, normalized lowercase
  transcription: string;                       // full utterance text
  confidence: number;                          // [0, 1]
  utterance: Utterance;                        // raw samples + timing
};
```

The returned stream carries two reactive signals — wire them into UIs without polling:

| Signal | Type | When it changes |
| --- | --- | --- |
| `wake.active` | `boolean` | True while a candidate utterance is being scored. Useful for a "thinking" spinner that fires only when something might be a wake. |
| `wake.lastTrigger` | `WakeTrigger \| null` | Updates every time a phrase matches. Subscribe via `effect`/`subscribe` for boundary events. |

### Why whisper-backed

Wake-word detection is conventionally a separate workload from STT — Picovoice Porcupine, openWakeWord, etc. ship dedicated tiny KWS models that run continuously at sub-watt power.

The v1 implementation here reuses Whisper instead. Trade-offs:

- **Pro**: any phrase the user picks works — no per-keyword model file.
- **Pro**: zero additional dependencies; the model is already loaded for STT.
- **Pro**: VAD-gated, so an idle mic costs nothing — Whisper only fires once per detected speech burst.
- **Con**: not a true low-power solution. Whisper-tiny on a Pi 5 is ~80 ms per second of audio; fine for a wall-powered kitchen display, marginal for a battery-powered necklace.

A future follow-up adds a dedicated KWS engine option for true always-on sub-watt KWS. The surface is engine-agnostic enough to absorb it.

## `matchWakePhrase(text, phrase, strategy?, maxEdits?)`

The phrase-matching primitive used by `wakeWord` internally. Exposed for users who want to wire their own gate (e.g., transcribing through a different engine, or matching against an existing transcript stream).

```ts
const m = speech.matchWakePhrase("Hey, Jetson! What time is it?", "hey jetson");
// → { phrase: "hey jetson", confidence: 1 }

const fuzzy = speech.matchWakePhrase("ay jetson", "hey jetson", "fuzzy", 2);
// → { phrase: "hey jetson", confidence: 0.5 } (1 edit / max 2)
```

Returns `{ phrase, confidence } | null`. Punctuation and case are normalized before matching. `"fuzzy"` mode tries the whole-string Levenshtein distance first, then a sliding token-window pass so the phrase can be embedded in a longer transcription.

## Limits

- `listen` is single-stream (mono). Multi-channel hot-mic detection is doable but not implemented.
- `transcribe`'s model cache is per-process and per-path, not shared across processes. For high-churn deployments (lots of short-lived workers), preload models in a single long-running process and route requests there ([`llm.serve`](llm/#llmserve--openai-compatible-http-server) is one path).
- Live transcription latency = utterance duration + Whisper wall-clock. With `tiny.en` on CUDA at ~7× real-time, an 8-second utterance transcribes in ~1.1 s — acceptable for most use cases, but not "as you speak" streaming.
