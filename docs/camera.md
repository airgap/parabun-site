---
title: bun:camera
tagline: V4L2 capture on Linux. AVFoundation (macOS) and Media Foundation (Windows) follow on the same surface.
section: modules
---

```ts
import camera from "bun:camera";
```

A small module wrapping the kernel's V4L2 capture API. Linux only today; the JS surface is platform-agnostic so AVFoundation + Media Foundation backends slot in without callsite changes.

## `devices()`

Returns an array of capture-capable video devices. Reads `/sys/class/video4linux/` and runs `VIDIOC_QUERYCAP` on each entry to filter to actual capture devices (skips encoders, M2M endpoints, etc.).

```ts
const devs = await camera.devices();
// [{ path: "/dev/video0", name: "OBSBOT Tail Air", driver: "uvcvideo" }, ...]
```

## `formats(path)`

Enumerates the device's supported `(format, width, height, fps)` tuples via `VIDIOC_ENUM_FMT` + `VIDIOC_ENUM_FRAMESIZES` + `VIDIOC_ENUM_FRAMEINTERVALS`.

```ts
const fmts = await camera.formats("/dev/video0");
// [{ format: "mjpg", width: 1920, height: 1080, fps: 30 }, ...]
```

## `open(opts)`

Opens the device, mmaps the kernel ring buffer, queues capture buffers, and starts streaming. Returns a `Camera` instance.

```ts
await using cam = await camera.open({
  device: "/dev/video0",
  width: 1280,
  height: 720,
  fps: 30,
  format: "mjpg",         // or "yuyv" / "nv12" / "rgb24"
  buffers: 4,              // ring depth — 4 is usually enough
});
```

`Camera` is `AsyncDisposable` — `await using` triggers `VIDIOC_STREAMOFF` + `munmap` + `close()` on scope exit.

### `cam.frames()`

Async iterator of raw frames. Each `RawFrame` is `{ format, width, height, data: Uint8Array, timestampMs: number }`. The `data` view points directly at the kernel-mapped buffer — copy if you need to retain the frame past the next iteration.

```ts
for await (const frame of cam.frames()) {
  // process frame.data — but don't hold past the next loop iteration
}
```

To compose with [`bun:image`](image/) / [`bun:vision`](vision/), pass the iterator through `vision.frames(...)` to convert to packed-RGBA8.

### `cam.close()`

Manual close. Equivalent to `using` scope exit. Idempotent.

## `toRgba(frame)`

Single-frame converter — useful when you have a `RawFrame` from somewhere else (file, network) and want RGBA8 without spinning up `vision.frames`. Same pixel format coverage as `vision.frames` (yuyv, nv12, rgb24, rgba; mjpg requires `image.decode`).

## Composition

The end-to-end shape pairs with [`bun:vision`](vision/):

```ts
import camera from "bun:camera";
import image from "bun:image";
import vision from "bun:vision";

await using cam = await camera.open({ device: "/dev/video0", width: 1280, height: 720, fps: 30 });

for await (const { frame, motion } of vision.detectMotion(
  vision.frames(cam.frames(), { decodeMjpg: image.decode }),
)) {
  if (motion > 0.05) console.log("motion!");
}
```

## Limits

- Linux only today.
- No control over UVC parameters (focus, exposure, white balance) yet — those would surface as `cam.set("focus", value)` style calls. Open an issue if you need this.
- `mjpg` decoding goes through `image.decode` (libjpeg-turbo) — fine for 30 fps at 1080p, but a streaming JPEG decoder (e.g. mjpeg-stream-style row-by-row) would be faster.
- One reader per device; V4L2 doesn't multiplex.
