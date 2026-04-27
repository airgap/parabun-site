---
title: bun:arena
tagline: A pool of SharedArrayBuffer typed arrays. Per-chunk work doesn't allocate a fresh buffer.
section: modules
---

```ts
import arena, { Pool, scope } from "bun:arena";
```

A small allocator: a pool of `SharedArrayBuffer`-backed typed arrays drawn from a pre-warmed pool, returned at the end of an `arena { }` block (or programmatically via `release()`). Used internally by [`bun:parallel`](parallel/) and [`bun:pipeline`](pipeline/) so per-chunk work doesn't allocate a fresh buffer every time.

## `arena { ... }` — block form

A language-level block that frees everything allocated inside on exit:

```parabun
arena {
  const buf = new Float32Array(1_000_000);
  // numeric work
}                                       // buf freed here, no GC pressure
```

The block desugars to a `scope()` call internally; see the [language extensions](language/#defer-and-arena) page.

## `Pool` — programmatic

```ts
const pool = new Pool({ size: 1024 * 1024 * 64 });    // 64 MiB pool

const buf = pool.alloc("f32", 1_000_000);
// ...work with buf...
pool.release(buf);
```

| Method | Description |
| --- | --- |
| `pool.alloc(type, length)` | Returns a typed array (`Float32Array`, `Float64Array`, `Int32Array`, `Uint8Array`, ...). Backing memory is reused from previously-released allocations of the same shape when available. |
| `pool.release(arr)` | Returns the buffer to the pool. |
| `pool.reset()` | Drop all live allocations + zero the pool. Use for tests; in production rely on scope-based release. |

## `scope(fn)`

Runs `fn` with a fresh sub-pool. All `alloc` calls inside `fn` are released when `fn` returns — the same semantics as the `arena` block, exposed as a function for plain `.ts` / `.js` files.

```ts
import { scope } from "bun:arena";

const result = scope(p => {
  const buf = p.alloc("f32", N);
  return process(buf);
});
// buf is back in the pool by the time `result` is computed
```

## When it pays off

`bun:arena` matters when you have:

- Tight inner loops allocating short-lived intermediate buffers.
- A tail-of-microtask allocation pattern that the GC doesn't reach in time.
- Multi-worker / multi-thread code where SAB-backed buffers can be passed by handle.

It doesn't matter for cold-path object allocations, async / await ceremony, or anything where the allocation cost is dwarfed by the work itself.

## Limits

- Pool size is fixed at construction. Repeated growth would defeat the point — pre-size for your peak working set.
- Returned buffers are zero-filled on `alloc` for safety. A `noClear` flag is on the roadmap for callers that overwrite immediately.
- Pool entries are typed-array-shape-keyed: a 1MB `Float32Array` and a 1MB `Float64Array` don't share. The internals could be byte-keyed, but the per-shape pool keeps the alloc path branch-free.
