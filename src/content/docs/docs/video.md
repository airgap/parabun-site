---
title: parabun:video
description: probe() + MJPEG-in-MP4 decode() / encode() in pure JS. Other codecs wait for libavcodec.
---

```ts
import video from "parabun:video";
```

The video surface is staged: `probe()` (any container), `decode()`, and `encode()` for MJPEG-encoded MP4 ship today in pure JS. `decode()` / `encode()` for other codecs (h264 / h265 / vp9 / av1) are typed but throw — they need the native binding (libavcodec on desktop, V4L2 M2M on Pi 5, NVDEC/NVENC on Jetson, VideoToolbox on macOS).

## `probe(bytes)` — ships

Returns `{ container, streams: [{ codec, width, height, fps, duration }] }` from the file's container header. No pixel decoding, no native dep — walks the MP4 box tree or Matroska EBML tree directly.

```ts
import video from "parabun:video";

const bytes = new Uint8Array(await Bun.file("clip.mp4").arrayBuffer());
const info = await video.probe(bytes);
// {
//   container: "mp4",
//   streams: [
//     { kind: "video", index: 0, codec: "h264",
//       width: 1920, height: 1080,
//       fpsNum: 30, fpsDen: 1, durationMs: 12340 },
//     { kind: "audio", index: 1, codec: "aac",
//       sampleRate: 48000, channels: 2, durationMs: 12340 },
//   ],
// }
```

| Container | Detected as | What's parsed |
| --- | --- | --- |
| MP4 / ISOBMFF (`.mp4`, `.m4v`) | `"mp4"` | `moov > trak` for each track; `mdhd`/`hdlr`/`stsd` for codec + dims; `stts` time-to-sample for fps. |
| Matroska (`.mkv`) | `"mkv"` | EBML tree — `Segment > Info` for duration, `Segment > Tracks > TrackEntry` for codec + dims + audio params. |
| WebM (`.webm`) | `"webm"` | Matroska subset — distinguished from `.mkv` via the EBML `DocType` element. |

Codec mapping (per container):

| Physical FourCC / CodecID | Reported as |
| --- | --- |
| `avc1`, `avc3` (MP4) / `V_MPEG4/ISO/AVC` (MKV) | `"h264"` |
| `hev1`, `hvc1` (MP4) / `V_MPEGH/ISO/HEVC` (MKV) | `"h265"` |
| `vp08`, `vp09` (MP4) / `V_VP8`, `V_VP9` (MKV) | `"vp8"`, `"vp9"` |
| `av01` (MP4) / `V_AV1` (MKV) | `"av1"` |
| `mp4a` (MP4) / `A_AAC` (MKV) | `"aac"` |
| `Opus` (MP4) / `A_OPUS` (MKV) | `"opus"` |
| `.mp3` (MP4) / `A_MPEG/L3` (MKV) | `"mp3"` |
| `alac`, `ac-3`, `ec-3` (MP4) / `A_VORBIS`, `A_FLAC` (MKV) | passed through verbatim |

Verified end-to-end against `ffprobe` on h264/aac MP4 and vp9/opus WebM fixtures.

### Limits

- MP4 fps comes from the `stts` table reduction. For variable-fps recordings it's the average; for constant-fps it's exact.
- MKV fps is reported as `0/1` — Matroska doesn't store per-frame timing in the headers, only in cluster timestamps. Computing it would require parsing into the data stream.
- Per-stream duration uses each track's media-header (`mdhd` for MP4, `Info > Duration` × `TimecodeScale` for MKV). Audio + video can differ by a few ms depending on the encoder's tail framing.

## `decode(input, opts?)` / `decodeAll(input, opts?)` — partial

Returns a `VideoDecoder` whose `.frames()` is an async iterator of `DecodedFrame`. Frame shape matches the consumer signature [`parabun:vision.frames(...)`](/docs/vision/) accepts.

**MJPEG-in-MP4 ships today** — UVC-webcam recordings, surveillance footage, ffmpeg `-c:v mjpeg` output. The container's sample tables (`stsz` / `stco` / `co64` / `stsc` / `stts`) are walked, each MJPEG sample's bytes are sliced, and `opts.decodeMjpg` is called per frame to lift JPEG → RGBA. Pass `image.decode` from [`parabun:image`](/docs/image/) (cross-builtin imports between `bun:` modules aren't supported, so the dep is injected here).

```ts
import video from "parabun:video";
import image from "parabun:image";

const bytes = new Uint8Array(await Bun.file("webcam.mp4").arrayBuffer());
const dec = await video.decode(bytes, { decodeMjpg: image.decode });
for await (const frame of dec.frames()) {
  // frame.data is RGBA, frame.width × frame.height,
  // frame.ptsMs is the decode-order timestamp,
  // frame.keyframe is always true (every MJPEG sample is a complete JPEG)
}
```

| Option | Description |
| --- | --- |
| `decodeMjpg` | Required for MJPEG inputs. Pass `image.decode` from `parabun:image`. |
| `streamIndex` | Stream index to decode. Default: first video stream. |
| `startMs` | Drop frames whose PTS is below this. Default 0. |
| `endMs` | Stop when PTS exceeds this. Default Infinity. |

**Other codecs (h264 / h265 / vp9 / av1) still throw** with `parabun:video.decode: codec "<codec>" needs the libavcodec native binding (only MJPEG-in-MP4 is unstubbed today)`. Same input shape will work once libavcodec is vendored.

## `encode(opts)` — partial

Returns a `VideoEncoder` whose `.pushFrame(frame)` queues a frame and `.finalize()` returns the muxed bytes (or writes to `opts.path` if set).

**MJPEG-in-MP4 ships today** — JPEG-encode each frame via `opts.encodeJpg` (= `image.encode` from [`parabun:image`](/docs/image/)) and mux into a hand-written ISOBMFF container. Output is bit-for-bit readable by ffprobe / ffmpeg.

```ts
import video from "parabun:video";
import image from "parabun:image";

await using enc = await video.encode({
  codec: "mjpeg",
  container: "mp4",
  width: 1280,
  height: 720,
  fps: 30,
  encodeJpg: image.encode,   // dep-injected JPEG encoder
  jpegQuality: 90,            // 0–100, default 85
});

for (const frame of frames) await enc.pushFrame(frame);
const bytes = await enc.finalize();
await Bun.write("out.mp4", bytes);
```

Frame shapes accepted by `pushFrame`:

| Shape | Notes |
| --- | --- |
| `{ data, width, height, channels }` | parabun:image-style `DecodedImage`. Channels 3 (RGB) or 4 (RGBA). |
| `{ data, width, height, pixelFormat: "rgba" \| "rgb24" }` | Generic raw-frame shape. |
| `{ data, width, height, format: "rgba" \| "rgb" }` | parabun:camera `RawFrame`. yuyv / nv12 / mjpg need pre-conversion via [`vision.frames`](/docs/vision/). |

**Other codecs (h264 / h265 / vp9 / av1) still throw** with `parabun:video.encode: codec "<codec>" needs the libavcodec native binding (only "mjpeg" is unstubbed today)`.

### File layout

The muxer emits a minimal but spec-compliant ISOBMFF tree:

```
ftyp(isom)
moov
  mvhd
  trak
    tkhd
    mdia
      mdhd
      hdlr (vide / VideoHandler)
      minf
        vmhd
        dinf > dref > url
        stbl
          stsd → "jpeg" sample entry
          stts (constant fps)
          stsc (1 sample per chunk)
          stsz (per-sample sizes)
          stco (chunk offsets — 32-bit; >4 GiB files need co64)
mdat (JPEG samples back-to-back)
```

The `jpeg` FourCC is the canonical sample-entry type for MJPEG-in-MP4 (not `mp4v`, which is MPEG-4 Visual Part 2).

Single-pass write: the muxer builds `moov` with placeholder `stco` offsets, uses the resulting `moov` size to compute the real `mdat` start, then rebuilds `moov` with correct offsets. `stco`'s on-disk size is invariant in the sample count, so the placeholder size matches the real size.

## Hardware acceleration roadmap

When `decode` / `encode` land, accel is per-host:

| Host | Decode | Encode |
| --- | --- | --- |
| Linux x86_64 + NVIDIA | NVDEC | NVENC |
| Linux x86_64 (no NV) | libavcodec (CPU) | libavcodec (CPU) |
| Linux arm64 (Jetson) | NVDEC | NVENC |
| Linux arm64 (Pi 5) | V4L2 M2M | V4L2 M2M |
| macOS | VideoToolbox | VideoToolbox |
| Windows | Media Foundation / NVENC | Media Foundation / NVENC |

## Why staged

Container metadata is pure structural parsing — no codec needed. Decoding pixels needs libavcodec and a vendor build. Shipping `probe()` first means callers can do *useful* container inspection today (sniffing the codec before downloading the rest of the file, validating uploads, building a thumbnail-only ingest pipeline) without waiting on the heavy build work.
