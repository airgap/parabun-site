---
title: bun:image
tagline: Sharp-class image module — JPEG / PNG / WebP, resize, blur, sharpen, edges, rotate, crop, color adjust, alpha compositing.
section: modules
---

```ts
import image from "bun:image";
```

A from-scratch image module with the codecs and operations Sharp covers, baked into the runtime. libjpeg-turbo, libpng, libwebp, and libsharpyuv are vendored statically — no `npm install sharp`, no Node-ABI-versioned binary distribution.

Images are `Image` objects: `{ width, height, channels, data: Uint8Array | Uint8ClampedArray }`. Most operations return a new `Image`; the source is unchanged.

## Codec I/O

### `decode(bytes)`

Auto-detects format from magic bytes. JPEG, PNG, and WebP supported. Returns an `Image` with the file's native channel layout (RGB, RGBA, grayscale, grayscale-alpha).

```ts
const bytes = await Bun.file("photo.jpg").bytes();
const img = image.decode(bytes);
// { width: 1920, height: 1280, channels: 3, data: Uint8Array }
```

### `encode(img, opts)`

```ts
const webp = image.encode(img, { format: "webp", quality: 85 });
const png  = image.encode(img, { format: "png" });
const jpg  = image.encode(img, { format: "jpeg", quality: 92, progressive: true });
await Bun.write("photo.webp", webp);
```

| Option | Description |
| --- | --- |
| `format` | `"jpeg" \| "png" \| "webp"`. |
| `quality` | 0–100 for JPEG / WebP. PNG ignores. |
| `progressive` | JPEG only. |
| `lossless` | WebP only. Disables `quality`. |

## Geometric transforms

### `resize(img, opts)`

```ts
const small = image.resize(img, { width: 800, height: 600, kernel: "lanczos" });
const fit   = image.resize(img, { width: 800, fit: "contain" });
```

| Option | Description |
| --- | --- |
| `width`, `height` | At least one required. The other is computed to preserve aspect unless `fit: "fill"`. |
| `kernel` | `"bilinear" \| "lanczos"`. Lanczos is sharper; bilinear is faster. |
| `fit` | `"contain"` (default), `"cover"`, `"fill"`, `"inside"`, `"outside"` — same semantics as Sharp. |
| `background` | When `fit: "contain"` letterboxes, this is the fill color. Default `[0, 0, 0, 0]`. |

### `rotate(img, degrees, opts?)`

90 / 180 / 270 are exact transposes; arbitrary angles use bilinear interpolation. `opts.background` for the corner fill on non-quadrant rotations.

### `flip(img, axis)`

`axis` is `"horizontal"`, `"vertical"`, or `"both"`.

### `crop(img, { x, y, width, height })`

Bounds are clamped to the image; out-of-bounds reads return the edge pixel.

## Filters

### `blur(img, { sigma })`

Separable Gaussian. Two 1-D passes. Edge mode: clamp.

### `boxBlur(img, { radius })`

Faster, lower-quality alternative — good enough for cheap previews and the prefilter in `sharpen`.

### `sharpen(img, opts?)`

Unsharp mask:

```ts
const sharp = image.sharpen(img, { amount: 1.5, sigma: 1.0, threshold: 0 });
```

| Option | Default | Description |
| --- | --- | --- |
| `amount` | `1.0` | Strength of the high-pass add. |
| `sigma` | `1.0` | Gaussian blur radius for the prefilter. |
| `threshold` | `0` | Suppress edges below this magnitude (avoids amplifying noise). |

### `edgeDetect(img, opts?)`

Sobel. Returns a single-channel image of gradient magnitude. `opts.normalize` rescales the output to `[0, 255]`.

## Color

### `adjust(img, { brightness?, contrast?, saturation? })`

Each value is a multiplier — `1.0` is no change, `1.5` is 50% boost. Saturation operates in HSL; brightness / contrast are linear in the RGB space.

### `hueShift(img, degrees)`

YIQ rotation matrix. Preserves luma + saturation, rotates the chrominance angle. Pure hue shift; nothing else moves.

### `toGrayscale(img)`

ITU-R BT.601 luma weights (`0.299 R + 0.587 G + 0.114 B`). Returns a single-channel image.

### `invert(img)` / `threshold(img, value)`

Component-wise. `threshold` returns binary 0/255 per pixel based on luma.

### `histogram(img)`

Returns `{ r: Uint32Array(256), g: Uint32Array(256), b: Uint32Array(256), a?: Uint32Array(256) }` — per-channel value distribution. Useful for auto-levels / tone curves.

## Compositing

### `composite(dst, src, opts?)`

Porter-Duff source-over. Both images can have alpha.

```ts
const stamped = image.composite(canvas, watermark, { x: 20, y: 20, opacity: 0.6 });
```

| Option | Description |
| --- | --- |
| `x`, `y` | Top-left of `src` in `dst` coordinates. Default 0. |
| `opacity` | Multiplier on `src`'s alpha. Default 1.0. |
| `mode` | `"over"` (default). Other Porter-Duff ops are pending. |

## Pipeline — chained operations

For longer chains, `image.pipeline(img)` returns a builder that defers work until the terminal call. This is where Sharp's lazy decode→transform→encode buffer sharing happens — operations short-circuit allocations of intermediate images.

```ts
const out = await image.pipeline(img)
  .resize({ width: 1024 })
  .blur({ sigma: 1.5 })
  .sharpen({ amount: 1.2 })
  .encode({ format: "webp", quality: 85 });

await Bun.write("processed.webp", out);
```

The terminal calls are `.encode(opts)`, `.toBuffer()` (raw bytes), or `.toImage()` (back to a plain `Image`).

## Performance

CPU release build, 4096² RGBA on a 16-core x86:

| Operation | bun:image | Sharp | Speedup |
| --- | --- | --- | --- |
| Gaussian blur, σ=4 | 38 ms | 137 ms | 3.6× |
| Lanczos 4096²→2048² | 67 ms | 163 ms | 2.4× |
| Bilinear 4096²→1024² | 9 ms | 121 ms | 13.4× |
| End-to-end JPEG decode → blur → WebP encode | similar | similar | within ~10% |

The kernel speedups are on isolated operations. End-to-end Sharp wins because libvips's lazy buffer chaining short-circuits intermediate decode + transform + encode allocations; `image.pipeline` closes most of that gap.

## Limits

- AVIF decode/encode lands when `libavif` + `aom` (or `dav1d`) are vendored. Tracked.
- TIFF, GIF (animated), HEIF: not yet.
- ICC color management: not yet — output is sRGB-assumed.
- The pipeline builder fuses adjacent compatible kernels (e.g. resize + sharpen) but not all of them. This expands over time.
