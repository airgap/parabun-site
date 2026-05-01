---
title: ParaBun docs
description: Reference for the runtime modules and language extensions ParaBun adds to Bun.
---

ParaBun is a fork of Bun. Everything upstream Bun does — bundler, test runner, package install, Node compatibility — works the same. ParaBun adds a stack of built-in modules for parallel CPU work, GPU compute, codec / capture / inference workloads, and a few language-level desugarings on `.pts` / `.pjs` files.

**Targets edge devices and IoT** — Linux SBCs (Raspberry Pi 5, Jetson Orin), NUCs, and anything else running a real OS with capable CPU/GPU. The composed Tier 2 modules ([`parabun:assistant`](/docs/assistant/), [`parabun:speech`](/docs/speech/), [`parabun:vision`](/docs/vision/)) and the planned peripheral modules (`parabun:gpio` / `parabun:i2c` / `parabun:spi`) assume that shape: a device that's basically a small computer, with mic / camera / GPIO / network / GPU all reachable. Microcontrollers (Cortex-M, ESP32, RP2040) are out of scope — JavaScriptCore alone is bigger than an MCU's flash budget. For MCU-class work, parabun running on a nearby SBC can talk to the MCU over USB-serial / BLE via an MCP tool.

The sidebar groups pages into **Guides** (cross-cutting topics — install, language extensions, configurator, FAQ) and **Modules** (one page per `bun:*` import).

## Where to start

If you want a tour, the [landing page](/) walks the module stack top-down with worked examples. If you want to look something up, the module pages have full API references with signatures, semantics, and example code drawn from the source.

## Module overview

Three layers of dependency:

- **Tier 0 — primitives.** [para:simd](https://para.script.dev/docs/simd/), [parabun:gpu](/docs/gpu/), [para:parallel](https://para.script.dev/docs/parallel/), [para:arena](https://para.script.dev/docs/arena/), [para:pipeline](https://para.script.dev/docs/pipeline/), [para:signals](https://para.script.dev/docs/signals/), [para:rtp](https://para.script.dev/docs/rtp/). The numerical / structural / scheduling primitives the rest of the stack composes.
- **Tier 1 — codecs, capture & protocols.** [parabun:image](/docs/image/), [parabun:audio](/docs/audio/), [para:csv](https://para.script.dev/docs/csv/), [parabun:llm](/docs/llm/), [parabun:camera](/docs/camera/), [parabun:video](/docs/video/), [para:mcp](https://para.script.dev/docs/mcp/). Statically-linked codecs, OS hardware capture, the GGUF inference runtime, and a Model Context Protocol client.
- **Tier 2 — composed apps.** [parabun:speech](/docs/speech/) (Whisper STT + Piper TTS + VAD + wake word), [parabun:assistant](/docs/assistant/) (the 3-line edge voice assistant), [para:arrow](https://para.script.dev/docs/arrow/) (in-memory tables + IPC streaming), [parabun:vision](/docs/vision/). Use-case-shaped wrappers built on Tier 1.

Modules without engines wired (ONNX vision detectors, Parquet) throw at the engine boundary with a documented error message. Their interfaces are stable so callers can write against them now.

## Language extensions

[Language extensions](https://para.script.dev/docs/language/) covers the `.pts` / `.pjs` syntax: `pure` / `memo` declarators, `signal` / `effect` / `~>` reactive bindings, `|>` pipeline + inlining, `..!` / `..&` / `..=` suffix operators, and `defer` / `arena` block forms. All desugarings are parse-time and emit standard JS.

## Other reading

- [Configurator](/configure/) — pick which built-in modules to include in a `bun build --compile` output. Production binaries trim to whatever you check.
- [LLMs.md](https://github.com/airgap/parabun/blob/main/LLMs.md) — full grammar + architecture document, kept in sync with the implementation.
- [GitHub](https://github.com/airgap/parabun) — source, issues, releases.
