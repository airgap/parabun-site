---
title: Parabun docs
tagline: Reference for the runtime modules and language extensions Parabun adds to Bun.
section: guides
---

Parabun is a fork of Bun. Everything upstream Bun does — bundler, test runner, package install, Node compatibility — works the same. Parabun adds a stack of built-in modules for parallel CPU work, GPU compute, codec / capture / inference workloads, and a few language-level desugarings on `.pts` / `.pjs` files.

The sidebar groups pages into **Guides** (cross-cutting topics — install, language extensions, configurator, FAQ) and **Modules** (one page per `bun:*` import).

## Where to start

If you want a tour, the [landing page](../) walks the module stack top-down with worked examples. If you want to look something up, the module pages have full API references with signatures, semantics, and example code drawn from the source.

## Module overview

Three layers of dependency:

- **Tier 0 — primitives.** [bun:simd](simd/), [bun:gpu](gpu/), [bun:parallel](parallel/), [bun:arena](arena/), [bun:pipeline](pipeline/), [bun:signals](signals/), [bun:rtp](rtp/). The numerical / structural / scheduling primitives the rest of the stack composes.
- **Tier 1 — codecs & capture.** [bun:image](image/), [bun:audio](audio/), [bun:csv](csv/), [bun:llm](llm/), [bun:camera](camera/), [bun:video](video/). Statically-linked codecs and OS hardware capture, plus the GGUF inference runtime.
- **Tier 2 — composed apps.** [bun:vision](vision/), [bun:speech](speech/), [bun:arrow](arrow/). Use-case-shaped wrappers built on Tier 1.

Modules without engines wired (Whisper *was* a stub, Piper / ONNX vision detectors / Parquet still are) throw at the engine boundary with a documented error message. Their interfaces are stable so callers can write against them now.

## Language extensions

[Language extensions](language/) covers the `.pts` / `.pjs` syntax: `pure` / `memo` declarators, `signal` / `effect` / `~>` reactive bindings, `|>` pipeline + inlining, `..!` / `..&` / `..=` suffix operators, and `defer` / `arena` block forms. All desugarings are parse-time and emit standard JS.

## Other reading

- [Configurator](../configure/) — pick which built-in modules to include in a `bun build --compile` output. Production binaries trim to whatever you check.
- [LLMs.md](https://github.com/airgap/parabun/blob/main/LLMs.md) — full grammar + architecture document, kept in sync with the implementation.
- [GitHub](https://github.com/airgap/parabun) — source, issues, releases.
