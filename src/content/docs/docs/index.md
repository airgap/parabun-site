---
title: Parabun docs
description: Reference for the runtime modules and language extensions Parabun adds to Bun.
---

Parabun is a fork of Bun. Everything upstream Bun does — bundler, test runner, package install, Node compatibility — works the same. Parabun adds a stack of built-in modules for parallel CPU work, GPU compute, codec / capture / inference workloads, and a few language-level desugarings on `.pts` / `.pjs` files.

The sidebar groups pages into **Guides** (cross-cutting topics — install, language extensions, configurator, FAQ) and **Modules** (one page per `bun:*` import).

## Where to start

If you want a tour, the [landing page](/) walks the module stack top-down with worked examples. If you want to look something up, the module pages have full API references with signatures, semantics, and example code drawn from the source.

## Module overview

Three layers of dependency:

- **Tier 0 — primitives.** [bun:simd](/docs/simd/), [bun:gpu](/docs/gpu/), [bun:parallel](/docs/parallel/), [bun:arena](/docs/arena/), [bun:pipeline](/docs/pipeline/), [bun:signals](/docs/signals/), [bun:rtp](/docs/rtp/). The numerical / structural / scheduling primitives the rest of the stack composes.
- **Tier 1 — codecs & capture.** [bun:image](/docs/image/), [bun:audio](/docs/audio/), [bun:csv](/docs/csv/), [bun:llm](/docs/llm/), [bun:camera](/docs/camera/), [bun:video](/docs/video/). Statically-linked codecs and OS hardware capture, plus the GGUF inference runtime.
- **Tier 2 — composed apps.** [bun:speech](/docs/speech/) (Whisper STT + Piper TTS + VAD), [bun:assistant](/docs/assistant/) (the 3-line edge voice assistant), [bun:arrow](/docs/arrow/) (in-memory tables + IPC streaming), [bun:vision](/docs/vision/). Use-case-shaped wrappers built on Tier 1.

Modules without engines wired (ONNX vision detectors, Parquet) throw at the engine boundary with a documented error message. Their interfaces are stable so callers can write against them now.

## Language extensions

[Language extensions](/docs/language/) covers the `.pts` / `.pjs` syntax: `pure` / `memo` declarators, `signal` / `effect` / `~>` reactive bindings, `|>` pipeline + inlining, `..!` / `..&` / `..=` suffix operators, and `defer` / `arena` block forms. All desugarings are parse-time and emit standard JS.

## Other reading

- [Configurator](/configure/) — pick which built-in modules to include in a `bun build --compile` output. Production binaries trim to whatever you check.
- [LLMs.md](https://github.com/airgap/parabun/blob/main/LLMs.md) — full grammar + architecture document, kept in sync with the implementation.
- [GitHub](https://github.com/airgap/parabun) — source, issues, releases.
