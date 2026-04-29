---
title: bun:llm
description: GGUF LLM inference, BERT sentence encoders, Whisper STT, and an OpenAI-compatible HTTP server — all built into the runtime.
---

```ts
import llm from "bun:llm";
```

`bun:llm` is an in-tree native inference stack. Models are `mmap`ped off disk; weights stay device-resident on CUDA / Metal so per-token traffic is a 4-byte argmax. Three model classes ship today:

- **LLM** — Llama 3 / Qwen2 family decoder-only models (chat + completion + grammar / JSON-schema constrained decoding).
- **Encoder** — BERT-style sentence embedders (BGE / E5 / MiniLM).
- **WhisperModel** — encoder-decoder speech-to-text (Whisper tiny / base / small / medium, English-only or multilingual).

Plus `llm.serve(...)` — an OpenAI-compatible HTTP wrapper that points any of the above at `:11434`.

## LLM — chat and completion

```ts
import { LLM } from "bun:llm";

using m = await LLM.load("./Llama-3.2-1B-Instruct-Q4_K_M.gguf");

for await (const piece of m.chat([
  { role: "system", content: "You are helpful and concise." },
  { role: "user", content: "What is the capital of France?" },
])) {
  process.stdout.write(piece);
}
```

### `LLM.load(path, opts?)`

Loads a GGUF file. Detects the architecture (`general.architecture`) and chat template (`tokenizer.chat_template`). Returns a `LLM` instance.

| Option | Default | Description |
| --- | --- | --- |
| `device` | auto | `"cuda"`, `"metal"`, or `"cpu"`. Auto-probes in `[metal, cuda, cpu]` order. |
| `kvCacheSize` | `4096` | Token capacity of the KV cache (per request). |

The instance is `Disposable` — `using m = ...` releases device buffers on scope exit. Manual `m[Symbol.dispose]()` works too.

### `m.chat(messages, opts?)`

Async iterator yielding text pieces. `messages` is an array of `{ role, content }` with `role` in `{system, user, assistant}`. The chat template detected from the GGUF wraps messages with the model's expected delimiters.

| Option | Default | Description |
| --- | --- | --- |
| `maxTokens` | `512` | Hard ceiling on generated tokens. |
| `stopTokens` | model-specific | Token IDs that end generation. Defaults to EOS + chat-template terminator (e.g. `<\|eot_id\|>`). Pass `[]` to disable. |
| `includePrompt` | `false` | Echo the rendered prompt as the first piece. |
| `temperature` | `0` | `0` = greedy / argmax. `>0` enables sampling. |
| `topK`, `topP` | — | Nucleus filter applied before sampling. |
| `seed` | random | Mulberry32 seed for reproducible sampling. |
| `grammar` | — | GBNF source. Only tokens that keep the grammar in an accept-able state are sampled. |
| `schema` | — | JSON Schema. Compiled to a grammar internally. |
| `logitBias` | — | `Map<tokenId, number>` added to logits before sampling. |
| `prefix` | — | Reuse a `PrefixCache` from `m.prefix(text)` to skip prefill on a shared system prompt. |

Mutually exclusive: pass either `grammar` *or* `schema`, not both.

### `m.chatJSON(messages, opts)`

Single-shot grammar-constrained chat: drains the streamed result, parses it as JSON, returns a typed object. Requires `opts.schema` or `opts.grammar` (the parse is guaranteed safe by the grammar layer; a thrown `SyntaxError` here means the schema doesn't fully constrain the output, which is a caller bug). Replaces the four-line accumulate-then-`JSON.parse` pattern.

```ts
const ToolSchema = {
  type: "object",
  properties: {
    tool: { type: "string", enum: ["setLight", "playMusic", "reply"] },
    args: { type: "object" },
  },
  required: ["tool", "args"],
};

const { tool, args } = await m.chatJSON<{ tool: string; args: any }>(
  [{ role: "user", content: "turn the kitchen light on" }],
  { schema: ToolSchema, maxTokens: 80 },
);
```

### `m.generate(prompt, opts?)`

Same options as `chat`, but takes a raw string. No template wrap — useful when you want the bare BPE-tokenizer / decoder pipeline.

### `m.embed(text)` *(if the GGUF has embedding tied weights)*

Returns the model's hidden state for the last token. Most decoder-only chat models don't expose this usefully — for sentence embeddings, use the `Encoder` class instead.

### `m.prefix(text)` / `m.prefixChat(messages)`

Returns a `PrefixCache` — the KV cache snapshot after running `text` (or the templated chat prefix) through the model. Pass it as `opts.prefix` on subsequent calls to skip the prefill cost. Useful when many requests share a common system prompt.

### Reactive signals

Each `LLM` instance exposes two [`bun:signals`](/docs/signals/) Signals — wire them into a UI to drive busy spinners and device badges without polling.

| Signal | Type | What it tracks |
| --- | --- | --- |
| `m.busy` | `boolean` | `true` while a `chat` / `generate` / `embed` / `prefix` call is in flight. Refcounted across nested calls so it reads correctly when one method calls another internally. |
| `m.device` | `"cuda" \| "metal" \| "cpu"` | Whichever backend the load probe selected. Stable for the life of the instance. |

```ts
import { effect } from "bun:signals";
effect(() => console.log(m.busy.get() ? "🤔" : "✅"));
```

`WhisperModel` exposes the same `busy` signal — it flips while a `transcribe` / `transcribeMel` is running, and stays correct when nested under a higher-level call (e.g. `bun:assistant`'s turn loop).

## Encoder — BERT-family sentence embeddings

```ts
import { Encoder } from "bun:llm";

using enc = await Encoder.load("./bge-small-en-v1.5.gguf");
const vec = enc.embed("hello world");          // Float32Array of dModel
const norms = enc.embedBatch(texts);           // Float32Array[]
```

Targets `general.architecture="bert"` GGUFs. Bidirectional attention, post-LN residuals, GELU FFN, WordPiece tokenizer. Pooling defaults to whatever the GGUF says; pass `{ pool: "cls" | "mean" }` to override. Outputs are L2-normalized by default — toggle with `{ normalize: false }`.

## WhisperModel — speech-to-text

```ts
import llm from "bun:llm";
import audio from "bun:audio";

const wav = audio.readWav(new Uint8Array(await Bun.file("clip.wav").arrayBuffer()));
const m = await llm.WhisperModel.load("./ggml-tiny.en.bin");
const text = m.transcribe(wav.samples, { language: "auto", beamSize: 5 });
```

Loads whisper.cpp `ggml-*.bin` files. Both formats supported:

- **English-only** (`tiny.en`, `base.en`, `small.en`, `medium.en`) — `nVocab=51864`, no language tokens. `language: "auto"` silently keeps `"en"`.
- **Multilingual** (`tiny`, `base`, `small`, `medium`, `large-v3`) — `nVocab=51865`, 99 language tokens, `language: "auto"` runs detection.

Tensor types: F32, F16, Q4_0, Q5_0, Q5_1, Q8_0. Quantized weights are dequantized at load time.

### `WhisperModel.load(path)`

Reads the `.bin`, transposes encoder + cross-attn weights for `gpu.matmul`, wraps decoder weights in `GpuFloat32Array` for `gpu.matVec`. The model object is reusable — load once per process and cache.

### `m.transcribe(audio, opts?)`

Single high-level call. `audio` is mono 16 kHz `Float32Array` PCM in `[-1, 1]`. Audio longer than 30 s is split into non-overlapping 30-second chunks; chunks below RMS=1e-4 are skipped. Whisper's literal silence annotations (`[BLANK_AUDIO]`, `[silent]`, `[music]`, `[inaudible]`) are stripped from the output.

| Option | Default | Description |
| --- | --- | --- |
| `language` | `"en"` | ISO-639-1 code, or `"auto"` to detect (multilingual only). |
| `maxTokens` | `224` | Per-chunk token ceiling. |
| `beamSize` | `1` | `1` = greedy. `>1` runs beam search with cumulative log-prob ranking and KV state forking. Cross-attn K/V is shared by reference across beams. |

### `m.transcribeMel(mel, T, opts?)`

Lower-level entry point. `mel` is a flat `[nMels, T]` row-major `Float32Array`. Use this when you've already computed the mel spectrogram (e.g. via [`audio.melSpectrogram(audio, { mode: "whisper" })`](/docs/audio/#mel-spectrogram)) or when integrating with a custom audio source.

### `m.detectLanguage(mel, T)` / `m.detectLanguageFromEncoder(encoded)`

Multilingual only. Runs the encoder + a single decoder step from `[<\|startoftranscript\|>]` and picks the language token with the highest logit. Returns `{ language: string, prob: number }`.

### Performance

Release build, NVIDIA RTX 4070 Ti, JFK 11-second sample on `ggml-tiny.en`:

| Stage | Time | Notes |
| --- | --- | --- |
| CPU debug, no cache | 93 s | Original implementation. |
| + KV cache | 29 s | Cross-attn K/V cached per encode; self-attn K/V appended per step. |
| + release build | 14.8 s | JIT optimizations. |
| + CUDA encoder + decoder | 1.6 s | Encoder im2col conv + matmuls + per-head batched attention; decoder per-token matVecs + LM head. |

`base.en` (4× the parameters of `tiny.en`) runs in 3.07 s for 11 s of audio (~3.6× real-time). Beam search ≥ 2 typically adds <10% wall-clock thanks to early termination when no active beam can catch up to a finished one.

## llm.serve — OpenAI-compatible HTTP server

```ts
import llm from "bun:llm";

const m = await llm.LLM.load("./Llama-3.2-1B-Instruct-Q4_K_M.gguf");
llm.serve({ engine: m, modelId: "llama-3.2-1b", port: 11434 });
```

Routes:

- `GET /v1/models` — lists `[{ id: modelId, object: "model" }]`.
- `POST /v1/chat/completions` — sync (default) and SSE streaming (`stream: true`). Maps `messages` straight into `engine.chat`.
- `POST /v1/completions` — wraps `engine.generate`.
- `POST /v1/embeddings` — wraps `engine.embed`. Useful with the `Encoder` class.

Default port is 11434, matching ollama. Optional `apiKey` enables `Authorization: Bearer ...` checks. `maxConcurrent` (default 1) is a FIFO concurrency gate — useful when single-GPU inference doesn't pipeline.

The `engine` argument is duck-typed: anything with `.chat()` / `.generate()` / `.embed()` works. Plug in fakes / test doubles for local dev.

## Low-level building blocks

When the high-level classes don't fit, the underlying components are exported:

- **GGUF parser**: `loadGGUF`, `GGUFFile`, `GGML_TYPE_*` constants.
- **Llama internals**: `LlamaModel`, `KVCache`, `llamaFromGGUF`, `argmax`, `Sampler`, `sample`, `LlamaTokenizer`, `tokenizerFromGGUF`.
- **Constrained decoding**: `parseGBNF`, `compileSchema`, `Grammar`.
- **BERT internals**: `BertModel`, `BertTokenizer`, `bertFromGGUF`, `bertTokenizerFromGGUF`.
- **Whisper internals**: `WhisperTokenizer`, `readBinModel`.

Use them when you want to drive the forward pass yourself, share weights across instances, or stream KV-cache snapshots between requests.

## Limits

- Decoder-only LLM forward pass is single-stream (no batched generation). `maxConcurrent: 1` in `serve()` reflects this.
- Whisper decoder is single-beam-aware but the encoder forward is one-shot — there's no streaming-aware encoder yet, so live-mic transcription works by VAD-segmenting the input ([`speech.listen`](/docs/speech/)) and transcribing each utterance independently.
- Q5_K, Q6_K, Q4_K, Q3_K, Q2_K matVec kernels are CUDA-only today. Metal mirrors are pending.
- LLM tied embeddings (`output.weight` referencing the input embedding) are detected and shared. Untied embeddings work too — both load paths exist.
