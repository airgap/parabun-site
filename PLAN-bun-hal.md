# `bun:gpio` + `bun:i2c` + `bun:spi` + `bun:mmio` — Plan

> **Status (2026-04-29):** `bun:gpio` (single + bulk-line `chip.bank(...)`), `bun:i2c`, `bun:spi` ship. End-to-end validated on Raspberry Pi 5 — five gpiochips enumerate (`brcmstb` × 4 + `pinctrl-rp1`), pull-up/pull-down bias propagates, `i2c.scan()` matches `i2cdetect`, `spi.transactSegments` issues clean `SPI_IOC_MESSAGE` ioctls. `bun:mmio` deferred. Bulk-line acquired through `chip.bank()` rather than the original spec's `chip.lines([...])` — `chip.lines: number` already exists as the chip's line count.

Bring SBC peripheral access into parabun so a `bun:assistant` running on a Pi or Jetson can flip relays, read sensors, drive servos, and talk to displays without shelling out to Python or `gpioset`. Three high-level modules over Linux character devices for the 99% case; one low-level escape hatch for register-direct speed and weird peripherals.

Sits at Tier 1 alongside `bun:audio` / `bun:camera` — kernel-driver wrappers on the userspace side. `bun:assistant` consumes GPIO as MCP tools (the IoT story we already have on the roadmap).

---

## Goal

```ts
// LED on, button reading, 5ms debounce, all in three lines.
import gpio from "bun:gpio";

await using chip = gpio.open("/dev/gpiochip0");
chip.line(17, { mode: "out" }).write(1);
for await (const e of chip.line(27, { mode: "in", pull: "up", debounceMs: 5 }).edges("falling")) {
  console.log("press at", e.timestampNs);
}
```

Same shape for I2C and SPI, plus a `bun:mmio` escape hatch for users who need >1 MHz toggle rates or peripherals not exposed by standard drivers (DMA-driven PWM, custom timing, RP1 register pokes on RPi 5).

## Why now

- `bun:assistant` + `bun:mcp` is taking shape — the IoT story needs hardware access at the bottom of the stack.
- Edge devices are the explicit target. Users on Jetson / RPi want to control hardware from JS without spawning Python helpers.
- Linux's GPIO/I2C/SPI character device APIs are stable, well-documented, and don't need vendored libraries — implementable as raw `ioctl` calls in Zig with no new third-party deps.

## Design rules

1. **Character-device, not sysfs.** `/sys/class/gpio` is deprecated, slow, and racy across multi-process callers. Build on `/dev/gpiochipN` (uAPI v2), `/dev/i2c-N`, and `/dev/spidevN.M`. Same shape on RPi 4, RPi 5, Jetson, NUC + breakout — no per-board branches.
2. **No libgpiod / libi2c-dev dep.** All three are thin `ioctl` wrappers. Implementing in Zig keeps the runtime statically linked and matches the parabun pattern (`bun:audio` doesn't link libasound, `bun:camera` doesn't link libv4l).
3. **`AsyncDisposable` everything.** `await using chip = gpio.open(...)` releases the file descriptor on scope exit. Same for I2C buses, SPI devices, mmap regions.
4. **Signals where state is reactive.** Pin levels, bus presence, edge events expose `bun:signals` Signals — composes with `bun:assistant` and the rest of the reactive surface.
5. **Default off only for `bun:mmio`.** GPIO/I2C/SPI ship in the default release because they're cheap (no native libs, ~1 KiB overhead each). MMIO is dangerous enough — wrong physical address can hang the kernel — that it stays out of the default build and behind a runtime permission gate.

---

## Modules

### `bun:gpio`

Linux GPIO character device (uAPI v2: `/dev/gpiochipN`). Works unchanged across RPi 4, RPi 5 (the new pinctrl-rp1 driver exposes the same uAPI), Jetson, and any other Linux SBC.

**Surface:**

```ts
import gpio from "bun:gpio";

// Discover chips.
gpio.chips();          // [{ path, label, lines }, ...] — returns synchronously

await using chip = gpio.open("/dev/gpiochip0");
chip.label;            // "rp1-gpio" on Pi 5, "pinctrl-bcm2711" on Pi 4
chip.lines;            // number of pins on this chip

// Single-line ergonomics.
const led = chip.line(17, { mode: "out", initial: 0 });
led.write(1);
led.toggle();
led.value;             // Signal<0 | 1>

const button = chip.line(27, {
  mode: "in",
  pull: "up",            // "up" | "down" | "off"
  debounceMs: 5,
  edge: "both",          // "rising" | "falling" | "both" | "none"
});
button.value;          // Signal<0 | 1> — updates on every edge

for await (const e of button.edges()) {
  // e.kind: "rising" | "falling"
  // e.timestampNs: bigint — kernel-side monotonic
  // e.value: 0 | 1
}

// Bulk read/write (atomic across multiple lines, hardware permitting).
const bank = chip.lines([2, 3, 4, 5], { mode: "out" });
bank.write(0b1010);
const v = bank.read();   // 4-bit value
```

**Implementation:** raw `ioctl(GPIO_V2_GET_LINE_IOCTL, ...)`. Edge events come from a `read()` on the line FD, parsed as `gpio_v2_line_event` structs. Wrap the FD in an `AsyncDisposable` JS object; close + free on dispose.

**Lines per use:** typed `Float32Array`-style buffers for bulk r/w; `Signal<number>` for live state. The Signal updates from the same kernel events the `edges()` iterator yields — no double-subscribe path.

### `bun:i2c`

Linux i2c-dev character device (`/dev/i2c-N`).

**Surface:**

```ts
import i2c from "bun:i2c";

i2c.buses();           // [{ path, name, capabilities }, ...]

await using bus = i2c.open("/dev/i2c-1");
bus.scan();            // [0x40, 0x76, ...] — slave addresses ACKing on this bus

const dev = bus.device(0x76);          // BMP280 at 0x76
await dev.write(Uint8Array.of(0xF7)); // set register pointer
const buf = await dev.read(6);         // read 6 bytes from current pointer

// SMBus convenience (read-byte / write-word / etc).
const id = await dev.smbus.readByte(0xD0);
await dev.smbus.writeWord(0xF4, 0x27);

// Combined-message transactions (the right way to do most chip protocols).
const result = await dev.transact([
  { write: Uint8Array.of(0xF7) },
  { read: 6 },
]);
```

**Implementation:** `ioctl(I2C_RDWR, &i2c_rdwr_ioctl_data)` for combined transactions; `ioctl(I2C_SMBUS, ...)` for SMBus shortcuts. `bus.scan()` does single-byte writes across 0x03–0x77 and watches for ENXIO. No vendored library.

### `bun:spi`

Linux spidev (`/dev/spidevN.M`).

**Surface:**

```ts
import spi from "bun:spi";

spi.devices();         // [{ path, bus, cs }, ...]

await using dev = spi.open("/dev/spidev0.0", {
  mode: 0,             // SPI mode 0–3
  bitsPerWord: 8,
  speedHz: 1_000_000,
});

// Full-duplex transfer.
const rx = await dev.transfer(Uint8Array.of(0x9F, 0, 0, 0));   // read JEDEC ID

// Half-duplex helpers.
await dev.write(Uint8Array.of(0x06));
const id = await dev.read(3);

// Multi-segment transactions (CS held low across segments).
const data = await dev.transactSegments([
  { tx: Uint8Array.of(0x03, 0, 0, 0) },     // address
  { rx: 256 },                                // page read
]);
```

**Implementation:** `ioctl(SPI_IOC_MESSAGE(N), &spi_ioc_transfer)`. Speed/mode/bits configured via `SPI_IOC_WR_*`. Async transfers via DMA path when supported (kernel handles it transparently — userspace just sees `read()/write()` returning).

### `bun:mmio`

Raw memory-mapped I/O. Off by default, behind a runtime permission flag.

**Surface:**

```ts
import mmio from "bun:mmio";

// Open a physical address range. Returns a typed-array view onto the page.
await using region = await mmio.map({
  base: 0x1f000d0000n,    // Pi 5 RP1 GPIO peripheral base, as bigint
  size: 0x4000,            // 16 KiB
  device: "/dev/gpiomem",  // or "/dev/mem" — gpiomem is the safer default
});

const u32 = region.u32;     // Uint32Array view, length = size / 4
const u8 = region.u8;       // Uint8Array view

// Write a register.
u32[0x10 / 4] = 0x1;        // poke OE register

// Read a register (volatile — no JS-level caching, every read goes through).
const v = mmio.read32(region, 0x14);
mmio.write32(region, 0x14, v | 0x1);
```

**Safety constraints:**

- **Permission flag.** Either `--allow-mmio` on the parabun CLI, or a runtime grant via `bun:permissions` (yet to be designed). Without permission, `mmio.map()` throws.
- **Default device.** `/dev/gpiomem` is the safer default — exposes only the GPIO peripheral page, requires only `gpio` group membership. `/dev/mem` requires root + `iomem=relaxed` and can poke anything.
- **Documented hazard.** A wrong base address can hang the kernel, brick the boot, or corrupt DRAM. The docs page leads with this in a callout, not a footnote.
- **Volatile semantics.** `mmio.read32` / `mmio.write32` use `Atomics.load` / `Atomics.store` on a `SharedArrayBuffer` view to defeat JIT caching of register reads. Direct typed-array access is offered for ergonomics but documented as "use only when you know JIT can't cache."
- **Not in default release.** The compile-time feature flag defaults off. Users have to `bun build --compile --with bun:mmio` (or check the box in the configurator) to include it.

---

## Feature flag audit

The configurator at `/configure/` claims every module ships behind a compile-time flag, but in practice only ~half of the existing modules appear in the UI, and we don't have a written invariant that every `bun:*` import is gated at build time. This effort tightens that.

### Current configurator inventory (10 modules)

`bun:simd`, `bun:parallel`, `bun:gpu`, `bun:llm`, `bun:image`, `bun:video`, `bun:audio`, `bun:camera`, `bun:csv`, `bun:arrow`.

### Missing from configurator (7)

`bun:arena`, `bun:pipeline`, `bun:signals`, `bun:rtp`, `bun:speech`, `bun:assistant`, `bun:vision`. These either land as add-ons or are simply forgotten in the form. All seven need entries.

### New (this plan, 4)

`bun:gpio`, `bun:i2c`, `bun:spi`, `bun:mmio`.

### Total after this work

21 modules, all configurable. `bun:mmio` is the only one defaulting off.

### Runtime side

`/raid/parabun` builds need a corresponding compile-time gate per module. Audit:

1. Catalogue the existing build flags in `/raid/parabun/build.zig` (or wherever the per-module gates live).
2. Add gates for the 7 missing modules + 4 new modules.
3. Ensure imports of a disabled `bun:*` throw at parse time with a documented error message ("`bun:gpio` was not included in this build — re-run `bun build --compile --with bun:gpio`").
4. Document the canonical invariant: every `bun:*` module in the runtime must have a compile-time feature flag, registered in a single source-of-truth list.

---

## Configurator updates (`public/configure/index.html`)

Add a new group below "Data":

```js
{
  name: "Peripherals (Linux SBC)",
  modules: [
    { id: "gpio", label: "bun:gpio", desc: "GPIO via /dev/gpiochipN — pin r/w + edge events", size: 0, on: true },
    { id: "i2c",  label: "bun:i2c",  desc: "I2C via /dev/i2c-N — scan, read, write, SMBus, combined transactions", size: 0, on: true },
    { id: "spi",  label: "bun:spi",  desc: "SPI via /dev/spidevN.M — full/half duplex transfers", size: 0, on: true },
    { id: "mmio", label: "bun:mmio", desc: "Raw mmap of /dev/gpiomem or /dev/mem — root + permission flag required", size: 0, on: false },
  ],
}
```

Plus add the 7 currently-missing modules into their natural groups (assistant + speech under a new "Application" group; vision under Media; signals + arena + pipeline + rtp under Compute or a new "Streaming" group).

The size column stays 0 for these — they're tiny ioctl wrappers without vendored libraries. The configurator's binary-size estimate updates only when sizable modules toggle.

---

## Build order

1. **`bun:gpio`** — highest demand (the IoT control story is what unblocks `bun:assistant` MCP tools on a Pi). Self-contained, ~400 lines of Zig + JS. ~1 day.
2. **`bun:i2c`** — sensor reading is the next-most-asked. Same shape, smaller surface area. ~half a day.
3. **`bun:spi`** — display drivers, flash chips, SPI sensors. Same shape. ~half a day.
4. **Configurator overhaul** — add 7 missing modules and 4 new ones in one PR. Minimal code change; mostly UI scaffolding.
5. **Feature-flag audit on the runtime side** — catalogue existing gates, add gates for the 11 missing modules, lock in the invariant. ~1 day in `/raid/parabun`.
6. **`bun:mmio`** — last because it's the riskiest. Needs the permission-flag plumbing, the warning callout in docs, the safety review. ~2 days.

Items 1–4 can ship without the runtime-side audit (5) — the audit is cleanup, not blocker. Item 6 should land after 5 so the permission machinery is in place.

---

## Open decisions

- **Permission gating for `bun:mmio`.** Three options: (a) compile-time only — if you built without `--with bun:mmio`, it's not there; (b) runtime flag `--allow-mmio` like Deno's permission model; (c) a `bun:permissions` module that gates anything risky (mmio, raw sockets, FFI, etc.). Recommend (a) + (b) for v1; defer (c) to a separate proposal. The compile-time flag covers casual users; the runtime flag covers shared binaries.
- **`/dev/gpiomem` default.** `/dev/gpiomem` is the safer device but only exposes GPIO; `/dev/mem` exposes everything. Recommend `mmio.map({ device: "/dev/gpiomem" })` as the documented happy-path example, with `/dev/mem` requiring an explicit opt-in argument.
- **Naming: one `bun:hal` module or four separate?** Considered combined — rejected. Parabun's pattern is small, focused modules (`bun:audio` separate from `bun:rtp`, `bun:vision` separate from `bun:camera`). Keep them split. The "hal" framing lives in docs / the configurator group, not the import.
- **Pull-resistor + bias terminology.** GPIO uAPI v2 uses `BIAS_PULL_UP/DOWN/DISABLE`. The JS surface uses `pull: "up" | "down" | "off"` for ergonomics. Document the mapping.
- **Edge-event API: async-iterator vs Signal vs both.** Currently sketched with both. Pure ergonomics — having both means consumers pick. If telemetry shows nobody uses one of them after release, drop it.
- **RPi 5 specifics.** RP1 lives at a different base address (`0x1f000d0000`) and the GPIO numbering is different from the BCM2711. The GPIO uAPI abstracts this — `/dev/gpiochip4` on Pi 5 is the equivalent of `/dev/gpiochip0` on Pi 4. Document the mapping in the gpio doc page; keep the API uniform.
- **Signals lifecycle on disposed line.** When `await using` releases a line, what does its `value` Signal do? Recommend: stays at the last value, no further updates. Subscribers don't error; they just stop getting events. Same rule as `bun:audio` `mic.peakLevel` per `PLAN-module-signals.md`.

---

## Relationship to other plans

- **`PLAN-bun-assistant.md`** — MCP tools backed by GPIO/I2C/SPI is the IoT control loop the assistant module is designed for. Once `bun:gpio` ships, an example MCP server in the docs ("expose a `flip-relay` tool over stdio") makes the use case concrete.
- **`PLAN-module-signals.md`** — the gpio/i2c/spi modules participate in the signals retrofit from day one (`line.value`, `bus.devices`, `dev.busy`). Adds entries to the audit table.
- **`/raid/parabun` `PROPOSALS.md`** — independent. Language-level changes don't affect this work.
