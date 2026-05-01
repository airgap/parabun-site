---
title: parabun:assistant
description: Three-line edge voice assistant. Composes parabun:audio + parabun:speech + parabun:llm with reactive signals and persistent memory.
---

```ts
import assistant from "parabun:assistant";
```

A Tier 2 facade. Composes [`parabun:audio`](/docs/audio/) (mic + speaker), [`parabun:speech`](/docs/speech/) (VAD + STT + TTS), and [`parabun:llm`](/docs/llm/) (Llama / Qwen2 inference) into a complete on-device voice loop. The 3-line case stays 3 lines; new fields unlock new capabilities, never remove defaults.

```ts
import assistant from "parabun:assistant";

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
  tools?: AssistantTool[];           // inline tools or para:mcp connections
  wakeWord?: string | WakeWordConfig;  // gate utterances on a phrase ("hey jetson")
  schedule?: ScheduledPrompt[];      // cron-driven self-initiated turns
  knowledge?: KnowledgeOptions;      // RAG over a local doc directory
};

type WakeWordConfig = {
  phrase: string | string[];
  match?: "contains" | "exact" | "fuzzy";  // default "contains"
  maxEdits?: number;                       // default 2 (fuzzy only)
  feedThrough?: boolean;                   // also pass the wake utterance to the LLM (default false)
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
| `tools` | Inline `{name,schema,run}` tools and/or `para:mcp` connections — the model can call them mid-turn. | The bot is a pure chat surface (still very useful, just no actuators). |
| `wakeWord` | The voice loop ignores utterances that don't carry the wake phrase. Re-arms after every turn. | The bot replies to every utterance the mic picks up. |
| `schedule` | Cron-driven self-initiated turns. Each fire calls `bot.ask(prompt)`; the resulting `Turn` carries `scheduled: true`. | The bot only speaks when spoken to. |
| `knowledge` | RAG over a local doc directory. Each user turn retrieves the top-K most-relevant chunks and prepends them to the prompt. `bot.knowledge.search(text, n)` and `.reindex()` exposed. | The model only knows what's in its own weights + this session's transcript. |

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
  scheduled: boolean;            // true if fired by the `schedule` option, not user / explicit ask
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

Every public signal is a [`para:signals`](https://para.script.dev/docs/signals/) Signal — wire them into a UI without polling. Each updates synchronously when its source changes; subscribe with `.subscribe(cb)` or read with `.get()`.

| Signal | Type | When it changes |
| --- | --- | --- |
| `bot.state` | `"idle" \| "listening" \| "thinking" \| "speaking"` | The bot transitions between phases of a turn. |
| `bot.history` | `Message[]` | Every time a turn user / assistant / system message is appended. |
| `bot.lastTurn` | `Turn \| null` | When a turn finishes. |
| `bot.interrupted` | `boolean` | Flips `true` when VAD-driven barge-in or a `bot.interrupt()` call cuts the in-flight turn short. Resets at the start of the next turn. |
| `bot.toolsActive` | `Set<string>` | Names of tool calls currently in flight. Synchronous transitions on dispatch start and end. |

```ts
import { effect } from "para:signals";

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

## Tools

Pass `tools: [...]` to give the model actuators. Each turn runs schema-constrained generation: the model picks a tool (or `null` for "I'm done"), supplies args, the runtime parses + dispatches, and the result is fed back as a synthetic message. The loop continues until the model emits a final reply. `Turn.toolCalls` records every dispatch.

Two tool shapes are accepted, mixed freely in the same array:

**Inline** — a `{ name, description?, schema, run }` descriptor:

```ts
const bot = await assistant.create({
  llm: "/models/...gguf",
  tools: [
    {
      name: "add",
      description: "Returns a + b.",
      schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      run({ a, b }) { return a + b; },
    },
  ],
});
```

`run` returns any JSON-serializable value. Async returns are awaited. Schema is the JSON Schema fed to grammar-constrained sampling; only structures the schema lib supports work (no recursive `oneOf`, no recursive `object`).

**MCP connections** — an object with `tools: ToolDescriptor[]` + `call(name, args)`. Every [`para:mcp`](https://para.script.dev/docs/mcp/) connection matches structurally:

```ts
import mcp from "para:mcp";
await using conn = await mcp.connect("stdio", "home-assistant-mcp");
await using bot = await assistant.create({
  llm: "/models/...gguf",
  tools: [conn],   // every tool the server exposes is callable mid-turn
});
```

The assistant flattens the MCP connection's tool list into its own catalog; calls route back through `conn.call`. Mix MCP connections with inline tools in the same `tools:` array.

Add or remove tools mid-session with `bot.addTool(tool)` / `bot.removeTool(name)`. `bot.tools` returns a snapshot of the current catalog (each entry tagged `source: "inline" | "mcp"`). `bot.toolsActive` is a `Signal<Set<string>>` carrying tool names currently in flight — wire it into a UI to show "calling get_weather…" badges.

The schema-constrained generator runs up to **8 iterations per turn** before forcing a final reply without the schema constraint, so a tool that keeps demanding more tool calls can't loop indefinitely.

## Barge-in

While the bot is thinking or speaking, a rising edge on the listen stream's `vad.active` signal cuts the turn short — the chat-token loop stops pulling, the chunked-TTS loop bails out, ALSA's pending playback buffer is dropped via `spk.stop()`, and `bot.interrupted` flips `true`. The recorded `Turn` carries `interrupted: true` and whatever text the model produced before the cut.

This is automatic when the voice loop (`bot.run()` / `bot.turns()`) is in use. For programmatic interruption — UI cancel button, custom barge-in source, watchdog timer, etc. — call `bot.interrupt()`:

```ts
import { effect } from "para:signals";

// Cut the bot off when the user clicks "stop":
cancelButton.onclick = () => bot.interrupt();

// Or wire any signal:
effect(() => {
  if (someUserSignal.get()) bot.interrupt();
});
```

`bot.interrupt()` is idempotent within a turn — repeated calls are no-ops until the next turn starts. The flag resets when the next turn begins; subscribe to `bot.interrupted` to catch the rising edge for UX (e.g., flash a "cancelled" indicator).

## Wake word

Pass `wakeWord: "hey jetson"` (or an object form for fuzzy matching / multiple phrases) and the voice loop will ignore utterances that don't carry the phrase. After a turn finishes, the gate re-arms — the user has to say "hey jetson, what's next?" rather than just "what's next?"

```ts
const bot = await assistant.create({
  llm: "/models/...gguf",
  stt: "/models/ggml-tiny.en.bin",
  tts: "/models/en_US-lessac-medium.onnx",
  wakeWord: "hey jetson",
});
await bot.run();
```

Object form for fuzzy matching, multiple phrases, or feed-through:

```ts
wakeWord: {
  phrase: ["hey jetson", "ok parabun"],
  match: "fuzzy",
  maxEdits: 2,
  feedThrough: true,    // pass the wake utterance to the LLM as the first turn
}
```

`feedThrough: false` (the default) consumes the wake utterance silently and waits for the *next* utterance — natural when users say "hey jetson \[pause\] what time is it?". `feedThrough: true` keeps the full transcription as the turn's user input — natural when users say "hey jetson, what time is it?" in one breath.

Implementation note: the gate is whisper-backed (it reuses the same model already loaded for `stt`, runs only on VAD-detected speech bursts) — not a sub-watt always-on KWS. Trade-offs and details are documented under [`speech.wakeWord`](/docs/speech/#wakewordopts). For battery-powered devices a future follow-up adds a dedicated KWS engine.

## Scheduled / proactive prompts

Pass `schedule: [{ cron, prompt }]` and the bot fires `bot.ask(prompt)` on each cron match. Standard 5-field cron syntax in local time. The resulting `Turn` carries `scheduled: true` so consumers can filter the transcript ("show me everything _I_ said") or route proactive turns differently in the UI (e.g., notification toast vs. inline log entry).

```ts
const bot = await assistant.create({
  llm: "/models/...gguf",
  tts: "/models/en_US-lessac-medium.onnx",
  schedule: [
    { cron: "0 8 * * *",       prompt: "Good morning. Tell me one thing on the news today." },
    { cron: "*/30 9-17 * * 1-5", prompt: "Anything I should be doing right now?" },
    { cron: "0 22 * * *",       prompt: "Wind-down summary please." },
  ],
});
await bot.run();
```

Field syntax: `*` (any), `N` (exact), `N-M` (range), `N,M` (list), `*/N` (step), `N-M/P` (range with step). Day-of-week is `0`-`6` with Sunday = `0`. Invalid cron strings throw at `assistant.create()` time — you find out before the timer is armed.

A scheduled fire is **skipped** if the bot is mid-turn (`state ≠ "idle" / "listening"`); the next minute retries. The schedule loop also skips if a previous scheduled prompt is still being served — proactive turns serialize on a single in-flight slot. Tear down at `bot.close()`.

`assistant.parseCron(expr)` and `assistant.cronMatches(spec, date)` are also exported for callers who want to wire their own scheduler against the same parser.

## Knowledge / RAG

Pass `knowledge: { dir, encoder, topK?, … }` and the bot indexes the directory at create time, then per user message retrieves the top-K most-relevant chunks and prepends them as a synthetic "Relevant context" system message inside the LLM working copy. Canonical history is **untouched** — the retrieved context is ephemeral to the turn and doesn't bias future retrievals.

```ts
const bot = await assistant.create({
  llm: "/models/...gguf",
  knowledge: {
    dir: "./notes",                                  // recursively walked
    encoder: "/models/bge-small-en-v1.5.gguf",       // sentence-embedding GGUF
    topK: 4,                                         // default
  },
});
await bot.ask("What did I write about hash maps last week?");
```

`encoder` is either a path to a sentence-embedding GGUF (BGE / E5 / MiniLM-class — anything `parabun:llm.Encoder.load` can open) or a pre-loaded `Encoder` instance. Use the pre-loaded form when you want one encoder shared across multiple bots / stores in the same process.

`KnowledgeOptions`:

```ts
type KnowledgeOptions = {
  dir: string;                                  // root, recursively walked
  encoder: string | Encoder;                    // path or pre-loaded
  topK?: number;                                // default 4
  chunkSize?: number;                           // default 800 chars
  chunkOverlap?: number;                        // default 100 chars
  extensions?: string[];                        // default [".md", ".markdown", ".txt", ".mdx"]
  maxFileBytes?: number;                        // default 1 MB
  watch?: boolean;                              // default true; auto-reindex on fs.watch
};
```

The chunker splits on paragraph boundaries (blank lines). Long paragraphs are broken into overlapping windows so a relevant sentence near a window edge isn't lost. Dotfiles / dotdirs (`.git`, `.obsidian`, `.notes`) are skipped silently — vendor folders shouldn't be eaten by the indexer. Files larger than `maxFileBytes` are skipped (binary/log noise filter).

`watch: true` (default) listens for changes via `fs.watch` and re-indexes after a 250 ms debounce. Set `watch: false` for ephemeral / test directories — the inotify thread can race on freed state during teardown otherwise.

`bot.knowledge` exposes the underlying store for direct use:

```ts
bot.knowledge.search("hash map open addressing", 6);  // KnowledgeHit[]
bot.knowledge.reindex();                              // force a rebuild
bot.knowledge.count;                                  // chunk count
bot.knowledge.dim;                                    // embedding dim
```

Each `KnowledgeHit` is `{ path, offset, text, score }` — `score` is cosine similarity in `[-1, 1]` (typically `[0, 1]` for normalized text vectors).

`assistant.chunkText(text, opts?)` and `assistant.KnowledgeStore` are also exported for callers who want to use the chunker / store standalone (search a doc dir without spinning up an assistant).

### Limits

- Pure-JS cosine over a `Float32Array` matrix. Fine for `<10k` chunks on a Pi 5; beyond that, the per-query scan starts costing real ms. A vector-DB MCP connection (or a future `bun:vector`) is the path for larger corpora.
- Indexing is one-shot — no persistent on-disk vector cache. A process restart re-embeds the whole corpus (and on a Pi 5 with BGE-small, a few thousand chunks is ~10–30 s). A simple sqlite-backed cache is a tracked follow-up.
- The encoder runs on whatever device `parabun:llm` picks. CPU is fine for embedding short chunks; the cost is mostly tokenization on the JS side.

## Power-user escape hatches

The composed resources are reachable directly when you need to do something `bot` doesn't:

```ts
bot.llm        // parabun:llm.LLM — call .chat / .generate / .embed / .prefix directly
bot.memory     // MemoryStore — query / clear out of band
bot.knowledge  // KnowledgeStore — search / reindex / introspect the RAG corpus
```

Anything reachable via [`parabun:llm`](/docs/llm/), [`parabun:speech`](/docs/speech/), or [`parabun:audio`](/docs/audio/) is reachable through `bot` too.

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

- `assistant.create` + `bot.run` / `turns` / `ask` / `say` / `close` / `interrupt`
- Reactive signals: `state`, `history`, `lastTurn`, `interrupted`, `toolsActive`
- In-memory + sqlite-backed transcript
- Tool dispatch: inline `{name,schema,run}` tools and `para:mcp` connections
- VAD-driven barge-in (and programmatic `bot.interrupt()`)
- Wake-word gate (whisper-backed; substring / exact / fuzzy matching)
- Cron-driven scheduled / proactive prompts
- RAG over a local doc directory (`KnowledgeStore` + `chunkText`)
- Composition of every Tier-1 voice primitive (mic capture, VAD, STT, LLM, TTS, speaker)

## Deferred follow-ups

Tracked under [LYK-760](https://linear.app/lyku/issue/LYK-760) — none of these are blocking core use cases:

- **Sub-watt KWS engine** — the v1 wake word is whisper-backed, which is honest about its CPU cost (only fires on VAD-detected speech bursts) but isn't a true always-on sub-watt KWS like Picovoice Porcupine or openWakeWord. Adding a dedicated engine option is a tracked follow-up; the surface here is engine-agnostic enough to absorb it.
- **Vision / VLM turns** — `vision: VisionOpts` — `parabun:camera` frame fed into a VLM turn. Blocked on `parabun:llm` gaining VLM architecture support (LLaVA / Qwen-VL).
- **Persistent vector cache** — RAG re-embeds the whole corpus on process restart. A sqlite-backed vector cache keyed by `(file mtime, chunk offset, encoder hash)` would cut Pi 5 cold-start by an order of magnitude.

## Limits

- The voice loop expects ALSA on Linux. macOS (CoreAudio) and Windows (WASAPI) backends mount on the same surface in follow-ups.
- Whisper inference is the latency floor — `tiny.en` on CUDA gives roughly utterance-duration / 7 wall-clock. Streaming token-by-token replies don't hide this.
- Multi-process deployments share neither models nor memory. If you want to run a fleet, preload models in one process and route requests there, or share the memory sqlite via a network filesystem with the usual sqlite caveats.
