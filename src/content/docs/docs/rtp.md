---
title: bun:rtp
description: RFC 3550 packet pack / parse and a jitter buffer. Wire transport for the codec stack.
---

```ts
import rtp from "bun:rtp";
```

A small RTP toolkit — pack a payload into an RFC 3550 packet, parse one off the wire, and reorder by sequence number with a configurable depth. Built to sit under [`bun:audio`](/docs/audio/)'s Opus encoder for a WebRTC-style send/receive path.

## `pack(opts)`

Returns a `Uint8Array` containing the RTP header + payload.

```ts
const packet = rtp.pack({
  payloadType: 111,         // 7 bits
  sequence: 1234,            // 16 bits
  timestamp: 48000,          // 32 bits
  ssrc: 0xDEADBEEF,          // 32 bits
  payload: opusFrame,        // Uint8Array
  marker: false,             // bool, default false
});
```

CSRCs and extensions aren't supported — the header is fixed at the 12-byte minimum. Open an issue if you need them.

## `parse(bytes)`

Parses a single RTP packet. Returns `{ payloadType, sequence, timestamp, ssrc, payload, marker }`. Throws if the version field isn't 2 or the length is too short.

```ts
const { payloadType, sequence, timestamp, payload } = rtp.parse(packet);
```

## `JitterBuffer`

Reorders incoming packets by sequence number. Useful when the network delivers out-of-order or duplicates.

```ts
const buf = new rtp.JitterBuffer({ depth: 8 });

// ingest as packets arrive
buf.push(packet);
buf.push(packet2);

// drain in order
for (const ordered of buf.drain()) {
  decoder.decode(ordered.payload);
}
```

| Option | Default | Description |
| --- | --- | --- |
| `depth` | `8` | Max reorder window. Packets older than `tail - depth` are dropped. |
| `wrapAware` | `true` | Handles 16-bit sequence-number wrap. |

`drain()` yields packets in sequence order until it would have to wait for a missing one. Subsequent `push` calls + `drain` cycles continue from where it stopped.

### Reactive signals

Three [`bun:signals`](/docs/signals/) Signals on the buffer instance — wire them into a UI without polling.

| Signal | Type | When it changes |
| --- | --- | --- |
| `jb.pendingSignal` | `number` | Number of packets buffered, waiting on the next-expected slot. Updates synchronously on every `push` / `pop`. |
| `jb.lossCountSignal` | `number` | Cumulative count of packets declared lost since construction. Increments when a missing slot ages out past `maxLag`. |
| `jb.lossRateSignal` | `number` | Lifetime loss ratio: `lossCount / (lossCount + delivered)`. Recomputes on every delivered or lost transition. |

```ts
import { effect } from "bun:signals";

effect(() => {
  if (jb.lossRateSignal.get() > 0.05) console.warn("packet loss > 5%");
});
```

`session.connected` and `session.jitterMs` from `PLAN-module-signals.md` need a future Session abstraction (RTP / RTCP correlation, source-arrival timestamp differencing) — neither exists in `bun:rtp` v1. When a Session class lands, those signals will join the surface there.

## A full audio pipeline

Combined with [`bun:audio`](/docs/audio/):

```ts
import audio from "bun:audio";
import rtp from "bun:rtp";

await using mic = await audio.capture({ sampleRate: 48000, channels: 1 });
const enc = new audio.OpusEncoder({ sampleRate: 48000, channels: 1, application: "voip" });
const den = new audio.Denoiser();
const agc = new audio.Gain({ targetLevel: 0.1 });

let sequence = 0, timestamp = 0;
const ssrc = (Math.random() * 0xFFFFFFFF) | 0;

for await (const frame of mic.frames()) {
  den.process(frame.samples);
  agc.process(frame.samples);
  const opus = enc.encode(frame.samples);

  const packet = rtp.pack({
    payloadType: 111,
    sequence: sequence++,
    timestamp,
    ssrc,
    payload: opus,
  });
  // send `packet` over your transport (UDP, WebRTC, etc.).
  console.log("packet bytes:", packet.byteLength);

  timestamp += frame.samples.length;       // advance by sample count
}
```

## Limits

- Single-stream — no SDES / RTCP companion.
- The jitter buffer is sequence-only. Packet-loss concealment, FEC, and rate-adaptive depth are all on the encoder/decoder side ([`bun:audio.OpusDecoder`](/docs/audio/) handles in-band PLC).
- IPv4 / IPv6 wire transport itself is up to the caller — `bun:rtp` produces / consumes bytes, not sockets.
