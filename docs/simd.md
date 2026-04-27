---
title: bun:simd
tagline: WebAssembly v128 kernels for Float32Array / Float64Array. Zero-copy when inputs are large.
section: modules
---

```ts
import simd from "bun:simd";
```

`bun:simd` is the CPU-side numerical primitive layer. WebAssembly v128 vectorizes `Float32Array` (4-lane f32) and `Float64Array` (2-lane f64) ops; for inputs above ~4 MiB, the wasm module reads straight from the original buffer rather than copying into wasm linear memory.

The same operations exist on [`bun:gpu`](gpu/) with device-dispatch fallback — `bun:simd` is the floor that always works.

## Element-wise

| Function | Description |
| --- | --- |
| `mulScalar(a, k)` | `a[i] * k`. Returns a fresh typed array. |
| `addScalar(a, k)` | `a[i] + k`. |
| `add(a, b)` | Element-wise sum. Same shape required. |
| `mul(a, b)` | Element-wise product. |

```ts
const y = simd.mulScalar(new Float32Array([1, 2, 3, 4]), 3);   // [3, 6, 9, 12]
const z = simd.add(a, b);
const w = simd.mul(a, b);
```

## Reductions

| Function | Description |
| --- | --- |
| `sum(a)` | `Σ a[i]`. Kahan-compensated. |
| `dot(a, b)` | `Σ a[i] * b[i]`. |
| `topK(a, k)` | Returns `{ indices: Int32Array, values: Float32Array }` of the top `k` by value. |

## Linear algebra

### `matVec(matrix, vector, nRows, nCols)`

`matrix[nRows, nCols]` row-major × `vector[nCols]` → result `[nRows]`. Used as the CPU fallback inside [`bun:gpu`](gpu/)'s `matVec`.

## Map

### `simdMap(fn, a)`

Element-wise function application. `fn` is `(x, i) => number`. Significantly faster than `Array.prototype.map` for typed arrays of plausible size — the wasm side compiles a per-call closure. CPU ceiling unless [`bun:gpu`](gpu/) gates this through to a runtime-compiled GPU kernel.

```ts
const r = simd.simdMap(x => Math.sqrt(x * x + 1), input);
```

## Allocator

### `alloc(n, type)`

Returns a typed array backed by wasm linear memory. Operations on these inputs skip the HtoW copy entirely.

```ts
const buf = simd.alloc(1_000_000, "f32");
// fill buf in place...
const total = simd.sum(buf);             // zero-copy
```

### `isWasmBacked(arr)`

True when `arr.buffer` is the wasm linear-memory `ArrayBuffer`.

### `isWasmAvailable()` / `wasmWinsForSize(op, n, elemBytes)`

`isWasmAvailable` is `false` on hosts without v128 (typical x86-32, some embedded). `wasmWinsForSize` returns the calibrated CPU-vs-wasm crossover — for very small arrays the wasm dispatch overhead loses to a tight scalar JS loop, so the higher-level callers (and [`bun:gpu`](gpu/)) gate on this.

## Capability checks

`hasUnifiedMemoryGPU()` and `hasDiscreteGPU()` return whether the host has a Metal-style unified-memory accelerator or a separate-memory CUDA-style one. Useful for choosing residency strategy upstream of [`bun:gpu`](gpu/).

## Performance

CPU release build, x86_64 (AVX2 supported), N=100k:

| op (f32) | `.map` / `.reduce` | tight scalar loop | bun:simd |
| --- | --- | --- | --- |
| `mulScalar(a, 3)` | 808 µs | 60 µs | 30 µs |
| `add(a, b)` | 884 µs | 73 µs | 40 µs |
| `sum(a)` | 574 µs | 43 µs | 17 µs |
| `dot(a, b)` | 716 µs | 51 µs | 24 µs |

The wasm path beats a tight scalar loop by ~2× and JS array methods by ~20-50×. Above ~4 MiB the zero-copy path adds another ~10-15% by skipping the HtoW transfer.
