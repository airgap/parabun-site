---
title: Language extensions
description: Optional desugarings on .pts / .pjs files. Parse-time only — output is standard JavaScript.
---

Files ending in `.pts`, `.ptsx`, `.pjs`, or `.pjsx` are parsed with extra desugarings. All of them lower to standard JS at parse time; nothing in the runtime depends on the syntax. Plain `.ts` / `.js` / `.tsx` / `.jsx` files behave exactly as in upstream Bun.

GitHub's TextMate grammars don't recognize `.pts` — install the [editor extension](/docs/install/#editor-extension) for syntax highlighting + LSP support.

## `pure` and `memo`

A `pure` function is rejected at parse time if the body mutates an outer variable, reads `this`, or calls a known-impure global. Prefix `pure` with `memo` — or drop `pure` entirely and write `memo` — and the result is cached by argument identity:

- 0-arg: singleton (computed once, returned forever).
- 1-arg: `Map<arg, result>` lookup.
- multi-arg: nested `Map` chain keyed by each argument in turn.

Recursive self-references route through the outer wrapper, so `fib(20)` runs the body 21 times instead of 21,891. Async memoization dedupes concurrent in-flight calls and evicts on reject.

```parabun
// declarator form — `memo` implies pure + function
memo fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

// arrow form — same thing as an expression prefix
const normalize = memo (s: string) => s.trim().toLowerCase();

// async dedupes concurrent in-flight calls, evicts on reject
memo async fetchProfile(id: string) { return await db.users.get(id); }
```

## `signal`, `effect`, `~>`

`signal NAME = <rhs>` declares a reactive cell. Bare reads desugar to `.get()`, assignments to `.set()`. If the RHS references another in-scope signal, the binding auto-promotes to a read-only `derived()`. `effect { ... }` tracks every signal it reads and re-runs on change.

`A ~> B` is a reactive binding. It desugars to `effect(() => { B = A; })`, so `B` stays in step with `A` and whatever signals `A` reads from.

```parabun
signal count = 0;
signal doubled = count * 2;   // auto-derived

effect { console.log(count, doubled); }

count++;                      // effect re-runs: 1, 2

// bind signal value into a DOM-ish sink — updates track dep changes
count ~> el.innerHTML;
```

## `|>`, `..!`, `..&`, `..=`

- `x |> f` is `f(x)`. `pure` functions threaded through `|>` are inlined at parse time — no call overhead.
- `..!` is `.catch` in suffix position.
- `..&` is `.finally` in suffix position.
- `..=` in a declaration is `= await`.
- `..=` in expression position is the inclusive-range marker. `0..5` excludes 5; `0..=5` includes it.

```parabun
pure function sq(x: number) { return x * x; }

const result = 5 |> sq |> sq;   // 625 — both calls inlined

const json ..= fetch("/api").then(r => r.json())
  ..! err => console.error(err)      // .catch
  ..& () => console.log("done");     // .finally

for (const i of 0..=9) emit(i);      // [0..9]
```

## `defer` and `arena`

`defer EXPR` schedules `EXPR` to run when the enclosing block exits — return, throw, or fall-through. Multiple defers in a block dispose in LIFO order. `defer await EXPR` inside an `async` function awaits the cleanup.

`arena { ... }` runs the block with the GC paused, then frees everything allocated inside on exit. Useful for tight numeric loops with short-lived intermediate allocations.

```parabun
function readConfig(path: string) {
  const fd = fs.openSync(path);
  defer fs.closeSync(fd);              // runs on every exit path
  return JSON.parse(fs.readFileSync(fd));
}

arena {
  const buf = new Float32Array(1_000_000);
  // ...numeric work...
}                                       // buf freed here, no GC pressure
```

## Diagnostics

The LSP carries arity-based hints: *"could be memo"* / *"memo probably not worth it"* on free functions, plus full purity diagnostics on `pure` bodies. The full grammar lives in [`LLMs.md`](https://github.com/airgap/parabun/blob/main/LLMs.md#language-extensions).
