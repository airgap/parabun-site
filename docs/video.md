---
title: bun:video
tagline: probe() + MJPEG-in-MP4 decode() in pure JS. Other codecs wait for libavcodec.
section: modules
---

```ts
import video from "bun:video";
```

The video surface is staged: `probe()` (any container) and `decode()` for MJPEG-encoded MP4 ship today in pure JS. `encode()` and `decode()` for other codecs (h264 / h265 / vp9 / av1) are typed but throw — they need the native binding (libavcodec on desktop, V4L2 M2M on Pi 5, NVDEC/NVENC on Jetson, VideoToolbox on macOS).

## `probe(bytes)` — ships

Returns `{ container, streams: [{ codec, width, height, fps, duration }] }` from the file's container header. No pixel decoding, no native dep — walks the MP4 box tree or Matroska EBML tree directly.

```ts
import video from "bun:video";

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

Returns a `VideoDecoder` whose `.frames()` is an async iterator of `DecodedFrame`. Frame shape matches the consumer signature [`bun:vision.frames(...)`](vision/) accepts.

**MJPEG-in-MP4 ships today** — UVC-webcam recordings, surveillance footage, ffmpeg `-c:v mjpeg` output. The container's sample tables (`stsz` / `stco` / `co64` / `stsc` / `stts`) are walked, each MJPEG sample's bytes are sliced, and `opts.decodeMjpg` is called per frame to lift JPEG → RGBA. Pass `image.decode` from [`bun:image`](image/) (cross-builtin imports between `bun:` modules aren't supported, so the dep is injected here).

```ts
import video from "bun:video";
import image from "bun:image";

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
| `decodeMjpg` | Required for MJPEG inputs. Pass `image.decode` from `bun:image`. |
| `streamIndex` | Stream index to decode. Default: first video stream. |
| `startMs` | Drop frames whose PTS is below this. Default 0. |
| `endMs` | Stop when PTS exceeds this. Default Infinity. |

**Other codecs (h264 / h265 / vp9 / av1) still throw** with `bun:video.decode: codec "<codec>" needs the libavcodec native binding (only MJPEG-in-MP4 is unstubbed today)`. Same input shape will work once libavcodec is vendored.

## `encode(frames, opts)` — pending

Encodes a frame iterator to a video file:

```ts
const out = await video.encode(frames, {
  codec: "h264", bitrate: 4_000_000,
  width: 1920, height: 1080, fps: 30,
  accel: "auto",       // "gpu" | "cpu"
  container: "mp4",
});
await Bun.write("out.mp4", out);
```

Same status: typed but throws.

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
