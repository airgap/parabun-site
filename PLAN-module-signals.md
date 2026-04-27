# Signals across the parabun module surface — Plan

`bun:assistant` exposes its state as `bun:signals` `Signal` instances ([see plan](PLAN-bun-assistant.md#parabun-syntax-integration)). For that to feel like a coherent stack rather than a one-off, every long-lived parabun resource should do the same — devices, model handles, capture streams, worker pools — so `effect { ... }` reactive composition works across module boundaries instead of stopping at the assistant facade.

This is a cross-cutting retrofit, not a single refactor. Each module gets its own pass. APIs stay backward-compatible: signals are *added*, never replacing existing iterators / promises / events.

---

## Goal

Any parabun resource with state that changes over time exposes that state as `Signal` instances. Plain JS / TS code subscribes via `.subscribe(cb)` / `.get()`; parabun code uses `effect { ... }` and `~>` over the same primitive. The result is one consistent reactive surface across `bun:audio`, `bun:camera`, `bun:speech`, `bun:llm`, `bun:vision`, `bun:rtp`, `bun:gpu`, `bun:parallel`, and `bun:assistant` — not a special carve-out for the assistant module.

## Why now

- **`bun:assistant` will compose multiple modules' state in `effect`s.** A motion sensor (`bun:vision`) gating an LLM call (`bun:llm`) gating a TTS reply (`bun:speech`) only reads cleanly if all three modules speak the same reactive language.
- **MCP / IoT use cases are inherently event-driven.** Jetson/RPi assistants react to sensor pulses, not request/response flows. Signals match the problem shape.
- **Cost is small per module.** Each module exposes 1–4 Signals; underlying state already exists. The work is wrapping it, not computing it.

---

## Design rules

1. **Additive only.** Existing iterators (`mic.frames()`), promises (`m.chat(...)`), and methods (`mic.devices()`) keep working unchanged. Signals are a new surface alongside them. No deprecations in this pass.
2. **No fake reactivity.** A Signal must update from a real event source — a device callback, a frame arrival, a state transition. Never poll-and-emit on a timer to simulate reactivity. If state isn't actually observable, don't expose a Signal for it.
3. **Lifecycle-bound to the resource.** Instance-level signals (e.g. `mic.peakLevel`) become inert when the resource is disposed. Subscribers stop receiving updates; the signal's last value is whatever it held at dispose time. No errors thrown for late subscribers.
4. **Module-level signals stay live for the process.** Things like `audio.devices` (the global ALSA device list) live at module scope; they update when the OS plug/unplug events fire and never need disposal.
5. **Naming convention.** Match the property style of the rest of the module. Boolean state ends in a verb-form (`busy`, `active`, `interrupted`); collections are plural (`devices`, `tools`); scalars are noun-forms (`peakLevel`, `noiseFloor`, `contextUsed`). All Signal-typed properties are documented with the `Signal<T>` type in the docs page.
6. **Don't wrap pure compute.** Modules that operate on immutable data (`bun:image`, `bun:simd`, `bun:arrow`) get nothing — there's no observable state to expose.

---

## Per-module audit

| Module | Signals to expose | Notes |
|---|---|---|
| **`bun:audio`** | `audio.devices: Signal<DeviceInfo[]>` (module-level, OS device list) <br> `mic.peakLevel: Signal<number>` (per-frame RMS, normalized) <br> `mic.active: Signal<boolean>` (true while frames are flowing) <br> `spk.queuedMs: Signal<number>` (playback buffer depth) | `mic.peakLevel` lights up VU meters and barge-in heuristics for free. `audio.devices` needs ALSA hotplug subscription (udev / inotify on `/dev/snd/`). |
| **`bun:camera`** | `camera.devices: Signal<DeviceInfo[]>` <br> `cam.active: Signal<boolean>` <br> `cam.fps: Signal<number>` (rolling) <br> `cam.format: Signal<{ width, height, pixelFormat }>` | V4L2 already emits format-change events; wire them to the signal. fps is a rolling window over frame timestamps — emit on each frame. |
| **`bun:speech`** | `vad.active: Signal<boolean>` (currently inside a speech burst) <br> `vad.noiseFloor: Signal<number>` <br> `vad.lastUtterance: Signal<Utterance \| null>` | These already exist as internal state inside `speech.listen`; just expose them on the returned iterator object. |
| **`bun:llm`** | `m.busy: Signal<boolean>` (mid-generation) <br> `m.contextUsed: Signal<number>` (KV cache occupancy in tokens) <br> `m.device: Signal<"cuda" \| "metal" \| "cpu">` <br> `whisper.busy: Signal<boolean>` | `busy` lets a UI dim while generation runs; `contextUsed` lets `bun:assistant` decide when to summarize. `m.device` is mostly static but can flip if CUDA goes OOM and falls back. |
| **`bun:vision`** | `motion.detected: Signal<boolean>` <br> `motion.score: Signal<number>` (most recent frame-diff magnitude) | Already a streaming detector; promote internal state to signals. Other vision engines (detect / OCR) get signals once their stubs ship. |
| **`bun:rtp`** | `session.connected: Signal<boolean>` <br> `session.jitterMs: Signal<number>` <br> `session.lossRate: Signal<number>` (rolling % over last N packets) | Jitter buffer already tracks all three internally. |
| **`bun:gpu`** | `gpu.devices: Signal<GpuDevice[]>` <br> `gpu.memUsed: Signal<number>` (per-device, by id) | Static-ish but valuable for monitoring. Skip per-kernel telemetry — too granular. |
| **`bun:parallel`** | `pool.workers: Signal<number>` (active worker count) <br> `pool.queued: Signal<number>` <br> `pool.inflight: Signal<number>` | Useful for backpressure UIs and tests. Mostly relevant once `bun:parallel` v2 lands with the persistent worker pool. |
| **`bun:pipeline`** | `pipeline.stages: Signal<{ name, throughput, backpressure }[]>` | One signal carrying a snapshot of all stages. Avoid one-signal-per-stage explosion. |
| **`bun:assistant`** | `bot.state`, `bot.lastTurn`, `bot.toolsActive`, `bot.history`, `bot.interrupted` | Defined in [PLAN-bun-assistant.md](PLAN-bun-assistant.md#signals-exposed-on-assistant). Naturally composes with all of the above. |
| **Skipped** | `bun:image`, `bun:simd`, `bun:arrow`, `bun:csv`, `bun:arena` | Pure compute or immutable data structures. No observable state worth exposing. |

---

## Build order

Roughly value-per-effort, biased toward unblocking `bun:assistant`:

1. **`bun:audio`** — `mic.peakLevel`, `mic.active`, `spk.queuedMs`. Highest leverage: feeds barge-in (`bun:assistant`) and VU meters / status lights (everyone).
2. **`bun:llm`** — `m.busy`, `m.contextUsed`, `m.device`. Required for the assistant's auto-summarization heuristic. Easy — the state already exists.
3. **`bun:speech`** — `vad.active`, `vad.lastUtterance`. Promote internal `listen` state to the iterator object.
4. **`bun:camera`** — `cam.active`, `cam.fps`, `cam.format`. Self-contained.
5. **`bun:vision`** — `motion.detected`, `motion.score`. Trivial once `bun:camera` lands.
6. **`bun:audio.devices`** (module-level) + `bun:camera.devices`. Needs hotplug wiring (udev on Linux, IOKit on macOS, WM_DEVICECHANGE on Windows). Modest implementation cost; high "feels alive" payoff.
7. **`bun:rtp`** — connectivity + quality signals. Slot in alongside the existing jitter buffer telemetry.
8. **`bun:gpu`**, **`bun:parallel`**, **`bun:pipeline`** — mostly diagnostic. Ship after the user-facing ones land and people start asking for them.

---

## Open decisions

- **Module-level signals — where do they live?** Two options: as exported names (`import { devices } from "bun:audio"`) or as properties on the default export (`audio.devices`). Recommend the property form for consistency with the rest of the module's surface; keeps the named-export path clean for stateless functions.
- **Hotplug detection on Linux.** udev requires libudev or watching `/sys/class/sound`. The latter is dependency-free but coarser; the former needs a small native binding. Ship the inotify version first, upgrade to libudev if accuracy complaints come in.
- **`fps` / `peakLevel` update rate.** Emitting per-frame is technically right but floods effects on a busy mic / 60-fps camera. Recommend: emit at most every 100 ms (rate-limit at the signal layer, not the consumer). Document the rate.
- **`Signal<Utterance | null>` vs separate event surface for `vad.lastUtterance`.** Signals shine for *state*; utterances are more *events*. Counter-argument: a signal carrying the most-recent utterance still works for state-shaped consumers ("show the last thing the user said"), and event-shaped consumers can read inside an effect that triggers per-write. Lean toward signal; revisit if the API feels strained in practice.
- **Backwards-compat for module-level state.** `audio.devices()` is currently a function returning a Promise. The new `audio.devices` property is a `Signal<DeviceInfo[]>`. These collide on the name. Options: (a) rename the function to `audio.listDevices()`, (b) make the signal `audio.devicesSignal`, (c) make `audio.devices` polymorphic — callable as a function for the one-shot, with `.get()` / `.subscribe()` for the reactive surface. Recommend (c) — `bun:signals` signals are *already* callable, so this collapses to "make `audio.devices` a Signal that, when called, returns its current value." Same shape as the rest.
- **Testing.** Each module's signals need unit tests for the `update on change / no-update on no-change / inert after dispose` invariants. Probably worth a tiny shared `@parabun/testing/signals` helper (deepEqual emit count, last-value assertions). Out of scope for v1 — start with per-module tests using the existing test infra.

---

## Relationship to other plans

- **[PLAN-bun-assistant.md](PLAN-bun-assistant.md)** — depends on this. The assistant module assumes the underlying modules are signals-aware so `effect { ... }` blocks can reach across boundaries. Build order: this plan's items 1–3 (audio, llm, speech) must land before `bun:assistant` core ships.
- **PROPOSALS.md (in `/raid/parabun`)** — independent. Language-level extensions are orthogonal to module-level state. The `signal` / `effect` / `~>` desugarings already exist; this plan just gives them more interesting things to point at.
