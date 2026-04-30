---
title: ParaScript
description: Parabun's optional TypeScript dialect. Parse-time desugarings — output is standard JavaScript.
---

**ParaScript** is the language Parabun ships alongside its runtime. Files ending in `.pts` (or `.ptsx`) are parsed with the extensions described below — purity, error chaining, pipelines, ranges, reactivity, edge-triggered handlers — and lower to standard JS at parse time. Nothing in the runtime depends on the syntax. Plain `.ts` / `.tsx` files behave exactly as in upstream Bun.

The same extensions also work over plain JavaScript in `.pjs` / `.pjsx` files. We don't lead with that path — `.pts` is the canonical ParaScript surface — but it's there if you need it.

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

## `signal`, `effect`, `~>`, `->`, `when`

`signal NAME = <rhs>` declares a reactive cell. Bare reads desugar to `.get()`, assignments to `.set()`. If the RHS references another in-scope signal, the binding auto-promotes to a read-only `derived()`. `effect { ... }` tracks every signal it reads and re-runs on change.

`A ~> B` is a reactive **assignment** binding. It desugars to `effect(() => { B = A; })`, so `B` stays in step with `A` and whatever signals `A` reads from.

`A -> fn` is a reactive **call** binding — the call-sink complement to `~>`. It desugars to `effect(() => { fn(A); })`, so `fn` is called with the latest value of `A` whenever its tracked deps change. RHS must be a callable target (identifier, `obj.method`, or `arr[i]`) — bare calls, literals, and arrows are rejected.

`A ~> B when C` (and `A -> fn when C`) adds a guard. The desugar wraps the body in `if (C)` — `C` is read inside the effect so signal reads in the predicate are tracked too. Flipping `C` re-fires the effect, the body re-evaluates the guard, and only emits when it passes.

`when EXPR { BODY }` is a statement-level **edge-triggered** block. It fires `BODY` once each time `EXPR` transitions false → true. The dual `when not EXPR { BODY }` fires on the true → false edge. Both desugar to `signals.when(() => EXPR, () => { BODY })` — the `not` form pushes the negation into the predicate (`() => !(EXPR)`), since the falling edge is just the rising edge of the inverse. Distinct from suffix `when`: position disambiguates — suffix is every-truthy guard, block is edge-triggered.

```parabun
signal count = 0;
signal doubled = count * 2;   // auto-derived

effect { console.log(count, doubled); }

count++;                      // effect re-runs: 1, 2

// reactive ASSIGNMENT — el.innerHTML mirrors count
count ~> el.innerHTML;

// reactive CALL — process.stdout.write is invoked on every change
`count=${count}\n` -> process.stdout.write;

// guarded bind — only updates while `enabled` is truthy
signal enabled = true;
doubled ~> el.innerHTML when enabled;
enabled = false;              // future doubled changes don't reach el

// edge-triggered handler — fires once per false→true transition
signal motionPresent = false;
when motionPresent && enabled { console.log("greet"); }
when not enabled { console.log("disabled"); }

// paired form — bare `when not { ... }` adjacent to a `when EXPR` block
// shares its predicate and fires the inverse edge.
signal connected = false;
when connected { showOnlineBanner(); }
when not       { showOfflineBanner(); }
```

## `|>`, `..!`, `..&`, `..` / `..=`

- `x |> f` is `f(x)`. `pure` functions threaded through `|>` are inlined at parse time — no call overhead.
- `..!` is `.catch` in suffix position.
- `..&` is `.finally` in suffix position.
- `a..b` is an exclusive integer range; `a..=b` is inclusive.

```parabun
pure function sq(x: number) { return x * x; }

const result = 5 |> sq |> sq;   // 625 — both calls inlined

const json = await fetch("/api").then(r => r.json())
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
