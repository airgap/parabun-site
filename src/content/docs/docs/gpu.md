---
title: bun:gpu
description: GPU-accelerated vector + matrix primitives. Metal on macOS, CUDA on Linux + Windows, CPU fallback everywhere.
---

```ts
import gpu from "bun:gpu";
```

`bun:gpu` is the device-dispatch layer. The same API works on Metal, CUDA, and CPU — backends register themselves via probe + capability, and `bun:gpu` picks the best one available. The CPU backend forwards to [`bun:simd`](/docs/simd/), so unsupported hosts still get vectorized routes.

## Backend

### `activeBackend()` / `hasBackend(name)` / `setBackend(choice)`

```ts
gpu.activeBackend();              // "cuda" | "metal" | "cpu"
gpu.hasBackend("cuda");           // boolean — does the binary include the backend AND does the host support it
gpu.setBackend("cpu");            // force CPU; useful for tests
gpu.setBackend("auto");           // re-probe
```

Probe order is `[metal, cpu]` on macOS and `[cuda, cpu]` elsewhere. `cpu` always probes true — it's the floor.

### `winsForSize(op, n, elemBytes)`

Returns `true` when the active backend's calibrated crossover says GPU beats CPU at this size. Use it to gate dispatch:

```ts
if (gpu.winsForSize("matVec", nRows * nCols, 4)) {
  return gpu.matVec(matrix, vector, nRows, nCols);
}
return simd.matVec(matrix, vector, nRows, nCols);
```

The CPU backend always returns `false` so `if (winsForSize(...))` falls through to a scalar fallback.

### `calibrate()`

Sweeps the real GPU kernel against bun:simd at a small set of sizes, persists the measured crossover under `~/.cache/parabun/gpu-calibrate-<hash>.json`, and rehydrates it on subsequent process starts. Intended to be called once at app boot — the sweep takes 200–500ms. Setting `BUN_PARABUN_SKIP_CALIBRATION=1` bypasses the cache read on module load.

### Reactive signals

| Signal | Type | When it changes |
| --- | --- | --- |
| `gpu.activeBackendSignal` | `"cuda" \| "metal" \| "cpu"` | Flips when `setBackend()` runs (or when lazy probing settles a backend on first use). |
| `gpu.availableSignal` | `BackendName[]` | List of probable backends. Essentially static — backends don't hot-plug at runtime — but a Signal-shaped surface lets monitoring effects compose with the live `activeBackendSignal`. |

Both signals lazy-init on first read so a CUDA-less host doesn't pay probing cost just for loading `bun:gpu`. Subscribers see the current value on subscribe.

```ts
import { effect } from "bun:signals";
effect(() => console.log(`gpu backend: ${gpu.activeBackendSignal.get()}`));
```

`gpu.devices` and per-device `gpu.memUsed` from `PLAN-module-signals.md` need a dedicated device-enumeration native binding (cuDeviceGetCount + cuMemGetInfo on CUDA, MTLCopyAllDevices on Metal). Tracked as a follow-up.

## Residency

GPU calls take typed arrays *or* device-resident handles. Wrap a `Float32Array` once with `GpuFloat32Array` and the bytes are HtoD-uploaded at construction; subsequent ops use the device buffer with no extra crossing. Disposal is GC-finalized but `using` is preferred.

```ts
import gpu from "bun:gpu";

using mat = new gpu.GpuFloat32Array(weights);     // HtoD on construction
for (const q of queries) {
  const scores = gpu.matVec(mat, q, M, K);        // q HtoDs, mat is already there
}
// `mat` released at scope exit
```

Manual residency:

```ts
const handle = gpu.hold(typedArray);              // returns GpuHandle
gpu.matVec(handle, vector, M, K);
gpu.release(handle);
```

`holdQ4K` / `holdQ6K` accept raw quantized weight bytes — the device buffer holds the Q4_K / Q6_K super-block layout and dispatches an on-chip dequant kernel inside `matVec`. Used by [`bun:llm`](/docs/llm/) for the `Q4_K_M` / `Q6_K` Llama paths.

## Vector ops

### `dot(a, b)`

Vector dot product. Accepts typed arrays or handles for either side.

### `matVec(matrix, vector, nRows, nCols)`

`matrix` is `[nRows, nCols]` row-major, `vector` is length `nCols`. Returns `[nRows]`. The hot path inside [`bun:llm`](/docs/llm/)'s decoder step — every Q/K/V/O projection plus the LM head goes through here.

### `matmul(A, B, m, k, n, out?)`

`A` is `[m, k]`, `B` is `[k, n]`, returns `[m, n]`. CUDA backend uses an 8×8 register-tiled NVRTC kernel. Pass `out` to write into a caller-owned destination buffer (avoids one allocation per call when sweeping).

### `simdMap(fn, a)`

Element-wise map. `fn` is a JS function `(x, i) => number`. The runtime translates supported function bodies to PTX (CUDA) or MSL (Metal) and dispatches as a single kernel — no per-element call overhead. Supported subset: arithmetic, `Math.*`, ternary, conditional `if`. Fall back to CPU for anything outside that.

```ts
const y = gpu.simdMap(x => x * x + 1, input);     // compiled to PTX/MSL
```

## Reductions

```ts
gpu.reduce(input, "sum");          // | "min" | "max"
gpu.scan(input);                    // exclusive prefix sum
gpu.argMin(input);
gpu.argMax(input);
gpu.histogram(input, bins, min, max);
gpu.median(input);
gpu.quantile(input, q);
gpu.variance(input, ddof?);
gpu.stddev(input, ddof?);
```

CUDA `reduce` (sum/min/max) and atomic-privatized `histogram` ship as device kernels today. Scan, argMin/argMax, variance, median/quantile have device kernels for some shapes and CPU correctness paths for the rest — all on the same dispatch surface, so the call site doesn't change as kernels land.

## Image

### `conv2D(input, kernel, iH, iW, kH, kW)`

2D valid-mode correlation. Used by [`bun:image`](/docs/image/) for blur / sharpen / edge-detect. f32 only for v1.

### `imageBlurRGBA(input, width, height, sigma)`

Separable Gaussian on RGBA8 — used internally by `image.blur` and `image.sharpen`'s prefilter. Calls into the same CUDA / Metal kernel paths.

## Allocators

### `alloc(n, type)`

Returns a typed array (`Float32Array | Float64Array`) backed by pinned host memory when the active backend benefits from it. On CUDA, pinned memory cuts HtoD latency by ~2-3× on large transfers.

### `isAligned(arr)`

True when the underlying buffer satisfies the active backend's alignment requirement (16-byte for current CUDA / Metal kernels).

## Backend specifics

### CUDA

Driver API via `bun:ffi` against `libcuda.so.1`. NVRTC compiles dynamic kernels (`simdMap`); static PTX is shipped for `matVec`, `matmul`, `dot`, `reduce`, `histogram`, and the quantized-matVec variants. Shared-memory tile sizes are tuned for SM 8.x (Ampere) and SM 9.x (Hopper); SM 7.x (Turing) hits a fallback launch shape.

### Metal

Obj-C FFI to `MTLDevice` + `MTLComputePipelineState`. Zero-copy via Apple's unified memory — `hold()` is essentially free. MSL source is generated from JS for `simdMap`; static MSL is shipped for the rest.

### CPU

Forwards every op to [`bun:simd`](/docs/simd/). Always available — useful for tests and CI hosts without a GPU.

## Limits

- f64 matmul / matVec are CUDA-only on NVIDIA's higher-precision SKUs; consumer cards trap to a much slower path. `bun:gpu` runs f64 on CPU instead.
- The dynamic kernel compiler (`simdMap`) supports arithmetic + `Math.*` + ternaries. No control flow beyond that — branch-heavy bodies stay on CPU.
- Two `GpuHandle`s on different backends can't be mixed in one call (e.g. you can't pass a CUDA handle to a Metal kernel). The active backend at the call site determines which the inputs must belong to.
