---
title: para:vision
description: Frame stream conversion + motion detection. Detector / OCR engines stub until ONNX runtime is vendored.
---

```ts
import vision from "para:vision";
```

Tier 2 wrapper that turns any camera frame iterator into packed RGBA8 frames, plus a frame-diff motion estimator. Detector + OCR engines are typed but stubbed — they need an ONNX runtime vendored before they can do anything.

## `frames(stream, opts?)`

Takes a `RawFrame` iterator (e.g. from [`para:camera`](/docs/camera/)) and yields `{ width, height, data: Uint8Array }` packed-RGBA8 frames.

```ts
import camera from "para:camera";
import image from "para:image";
import vision from "para:vision";

const cam = await camera.open({ device: "/dev/video0", width: 1280, height: 720, fps: 30 });
for await (const frame of vision.frames(cam.frames(), { decodeMjpg: image.decode })) {
  // frame.data is RGBA8 — feed to image, detector, recorder, anything
}
```

Supported pixel formats:

| Format | Conversion |
| --- | --- |
| `yuyv` | YUV 4:2:2 → RGBA |
| `nv12` | YUV 4:2:0 → RGBA |
| `rgb24` | RGB → RGBA (alpha=255) |
| `rgba` | passthrough |
| `mjpg` | passes through `decodeMjpg(frame.data)`. Required: caller passes `image.decode` from [`para:image`](/docs/image/) (cross-builtin imports between `bun:` modules aren't supported, so the dep is injected here). |

## `detectMotion(stream, opts?)`

Frame-diff motion estimator. Downsamples to a luma image (configurable scale), diffs against the previous frame, applies temporal smoothing, and yields `{ frame, motion: number }` where `motion` is the fraction of pixels that changed beyond a threshold.

```ts
for await (const { frame, motion } of vision.detectMotion(vision.frames(cam.frames()), {
  threshold: 30,
  smoothing: 0.6,
  scale: 4,
})) {
  if (motion > 0.05) saveFrame(frame);
}
```

| Option | Default | Description |
| --- | --- | --- |
| `threshold` | `30` | Per-pixel luma delta below which a pixel is considered unchanged. |
| `smoothing` | `0.5` | EMA factor on the motion signal. `0` = raw, `1` = frozen. |
| `scale` | `4` | Downsample factor for the luma image. Higher = cheaper + less sensitive to fine motion. |

### Reactive signals

The returned iterator carries two [`para:signals`](/docs/signals/) Signals — wire `effect()` blocks against motion state without iterating the full stream.

| Signal | Type | When it changes |
| --- | --- | --- |
| `m.detected` | `boolean` | Flips on rising/falling edges of `motionScore > sensitivity`. Edge-triggered, not throttled. |
| `m.score` | `number` | Most recent smoothed motion score (fraction of luma-changed pixels, [0, 1]). Throttled to ~10 Hz so a 30 fps camera doesn't fire effects on every frame. |

```ts
import { effect } from "para:signals";

const m = vision.detectMotion(vision.frames(cam.frames()), { sensitivity: 0.05 }).run();

effect(() => {
  if (m.detected.get()) console.log(`motion: ${(m.score.get() * 100).toFixed(1)}%`);
});

// Stop the drainer when you're done; signals reset to inert state.
// (Or just close the underlying camera; the generator's finally block fires.)
// m.run() returned a disposer:
// stop();
```

`.run()` drains the iterator in the background so the signals auto-fill without a hand-rolled `for await` IIFE. It returns an idempotent disposer; calling `.run()` again returns the same one. If you also want each `MotionFrame` value (not just the reactive view), iterate explicitly with `for await (...)` instead of calling `.run()`.

When the input stream ends (or the disposer fires), both signals reset to their inert state (`detected = false`, `score = 0`) so dependent effects don't show stale motion after the camera closes.

## `detect(frame, opts)` — stub

Object detection — YOLO / SSD / RT-DETR. Throws:

> `para:vision.detect: object-detection engines (YOLO / SSD / RT-DETR) require ONNX runtime as a vendored dep — not yet wired. Tracked in the roadmap as para:vision (Tier 2).`

Once ONNX is vendored, callers pass an ONNX model path and a label set; the function returns `{ boxes: [{x, y, w, h}], scores: number[], labels: string[] }`.

## `recognize(frame, opts)` — stub

OCR — Tesseract / EasyOCR. Same shape: throws with a documented message until the engine is wired. Returns `{ text, words: [{ text, bbox, confidence }] }` when implemented.

## Composing

The shape of `vision.frames` is also the shape `detectMotion`, `detect`, and `recognize` consume. Anything that yields packed-RGBA8 fits — file readers, RTSP unwrappers, GStreamer bridges. The cross-module dependency injection (`decodeMjpg`) extends to detectors / OCR engines too: when those land, callers pass an engine handle in rather than the module reaching for it.

## Limits

- Detector / OCR engines: pending ONNX vendor add. The interfaces are typed and stable; bodies throw.
- No GPU path on the converters yet — `frames` pixel conversions run on CPU. Big surface for a [`para:gpu`](/docs/gpu/) `simdMap` lift.
- Motion detection's downsampler is a simple stride sample — Gaussian-prefilter would suppress aliasing on high-detail backgrounds. Currently not exposed; happy to expose `prefilter: true` if needed.
