---
title: Install
description: Single-script install on Linux and macOS. Windows is in progress.
---

```bash
curl -fsSL https://raw.githubusercontent.com/airgap/parabun/main/install.sh | bash
```

The install script downloads a prebuilt binary (`parabun`) and the matching VS Code / Cursor / Kiro extension, drops them under `~/.parabun/`, and adds the binary to your shell `$PATH`.

After installing, verify:

```bash
parabun --version
parabun -e 'console.log("hello")'
```

## Editor extension

The VS Code-family extension (works for `code`, `cursor`, and `kiro`) provides:

- TextMate grammar for `.pts` / `.ptsx` / `.pjs` / `.pjsx` files.
- An LSP with hover, go-to-definition, semantic highlighting, purity diagnostics, memo arity hints, and operator documentation.
- Full chat-template detection on `.gguf` paths in `bun:llm` calls.

Install it independently of the runtime:

```bash
curl -fsSL https://raw.githubusercontent.com/airgap/parabun/main/install-extension.sh | bash
```

The script picks up whichever IDE binaries are on `$PATH` and installs the extension into all of them.

## Updating

`parabun self-update` pulls the latest release and refreshes the editor extension at the same time. There is no semver-style channel split today; the install script tracks `main`.

## Uninstall

```bash
rm -rf ~/.parabun
# remove the PATH export from your shell rc
```

The extension is uninstalled through the IDE's own extension manager.

## Build from source

```bash
git clone https://github.com/airgap/parabun
cd parabun
bun install
bun bd                 # debug build at ./build/debug/bun-debug
bun run build:release  # release build at ./build/release/bun
```

`bun bd` accepts trailing arguments and passes them to the built binary, which is the recommended way to run your local build (`bun bd test foo.test.ts`, `bun bd -e 'console.log("hi")'`). See [`CLAUDE.md`](https://github.com/airgap/parabun/blob/main/CLAUDE.md) in the repo for the full build flag reference.

## Platform support

| Platform | Status | Notes |
| --- | --- | --- |
| Linux x86_64 | shipped | Primary development target. CUDA + V4L2 + ALSA backends. |
| macOS arm64 | shipped | Metal kernels (parity with CUDA still in progress for some ops). |
| macOS x86_64 | shipped | Same as arm64 minus Metal (falls back to CPU). |
| Linux arm64 (Jetson, Pi 5) | shipped | CUDA on Jetson; CPU + V4L2 elsewhere. |
| Windows | in progress | Build runs; runtime stabilization underway. |
