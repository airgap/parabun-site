---
title: para:parallel
description: pmap / preduce over a persistent worker pool. SharedArrayBuffer typed arrays cross the wire by handle, not copy.
---

```ts
import { pmap, preduce, pool, Mutex, Semaphore } from "para:parallel";
```

A persistent worker pool plus a small concurrency-control toolkit. Functions are serialized via `fn.toString()`, so pmap / preduce bodies must be **pure** — no closures, no outer references, no `this`. TypedArrays passed through a `SharedArrayBuffer` cross workers by handle in `postMessage`, so per-chunk dispatch is fixed-cost regardless of input size.

## `pmap(fn, input, opts?)`

Chunked map across worker threads. Returns a typed array (or array) of the same length as `input`.

```ts
import { pmap } from "para:parallel";

pure function score(row) { return row.reduce((a, b) => a + b * b, 0); }

const rows = new Float32Array(new SharedArrayBuffer(1_000_000 * 4));
// ...fill rows...
const scores = await pmap(score, rows, { concurrency: 8 });
```

| Option | Default | Description |
| --- | --- | --- |
| `concurrency` | `cores - 1` | Number of workers. Capped at host hardware concurrency. |
| `chunkSize` | auto | Items per worker dispatch. Auto-picks based on input size + concurrency. |
| `transferable` | `true` | When `input` is `Float32Array`-over-SAB, transfer the underlying buffer rather than `structuredClone` it. |

`fn` must be pure — the pre-parser of `.pts` / `.pjs` files enforces this; for plain `.ts` / `.js`, the runtime checks `fn.toString()` and rejects free-variable references at dispatch time.

## `preduce(fn, init, input, opts?)`

Same chunking model as `pmap`, but each worker reduces a sub-range with `fn(acc, x)` starting from `init`. Workers' partial reduces are then folded with the same `fn` on the main thread. `fn` must be associative and pure.

```ts
const total = await preduce((a, b) => a + b, 0, scores, { concurrency: 8 });
```

## `pool` — explicit pool with `.map` / `.reduce` / `dispatch`

When you want lifetime control over the worker pool — e.g. long-running services that don't want to tear down + bring up workers per call — get a handle:

```ts
import { pool } from "para:parallel";

await using p = pool({ concurrency: 8, modulePath: import.meta.path });

const out = await p.map(score, rows);            // closure-aware: the pool can see local `score`
const total = await p.reduce((a, b) => a + b, 0, out);
const result = await p.dispatch("rankBatch", { batch });   // RPC
```

`p` is `AsyncDisposable` — `await using` triggers worker teardown on scope exit. `pool({ modulePath })` tells each worker which module to load up front, so dispatched function references resolve in worker scope.

### Reactive signals

| Signal | Type | When it changes |
| --- | --- | --- |
| `p.signals.workersCount` | `number` | Number of workers that have completed init successfully. Increments as each worker's init message returns; drops to 0 on `dispose()`. |
| `p.signals.queued` | `number` | Number of run-requests waiting on an idle worker. Updates synchronously on `run()` dispatch and on `drainQueue` consumption. |
| `p.signals.inflight` | `number` | Number of run-requests currently executing on workers. Updates synchronously on dispatch (incl. drain) and on message return. |

```ts
import { effect } from "para:signals";
effect(() => {
  if (p.signals.queued.get() > 0) console.log(`pool backed up: ${p.signals.queued.get()} queued`);
});
```

All three signals reset to 0 in `dispose()`.

## Concurrency primitives

`Mutex` and `Semaphore` are the standard primitives, awaitable.

```ts
const lock = new Mutex();
async function critical() {
  await using release = await lock.acquire();
  // ...one holder at a time...
}

const limit = new Semaphore(4);
async function rateLimited() {
  await using release = await limit.acquire();
  // ...up to 4 in flight...
}
```

## Tuning

`pmap` / `preduce` calibrate the worker count on first call (`disposeWorkers()` resets the pool; `_resetHeuristic()` clears the calibration cache — both are intended for tests, not production code).

The pool wins clearly when:

- The function body is real work (matrix ops, image kernels, parsing big strings — anything that runs O(N) in `chunkSize`).
- The input is large enough that per-chunk dispatch (~50 µs per worker hop) is amortized.
- Inputs are typed arrays over `SharedArrayBuffer` so transfer is by handle.

It loses when:

- The function is cheap arithmetic — JS scalar loops on the main thread are faster than crossing process / worker boundaries.
- Inputs aren't SAB-backed; per-chunk `structuredClone` of plain typed arrays makes the pool's overhead grow with input size.

For small payloads or trivial functions, [`para:simd`](/docs/simd/) on the main thread is almost always the right choice.

## Limits

- `pmap` over an iterable (not a typed array) materializes through an array first — chunking happens after that.
- Mixed-element-type inputs aren't supported; the pool typed-array detection is strict.
- One pool per process today. Multi-pool with isolated calibrations is on the roadmap.
