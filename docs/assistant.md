---
title: bun:assistant
tagline: Three-line edge voice assistant. Composes bun:audio + bun:speech + bun:llm with reactive signals and persistent memory.
section: modules
---

```ts
import assistant from "bun:assistant";
```

A Tier 2 facade. Composes [`bun:audio`](audio/) (mic + speaker), [`bun:speech`](speech/) (VAD + STT + TTS), and [`bun:llm`](llm/) (Llama / Qwen2 inference) into a complete on-device voice loop. The 3-line case stays 3 lines; new fields unlock new capabilities, never remove defaults.

```ts
import assistant from "bun:assistant";

await using bot = await assistant.create({
  llm: "/models/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
  stt: "/models/ggml-tiny.en.bin",
  tts: "/models/en_US-lessac-medium.onnx",
  system: "You are a concise voice assistant.",
});

await bot.run();
```

`bot.run()` opens the mic, gates on VAD, transcribes with Whisper, generates with the LLM, synthesizes with Piper, plays through ALSA, and loops — until disposal. No cloud round-trip.

## `assistant.create(opts)`

Loads every model and opens the audio devices that the supplied options require. Returns when the bot is ready to converse.

```ts
type AssistantOptions = {
  llm: string;                       // GGUF path — required
  stt?: string;                      // ggml-*.bin Whisper model
  tts?: string;                      // .onnx Piper voice
  ttsBinPath?: string;               // override the piper binary (default: PATH lookup)
  mic?: { device?: string; sampleRate?: number; channels?: number; periodMs?: number };
  speaker?: { device?: string };
  system?: string;                   // system prompt
  llmOpts?: { maxContext?: number };
  chatOpts?: { maxTokens?: number; temperature?: number; topK?: number; topP?: number };
  memory?: string | { path: string };  // sqlite path — opt-in persistent transcript
};
```

| Field | What you get | What you give up if you omit |
| --- | --- | --- |
| `llm` | Required. Path to a GGUF Llama / Qwen2 chat model. | n/a — `create` throws. |
| `stt` | Whisper STT for voice input via `bot.run` / `bot.turns`. | Voice loop unavailable; `bot.ask(text)` still works. |
| `tts` | Piper TTS for voice output. | Replies stay text-only; `bot.lastTurn.assistant` is the source of truth. |
| `mic` | ALSA capture options (defaults: `default`, 16 kHz, mono, 20 ms periods). | n/a if you have `stt` — defaults are fine for Whisper. |
| `speaker` | ALSA playback device. Sample rate is auto-negotiated from the TTS-emitted WAV. | n/a if you have `tts`. |
| `memory` | Sqlite-backed persistent transcript that replays on next `create`. | Each process starts with an empty history (system prompt only). |

## `bot.run()`

Drains [`bot.turns()`](#botturns). Equivalent to `for await (const _ of bot.turns()) {}`.

```ts
await bot.run();   // runs until close() or stt/mic torn down
```

## `bot.turns()`

The primary control surface — async-iterator over conversation turns.

```ts
for await (const turn of bot.turns()) {
  console.log(`${turn.user} → ${turn.assistant}`);
  if (turn.assistant.includes("goodbye")) break;
}
```

Each iteration:

1. Waits for a VAD-gated utterance from the mic.
2. Transcribes via Whisper.
3. Calls the LLM with full history.
4. Synthesizes via Piper (if `tts` is set) and plays through the speaker.
5. Yields the `Turn` and resumes listening.

`Turn` shape:

```ts
type Turn = {
  user: string | null;          // null for proactive bot.say(...) turns
  assistant: string;
  toolCalls: { name: string; args: unknown; result: unknown }[];   // empty in v1
  startedAtMs: number;
  endedAtMs: number;
  interrupted: boolean;          // true if VAD or bot.interrupt() cut the turn short
};
```

Throws if neither `stt` nor `mic` was configured at create time.

## `bot.ask(text)`

Skips STT — feeds `text` straight in as a user turn, runs the LLM, and (if `tts` is configured) speaks the reply. Returns the `Turn`.

```ts
const turn = await bot.ask("What's the time in Tokyo?");
console.log(turn.assistant);
```

Useful for tests, CLI tools, scheduled prompts, and anywhere voice input isn't available.

## `bot.say(text)`

Speaks `text` without recording a user turn. Use for scheduled announcements, alarms, "hey, you've been quiet" prompts, etc. Throws if `tts` isn't configured.

```ts
await bot.say("Your laundry cycle is finished.");
```

## Reactive signals

Every public signal is a [`bun:signals`](signals/) Signal — wire them into a UI without polling. Each updates synchronously when its source changes; subscribe with `.subscribe(cb)` or read with `.get()`.

| Signal | Type | When it changes |
| --- | --- | --- |
| `bot.state` | `"idle" \| "listening" \| "thinking" \| "speaking"` | The bot transitions between phases of a turn. |
| `bot.history` | `Message[]` | Every time a turn user / assistant / system message is appended. |
| `bot.lastTurn` | `Turn \| null` | When a turn finishes. |
| `bot.interrupted` | `boolean` | Flips `true` when VAD-driven barge-in or a `bot.interrupt()` call cuts the in-flight turn short. Resets at the start of the next turn. |

```ts
import { effect } from "bun:signals";

effect(() => console.log(`bot is ${bot.state.get()}`));
effect(() => console.log(`history length=${bot.history.get().length}`));
```

## Persistent memory

Pass `memory: "/path/to/memory.sqlite"` (or `{ path: ... }`) and the conversation transcript persists across process restarts. Persisted user / assistant turns replay into `bot.history` on construct; the system prompt stays sourced from `opts.system` each load (so you can tweak it without rewriting the db).

```ts
const bot = await assistant.create({
  llm: "/models/...gguf",
  memory: "/var/lib/myapp/bot.sqlite",
});

await bot.ask("Remember that my dog's name is Rex.");
await bot.close();

// Later — same process, or a fresh one:
const bot2 = await assistant.create({ llm: "/models/...gguf", memory: "/var/lib/myapp/bot.sqlite" });
await bot2.ask("What did I just tell you about my dog?");
// → "You told me your dog's name is Rex."
```

`bot.memory` exposes the underlying store for direct inspection:

```ts
type MemoryStore = {
  load(): Message[];
  append(msg: Message): void;
  count(): number;
  clear(): void;
  close(): void;
};
```

The schema is one `turns(id, role, content, ts)` table. Auto-summarization (sliding window of raw turns + stack of summaries when context approaches `kvCacheSize`) is a tracked follow-up.

## Barge-in

While the bot is thinking or speaking, a rising edge on the listen stream's `vad.active` signal cuts the turn short — the chat-token loop stops pulling, the chunked-TTS loop bails out, ALSA's pending playback buffer is dropped via `spk.stop()`, and `bot.interrupted` flips `true`. The recorded `Turn` carries `interrupted: true` and whatever text the model produced before the cut.

This is automatic when the voice loop (`bot.run()` / `bot.turns()`) is in use. For programmatic interruption — UI cancel button, custom barge-in source, watchdog timer, etc. — call `bot.interrupt()`:

```ts
import { effect } from "bun:signals";

// Cut the bot off when the user clicks "stop":
cancelButton.onclick = () => bot.interrupt();

// Or wire any signal:
effect(() => {
  if (someUserSignal.get()) bot.interrupt();
});
```

`bot.interrupt()` is idempotent within a turn — repeated calls are no-ops until the next turn starts. The flag resets when the next turn begins; subscribe to `bot.interrupted` to catch the rising edge for UX (e.g., flash a "cancelled" indicator).

## Power-user escape hatches

The composed resources are reachable directly when you need to do something `bot` doesn't:

```ts
bot.llm        // bun:llm.LLM — call .chat / .generate / .embed / .prefix directly
bot.memory     // MemoryStore — query / clear out of band
```

Anything reachable via [`bun:llm`](llm/), [`bun:speech`](speech/), or [`bun:audio`](audio/) is reachable through `bot` too.

## Disposal

```ts
await using bot = await assistant.create({ ... });   // preferred
// — or —
const bot = await assistant.create({ ... });
try { await bot.run(); } finally { await bot.close(); }
```

`close()` is idempotent and tears down the mic, speaker, LLM, Whisper, and memory store in lockstep. After close, `ask` / `say` / `turns` / `run` reject with a clear message.

## What v1 ships

Per `PLAN-bun-assistant.md` build order, the core covers:

- `assistant.create` + `bot.run` / `turns` / `ask` / `say` / `close`
- The four reactive signals
- In-memory + sqlite-backed transcript
- Composition of every Tier-1 voice primitive (mic capture, VAD, STT, LLM, TTS, speaker)

## Deferred follow-ups

Tracked under [LYK-760](https://linear.app/lyku/issue/LYK-760) — none of these are blocking core use cases:

- **Wake word** — needs an `audio.wakeWord({ model, threshold })` Tier-1 primitive (LYK-739). Barge-in's already shipped; wake word's the second half of step 5.
- **RAG** — `knowledge: { dir, encoder, topK }` option. Pure-JS cosine over a `Float32Array` matrix is enough for corpora of <10k chunks; larger corpora wait for `bun:vector`.
- **Scheduled prompts** — `schedule: ScheduledPrompt[]` option. `setInterval` + `bot.ask()`, with a `scheduled: true` discriminant on `Turn`.
- **Vision / VLM turns** — `vision: VisionOpts` — `bun:camera` frame fed into a VLM turn. Blocked on `bun:llm` gaining VLM architecture support (LLaVA / Qwen-VL).

## Limits

- The voice loop expects ALSA on Linux. macOS (CoreAudio) and Windows (WASAPI) backends mount on the same surface in follow-ups.
- Whisper inference is the latency floor — `tiny.en` on CUDA gives roughly utterance-duration / 7 wall-clock. Streaming token-by-token replies don't hide this.
- Multi-process deployments share neither models nor memory. If you want to run a fleet, preload models in one process and route requests there, or share the memory sqlite via a network filesystem with the usual sqlite caveats.
