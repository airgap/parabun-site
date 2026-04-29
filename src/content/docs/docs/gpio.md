---
title: bun:gpio
description: Linux GPIO character device wrapper (uAPI v2). Same surface across RPi 4/5, Jetson, and any Linux SBC.
---

```ts
import gpio from "bun:gpio";
```

A small module wrapping the Linux GPIO character device interface (`/dev/gpiochipN`, uAPI v2). Same call shape across Raspberry Pi 4, Raspberry Pi 5 (where the new `pinctrl-rp1` driver exposes the same uAPI), Jetson, and any other Linux SBC. No vendored libgpiod; pure ioctl on the kernel character device.

`bun:gpio` is currently Linux-only. macOS / Windows hosts don't have an equivalent kernel surface for SBC pin headers — those don't ship without an external bridge.

## `chips()`

Synchronously enumerates `/dev/gpiochipN` entries with their driver label and line count.

```ts
gpio.chips();
// [
//   { path: "/dev/gpiochip0", label: "gpio-brcmstb@107d508500", lines: 32 },
//   { path: "/dev/gpiochip4", label: "pinctrl-rp1",             lines: 54 },
//   ...
// ]
```

On a Pi 5 the user-accessible header pins live on `/dev/gpiochip4` (the RP1). On a Pi 4 they're on `/dev/gpiochip0` (BCM2711). The `label` field is how you tell them apart.

## `open(path)`

Opens a chip and runs `GPIO_GET_CHIPINFO_IOCTL` to confirm it's a real gpiochip. Returns a `Chip`.

```ts
await using chip = gpio.open("/dev/gpiochip4");
chip.path;   // "/dev/gpiochip4"
chip.label;  // "pinctrl-rp1"
chip.lines;  // 54
```

`Chip` is `AsyncDisposable` — `await using` releases the chip fd at scope exit. Lines acquired through this chip stay open until they're individually closed (you can drop the chip handle without affecting in-flight `Line` requests).

### `chip.line(offset, opts)`

Acquire a single line on this chip. Returns a `Line` you can `read()` / `write()` / `toggle()` / `edges()`.

```ts
// Output:
const led = chip.line(17, { mode: "out", initial: 0 });
led.write(1);
led.toggle();
led.value.get();   // 0 | 1 — Signal of the most recent observed value

// Input with hardware debounce + edge events:
const button = chip.line(27, {
  mode: "in",
  pull: "up",
  debounceMs: 5,
  edge: "falling",
});
for await (const e of button.edges()) {
  // e.kind: "rising" | "falling"
  // e.timestampNs: bigint (kernel monotonic)
  // e.value: 0 | 1
}
```

Options:

- `mode: "in" | "out"` — required.
- `pull: "up" | "down" | "off"` — input bias resistor. Default `"off"`.
- `debounceMs: number` — hardware debounce. `0` disables. RPi 5 (RP1) supports this; RPi 4 (BCM2711) returns `ENOTSUP` at request time.
- `edge: "rising" | "falling" | "both" | "none"` — edge events to deliver via `edges()`. Default `"none"`.
- `initial: 0 | 1` — output starting value. Default `0`.

`Line` is `AsyncDisposable`. The reactive `line.value` Signal updates on `read()` and on edge events — pair with [`bun:signals`](/docs/signals/) for `effect { ... }` / `~>` composition.

### `chip.bank(offsets, opts)`

Acquire several lines as one atomic unit. Up to 64 lines per call (kernel uAPI v2 cap). All lines share `mode` / `pull` / `edge` / `debounceMs`. Reads + writes go through a single ioctl, so multi-pin transitions hit the bus simultaneously.

```ts
await using bank = chip.bank([17, 22, 23, 27], {
  mode: "out",
  initial: 0b1010n,            // BigInt: bit i = offsets[i]
});

bank.read();                   // BigInt — bit i = current value of offsets[i]
bank.write(0b0101n);           // all lines
bank.write(0b0001n, 0b0001n);  // values + mask: only modify bit 0
```

Named `bank` rather than `lines` because `chip.lines` is already the chip's line count.

## Quick example: blinking LED + button

```ts
import gpio from "bun:gpio";

await using chip = gpio.open("/dev/gpiochip4");
const led = chip.line(17, { mode: "out", initial: 0 });
const button = chip.line(27, { mode: "in", pull: "up", edge: "falling", debounceMs: 5 });

// Blink in the background.
const blinker = setInterval(() => led.toggle(), 500);

// Stop on first button press.
for await (const _ of button.edges()) {
  clearInterval(blinker);
  led.write(0);
  break;
}
```

## Performance

Measured on a Pi 5 RP1 (`bench/parabun-gpio-toggle`):

- Single-line `write()` — ~2.1 M writes/s, ~470 ns per ioctl
- Single-line `toggle()` — ~2.0 M toggles/s, ~490 ns per call
- 4-line `bank.write()` — ~920 k writes/s = ~3.7 M pin-writes/s (1.1 µs covers 4 lines atomically)

uAPI v2 is ioctl-bound at ~1 MHz toggle rate per pin (two writes per toggle cycle). For sustained > 1 MHz toggle rates or DMA-driven PWM, see `bun:mmio` (off by default — bypasses the kernel and pokes the controller's GPIO registers directly).

## See also

- [`bun:i2c`](/docs/i2c/) — i2c-dev character device on the same Linux SBCs.
- [`bun:spi`](/docs/spi/) — spidev wrapper for the same hardware family.
- [`bun:signals`](/docs/signals/) — reactive composition over `line.value`.
