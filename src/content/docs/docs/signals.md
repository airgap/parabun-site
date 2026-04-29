---
title: bun:signals
description: Reactive cells with auto-derived computations and microtask-flushed effects.
---

```ts
import { signal, derived, effect, batch, untrack, Signal } from "bun:signals";
```

`bun:signals` is a small reactive primitive. `signal(v)` is a cell, `derived(fn)` is a read-only signal computed from others, and `effect(fn)` runs side effects when something it read changes. Reads inside an effect register a dependency; writes invalidate downstream and a microtask flush re-runs only the effects whose observed values actually changed.

Pairs with the `signal` / `effect { }` / `~>` [language extensions](/docs/language/#signal-effect) — those desugar to calls into this module. Plain `.ts` / `.js` files use the function form below.

## `signal(initial)`

Creates a writable cell.

```ts
import { signal } from "bun:signals";

const count = signal(0);

count();          // read → 0
count.get();      // read → 0
count(1);         // write
count.set(2);     // write
count.update(n => n + 1);   // read-modify-write
```

`count` is callable: with no args it reads, with one arg it writes. The explicit `.get()` / `.set()` methods are also there for clarity. `update(fn)` is `set(fn(get()))` in one atomic-ish step.

## `derived(fn)`

A read-only signal computed from others. Tracks every signal `fn` reads; re-evaluates when any of them changes.

```ts
const double = derived(() => count() * 2);
double();         // 4 (after count(2))
```

`derived` is lazy — it only re-evaluates when read after an invalidation. Multiple reads between writes return the cached value.

## `effect(fn)`

Runs `fn` immediately, tracks its signal reads, and re-runs whenever any of them changes. Returns a disposer that removes the effect.

```ts
const dispose = effect(() => {
  console.log("count is", count());
});

count(3);          // logs "count is 3" on next microtask
dispose();          // stop watching
```

Effects fire on a microtask after the write, so multiple writes within the same synchronous code path coalesce into one re-run.

## `batch(fn)`

Defers effect re-runs until `fn` returns:

```ts
batch(() => {
  count(1);
  name("alice");
  // no effects re-run yet
});
// effects re-run once with both new values visible
```

## `untrack(fn)`

Reads inside `fn` don't register as dependencies — useful inside an `effect` to read a signal "for context" without making the effect re-run when it changes.

```ts
effect(() => {
  console.log(count(), "at", untrack(() => Date.now()));
  // re-runs on count change, NOT on every Date.now read
});
```

## `fromAsync(iterable, mapFn?, init?)`

Creates a signal driven by an async iterable. Saves the IIFE+for-await dance for "I want the most recent value as a Signal".

```ts
import sigs from "bun:signals";

// Most recent value from a websocket-like source, exposed as a signal.
const { signal: msg, dispose } = sigs.fromAsync(socket.messages(), m => m.body, "");

effect(() => console.log("latest:", msg.get()));

// Clean up when you're done.
dispose();
```

Returns `{ signal, dispose }`. `signal` is read-only (the pump owns writes); `dispose` breaks the loop via the iterator's `return()` and fires any generator finally block. Calling `dispose` twice is a no-op.

If `mapFn` is omitted, raw yielded values flow through unchanged. If `init` is omitted, the signal starts at `undefined`.

## `pump(iterable, signal, mapFn?)`

Drive an existing signal from an async iterable — useful when the signal pre-exists, or when you want to switch sources at runtime.

```ts
const score = sigs.signal(0);
const stop = sigs.pump(motionFrames, score, f => f.motionScore);
// later: stop();
```

Returns a disposer with the same semantics as `fromAsync`'s `dispose`.

The signal must be a writable one (returned by `signal(...)`); passing a `derived(...)` result throws.

## `Signal<T>` type

Exported for type annotations. `signal(0)` returns a `Signal<number>`; `derived(...)` returns a `Signal<T>` (read-only — TypeScript marks `.set` / `.update` as never).

## Composing with the rest of the stack

- **DOM-ish updates**: pair with `~>` ([reactive binding](/docs/language/#signal-effect)) to keep DOM elements / canvas state in step with signal values.
- **Background work**: an `effect` can dispatch a [`bun:parallel`](/docs/parallel/) `pmap` and write the result back into a signal — the next read picks it up.
- **Server-rendered fragments**: `derived(() => render(...))` recomputes only when inputs change.

## Limits

- Effects are async (microtask-flushed). For synchronous "see the new value right now" you need `batch(...)` and a synchronous read.
- Cycle detection is best-effort — a `derived(() => sigA())` where `sigA` is itself a `derived` of the first will throw at registration time, but more elaborate cycles can stack-overflow on flush.
- No ownership / scope — effects live forever unless `dispose()`d. Wrap with [`bun:arena`](/docs/arena/)-style scoping in long-lived loops.
