# `bun:assistant` — Plan

A Tier-2 facade module that composes `bun:audio` + `bun:speech` + `bun:llm` (+ future `bun:mcp`, `bun:camera`) into a complete edge AI assistant in three lines, while leaving the underlying modules accessible for power users.

Lives in the same family as `bun:vision` and `bun:speech` — application-shaped orchestration over Tier-1 primitives. Implementation lands after the current `/raid/parabun` work wraps. This doc is the working spec; refine in place as decisions get made.

---

## Goal

Make the simple case trivially simple. A working voice assistant on a Pi or Jetson should look like this:

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

Everything beyond that — wake words, vision, persistent memory, RAG, tools, scheduled prompts — lights up by adding a single field to the config. Nothing required, nothing surprising.

## Design rules (don't break these)

1. **Pure facade.** `bun:assistant` does not ship novel inference, novel I/O, or novel codecs. Every capability composes existing `bun:*` modules. If a feature requires a new primitive, that primitive ships in its own module first.
2. **Opt-in, not opt-out.** The 3-line case stays 3 lines. New capabilities are unlocked by adding fields, never by removing defaults.
3. **Iterators all the way down.** The primary control surface is `bot.turns()` — an async iterator yielding turn objects. Anything `bot.run()` does internally must be observable through `turns()` for users who want logging or orchestration.
4. **No hidden state outside `bot`.** Everything the assistant knows lives on the `bot` instance — disposed deterministically by `await using`. No process-global caches.
5. **Power users keep their seat.** Anything `bun:assistant` does is also doable by hand against `bun:llm` / `bun:speech` / `bun:audio` / `bun:mcp` directly. The facade is additive, never a wall.

---

## API surface

### `assistant.create(opts)`

Returns an `AsyncDisposable` `Assistant` instance. All fields except `llm` are optional.

```ts
type AssistantOptions = {
  // — required
  llm: string;                     // path to GGUF

  // — voice (omit any to drop that leg of the loop)
  stt?: string;                    // whisper.cpp ggml-*.bin
  tts?: string;                    // piper voice .onnx, or other TTS engine
  mic?: AudioCaptureOpts;          // defaults: { sampleRate: 16000, channels: 1 }
  speaker?: AudioPlayOpts;         // defaults match TTS engine output rate
  system?: string;                 // system prompt
  llmOpts?: LLMLoadOpts;           // forwarded to LLM.load
  chatOpts?: ChatOpts;             // forwarded to m.chat (temperature, schema, etc.)

  // — natural conversation
  interruptible?: boolean;         // barge-in: TTS halts when speech.listen flags new audio
  wakeWord?: string | WakeWordOpts;// gates speech.listen on a low-power keyword spotter

  // — persistent context
  memory?: string | MemoryOpts;    // sqlite path; auto-summarizes near kvCacheSize
  knowledge?: KnowledgeOpts;       // RAG: dir + encoder + topK

  // — multimodal
  vision?: VisionOpts;             // bun:camera frame fed to a VLM turn (when bun:llm gains VLM support)

  // — tools
  tools?: Tool[];                  // mix of MCP connections and inline JS functions

  // — proactive
  schedule?: ScheduledPrompt[];    // cron-driven self-initiated turns
};
```

### `bot.run()`

Runs the duplex loop forever. Equivalent to `for await (const _ of bot.turns()) {}`.

### `bot.turns()`

Async iterator yielding `Turn` objects:

```ts
type Turn = {
  user: string;                    // transcribed text (or null for proactive turns)
  assistant: string;               // generated reply
  toolCalls: { name: string; args: unknown; result: unknown }[];
  startedAtMs: number;
  endedAtMs: number;
  interrupted: boolean;            // true if barge-in cut the reply short
};
```

### `bot.say(text)` / `bot.ask(text)`

Manual injection — useful for tests, CLI tools, or scheduled prompts. `say` speaks without a user turn; `ask` runs a full LLM turn from text input (no STT).

### `bot.tools` / `bot.memory` / `bot.knowledge`

Live accessors for runtime introspection / mutation. Add a tool mid-session, query the memory store, re-index the knowledge dir.

---

## Common functionalities

| Feature | Maps to | Notes |
|---|---|---|
| **STT** | `bun:llm` `WhisperModel` + `bun:speech.listen` | Already shipped. Assistant just wires them together. |
| **LLM** | `bun:llm` `LLM` | Already shipped. Assistant manages the chat history + context window. |
| **TTS** | `bun:speech.speak` | Stub today; assistant blocks on this landing. Sentence chunking moves into `speech.speak` (see PLAN below). |
| **Mic / speaker** | `bun:audio.capture` / `bun:audio.play` | Already shipped on ALSA; CoreAudio + WASAPI follow. |
| **Wake word** | `bun:audio` framing + a small KWS model | Need a Tier-1 primitive: `audio.wakeWord({ model, threshold })` returning an async iterable of trigger events. Picovoice Porcupine or openWakeWord-style. Runs continuously; gates `speech.listen` so the LLM is idle until invoked. |
| **Barge-in** | `bun:speech.listen` event during TTS playback | Assistant subscribes to `speech.listen` while TTS is streaming; on first speech frame, flushes the speaker buffer and cancels the in-flight `m.chat` iterator. |
| **Persistent memory** | `bun:sqlite` (already in Bun) | Schema: turns table (rowid, role, content, ts) + summaries table (range, summary). Assistant auto-summarizes when context approaches `kvCacheSize`, keeps a sliding window of raw turns + a stack of summaries. |
| **RAG** | `bun:llm` `Encoder` + cosine over a flat index | For small corpora (<10k chunks), a pure-JS cosine over a `Float32Array` matrix is fine on a Pi. Larger corpora can wait for `bun:vector` (or punt to an MCP-served vector DB). |
| **Vision** | `bun:camera` + a VLM in `bun:llm` | Blocked on `bun:llm` gaining VLM architecture support (LLaVA / Qwen-VL family). Pencil in the option; implement when the loader exists. |
| **Tools** | `bun:mcp` (new) + `m.chat({ schema })` | Tools render into the system prompt as a JSON-schema-described function list. Grammar-constrained sampling produces a structured tool call; the dispatcher routes to the matching MCP server or inline function and feeds the result back as a tool message. |
| **Scheduled prompts** | `setInterval` / `node:timers` + the assistant's own `bot.ask()` path | Fires a self-initiated turn on the cron schedule. The user-facing turn shape includes a `scheduled: true` discriminant. |
| **Reactive state** | `bun:signals` `Signal` instances on the bot | `bot.state`, `bot.lastTurn`, `bot.toolsActive`, etc. — see the parabun-syntax section. .ts users get plain `.subscribe()` / `.get()`; .pts users get `effect` / `~>` sugar over the same primitives. |

---

## Parabun syntax integration

Assistant state is fundamentally reactive — it changes on every utterance, every tool call, every sensor reading flowing in via MCP. Rather than inventing a callback API, expose state as `bun:signals` `Signal` instances on the `Assistant` instance. `.ts` / `.js` users see them as plain observables; `.pts` / `.pjs` users get the `signal` / `effect` / `~>` syntax sugar for free over the same primitive.

### Signals exposed on `Assistant`

```ts
bot.state:        Signal<"idle" | "listening" | "thinking" | "speaking">
bot.lastTurn:     Signal<Turn | null>
bot.toolsActive:  Signal<Set<string>>     // tool names currently in flight
bot.history:      Signal<Message[]>       // full conversation, updates per turn
bot.interrupted:  Signal<boolean>         // true while a barge-in is being processed
```

Same shape, two ergonomics:

```ts
// .ts user — never touches parabun syntax
bot.state.subscribe(s => console.log(`bot is ${s}`));
const current = bot.state.get();
```

```ts
// .pts user — sugar over the same Signal instances
effect { console.log(`bot is ${bot.state}`); }
bot.state ~> ui.statusBadge;

// MCP-fed sensor signals compose naturally with assistant signals
signal motion = sensors.pir;
signal temp = sensors.temperature;
effect {
  if (motion && temp > 28) bot.ask("Want me to turn on the AC?");
}
```

### Other parabun extensions that compose well

- **`memo` for tool dispatch.** `memo pure async function weatherFor(city)` gives you tool-result caching by argument identity — meaningful on edge devices where every roundtrip costs latency + power. Purely additive sugar; .ts users write the equivalent `Map`-cache wrapper themselves if they want it.
- **`|>` for prompt construction.** `userText |> sanitize |> withRagContext(_) |> bot.ask` reads cleanly when chaining transforms. Pure DX win; no API impact.
- **`..!` / `..&` / `..=`.** Standard-form async sugar over the same Promise APIs `bot.ask` etc. return. Works in .pts, irrelevant in .ts.
- **`defer`.** Mostly subsumed by `await using bot = ...` for the bot itself. Useful inside `bot.tools` callbacks for per-call cleanup.
- **`arena`.** Not a strong fit at the assistant layer — model lifecycles are managed by `using` on the underlying `LLM` / `WhisperModel` instances, which already free GPU buffers on dispose.

### Hard rule

`bun:assistant` takes a runtime dep on `bun:signals`, but **must not** require parabun syntax to be usable. Every signal-typed property must be reachable through plain `.get()` / `.subscribe()` / `.set()` JS calls. If a feature only works in .pts, it doesn't belong in this module — push it into a parabun-extension example or a separate `.pts`-only helper.

---

## MCP integration

A separate `bun:mcp` module ships first. Scope for v1:

- **Client only.** Connect to existing MCP servers; do not host servers.
- **Two transports**: `stdio` (spawn a subprocess) and `ws` (WebSocket). HTTP/SSE later.
- **Surface**:
  ```ts
  const conn = await mcp.connect("stdio", "home-assistant-mcp", { args: [...], env: {...} });
  conn.tools;                   // ToolDescriptor[] — name, description, JSON schema
  await conn.call(name, args);  // dispatched to the server, returns the tool's result
  ```
- **No auth wrapper in v1.** If a server needs auth, the user passes credentials via env / args. We don't try to standardize OAuth.

`bun:assistant` consumes connections: every entry in `tools[]` is either an `mcp.Connection` (whose `tools` are flattened into the assistant's tool list) or a plain `{ name, schema, run }` descriptor. Both types route through the same dispatcher.

Hosting MCP servers from inside parabun is a separate, later proposal — useful for "Pi exposes its sensors as MCP tools to a remote orchestrator" but not v1.

---

## Where the line is

**In `bun:assistant`:** anything that's the same orchestration pattern repeated by every IoT user — wake-gating, barge-in, history + summarization, RAG, tool dispatch, scheduled prompts. These are thin glue, not new primitives.

**Outside `bun:assistant`:**
- New I/O surfaces (display rendering, robotics motor control, BLE, GPIO) — each gets its own `bun:*` module. The assistant calls them via MCP tools.
- New inference architectures (VLMs, diffusion, CLIP) — extend `bun:llm`, then assistant picks them up.
- Cloud LLM fallbacks — add a `cloud: { provider, key }` option later if local inference proves insufficient on small devices. Not v1 — first prove the local-only story works.

---

## Build order

1. **`speech.speak` ships** (Piper or ONNX). Blocking dependency for the entire module. Sentence chunking from the demo moves into `speech.speak`'s implementation — it accepts `string | AsyncIterable<string>` and yields f32 frames per sentence.
2. **`bun:assistant` core** — the 3-line case. `assistant.create({ llm, stt, tts, system })` + `bot.run()` + `bot.turns()`. No wake word, no tools, no memory yet. Proves the facade compiles cleanly over the existing modules.
3. **Tools + `bun:mcp`** — ship `bun:mcp` (stdio + ws client), then thread tool dispatch through the assistant's chat loop. This is the unlock for IoT control on Jetson/RPi.
4. **Memory** — sqlite-backed history + auto-summarization. Without this the assistant forgets between runs.
5. **Wake word + barge-in** — the two features that move the experience from "press Enter and talk" to "ambient assistant." Wake word needs the new `audio.wakeWord` primitive in `bun:audio` first.
6. **RAG** — `knowledge` option. Cheap once `Encoder` is in place; mostly a small in-memory cosine index.
7. **Scheduled prompts** — last because it's the easiest, and the user can already do it manually via `bot.ask()`.
8. **Vision** — when `bun:llm` gains VLM loading. Out of band with this plan.

---

## Open decisions

- **Module name.** `bun:assistant` reads cleanly but is broad. Alternatives: `bun:agent` (fits MCP terminology but conflicts with "agent" in other contexts), `bun:bot` (too informal). Recommend `bun:assistant`; revisit after the API stabilizes.
- **`turns()` vs callbacks.** Settled on iterators above; double-check this against the wake-word + barge-in flows where timing matters. If a tap-style observer is needed, add `bot.on("user-speech" | "tool-call" | ...)` as a secondary surface — don't replace iterators.
- **History serialization format for `memory`.** Use the OpenAI message shape (`{role, content}`) verbatim, even though parabun's `m.chat` uses the same shape. Forward-compatible with cloud fallbacks if those ever land.
- **Sentence chunking heuristic.** The regex `/[^.!?]*[.!?](\s|$)/` covers English; non-English needs a different boundary set. Start with English, document the limit, accept a `chunker?: (stream) => AsyncIterable<string>` escape hatch on `speech.speak` when this becomes a real complaint.
- **Interrupt semantics.** When TTS is cut by barge-in, does the assistant retain what was spoken in `history.assistant`, what was generated, or both? Recommend: store what was *generated* (so the LLM has accurate self-context), expose `turn.interrupted: true` so callers know the audio was truncated.
- **Multi-user / speaker ID.** Out of scope for v1. If it lands later, it sits as a `speakers?: SpeakerIdOpts` field that adds a per-turn `speakerId` to `Turn` and routes per-speaker history.

---

## Docs site integration

When the module ships, this plan migrates to `docs/assistant.md` (matching the format of the other module pages — frontmatter title + tagline + section: "modules"). The `bun:mcp` module gets `docs/mcp.md`. Both fold into the existing per-module reference page system that `build.ts` renders.

Until then, this file is a working document. Keep it in sync as decisions firm up.
