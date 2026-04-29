---
title: bun:spi
description: Linux spidev wrapper. Full-duplex transfers + multi-segment transactions with CS held across segments.
---

```ts
import spi from "bun:spi";
```

A small module wrapping the Linux spidev character device (`/dev/spidevN.M`). Mode / bits-per-word / clock speed configured at open via `SPI_IOC_WR_*`; transfers via `SPI_IOC_MESSAGE` for both single full-duplex transfers and multi-segment transactions where chip-select stays asserted across segments.

`bun:spi` is currently Linux-only.

## `devices()`

Synchronously enumerates `/dev/spidev<bus>.<cs>` entries.

```ts
spi.devices();
// [
//   { path: "/dev/spidev0.0", bus: 0, cs: 0 },
//   { path: "/dev/spidev10.0", bus: 10, cs: 0 },   // RPi 5 user header
// ]
```

On Pi 5 the user-header SPI is at `/dev/spidev10.0` (different bus number than Pi 4's `/dev/spidev0.0`). The `bus` / `cs` fields are parsed from the path — the kernel exposes one device file per (controller, chip-select) pair.

## `open(path, opts)`

Opens a device, configures mode / bits-per-word / clock speed, and returns a `Device`.

```ts
await using dev = spi.open("/dev/spidev0.0", {
  mode: 0,             // 0..3 — CPOL/CPHA combinations
  bitsPerWord: 8,
  speedHz: 1_000_000,  // 1 MHz
});
```

Defaults: `mode: 0`, `bitsPerWord: 8`, `speedHz: 1_000_000`. `Device` is `AsyncDisposable`.

### `dev.transfer(tx, opts?)`

Single full-duplex transfer. `tx` is shifted out; the same number of bytes is shifted in and returned. CS is asserted for the duration.

```ts
const rx = await dev.transfer(Uint8Array.of(0x9F, 0, 0, 0));
// rx: Uint8Array(4) — captured during the four-byte tx.
```

Optional per-call overrides: `{ speedHz, delayUs }`.

### `dev.write(tx, opts?)`

Half-duplex write. Same as `transfer` but discards the rx bytes. For very hot write loops, prefer `transactSegments` with no rx — that avoids allocating the rx buffer kernel-side too.

### `dev.read(length, opts?)`

Half-duplex read. Sends `length` zero bytes and returns the captured rx. `length` must be a positive integer.

### `dev.transactSegments(segments)`

Multi-segment transaction with CS held across all segments unless a per-segment `csChange: true` flips it. Each segment is one of:

- `{ tx: Uint8Array }` — half-duplex out
- `{ rx: number }` — half-duplex in (length bytes)
- `{ tx: Uint8Array, rx: rx.length }` — full-duplex (rx must match tx length)

Plus optional `speedHz`, `delayUs`, `bitsPerWord`, `csChange` per segment.

```ts
// Flash JEDEC ID read: CMD then 3-byte id.
const [, id] = await dev.transactSegments([
  { tx: Uint8Array.of(0x9F) },
  { rx: 3 },
]);
// id: Uint8Array(3) — manufacturer + device + capacity bytes
```

Returns one slot per segment — tx-only segments yield `undefined`, rx-bearing segments yield a `Uint8Array`.

## Pi 5 note

The Pi 5 user header SPI is at `/dev/spidev10.0` (bus 10), not `/dev/spidev0.0`. Enable with `dtparam=spi=on` in `/boot/firmware/config.txt`.

## See also

- [`bun:gpio`](/docs/gpio/) — character-device GPIO on the same Linux SBCs.
- [`bun:i2c`](/docs/i2c/) — i2c-dev wrapper.
