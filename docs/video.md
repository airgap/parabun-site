---
title: bun:video
tagline: Scaffolded JS surface for libavcodec / V4L2 M2M / NVDEC / NVENC. Native side pending.
section: modules
---

```ts
import video from "bun:video";
```

The JS-side surface for video decode + encode + container muxing. The interfaces are typed and stable — you can write code against them today — but the native side hasn't been wired yet, so all four entry points throw.

## Planned API

### `probe(input)`

Returns `{ container, streams: [{ codec, width, height, fps, duration }] }` without decoding pixels.

### `decode(input, opts?)` / `decodeAll(input, opts?)`

Async iterator over frames (`decode`) or a one-shot materialization (`decodeAll`). Frame shape matches [`bun:camera`](camera/)'s `RawFrame`, so the same `vision.frames(...)` consumer handles both.

```ts
import video from "bun:video";

for await (const frame of video.decode(Bun.file("clip.mp4"))) {
  // frame.data ready to feed to image / vision / encode pipeline
}
```

### `encode(frames, opts)`

Encodes a frame iterator to a video file:

```ts
const out = await video.encode(frames, {
  codec: "h264",
  bitrate: 4_000_000,
  width: 1920, height: 1080, fps: 30,
  acceleration: "auto",   // "nvenc" | "v4l2m2m" | "cpu"
  format: "mp4",           // container
});
await Bun.write("out.mp4", out);
```

## Status today

All four entry points throw:

> `bun:video.<fn>: bun:video native binding not yet wired — JS surface only. libavcodec on desktop, V4L2 M2M on Pi 5, NVDEC/NVENC on Jetson are planned on the same surface.`

Tracked in the roadmap. Hardware accel decisions land per-host:

| Host | Decode | Encode |
| --- | --- | --- |
| Linux x86_64 + NVIDIA | NVDEC | NVENC |
| Linux x86_64 (no NV) | libavcodec (CPU) | libavcodec (CPU) |
| Linux arm64 (Jetson) | NVDEC | NVENC |
| Linux arm64 (Pi 5) | V4L2 M2M | V4L2 M2M |
| macOS | VideoToolbox | VideoToolbox |
| Windows | Media Foundation / NVENC | Media Foundation / NVENC |

## Why typed-but-stubbed

The interfaces let you write integration code now, plug it into [`bun:vision`](vision/) / [`bun:image`](image/) pipelines, and have it just start working when the native side lands. The error message stable prefix `"bun:video.<fn>:"` is ergonomic for `try`/`catch` wrappers if you want to gracefully fall back to an external `ffmpeg` shellout in the meantime.
