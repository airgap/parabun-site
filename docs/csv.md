---
title: bun:csv
tagline: Streaming RFC 4180 CSV parser. Async generator, full quote / escape handling, optional parallel mode.
section: modules
---

```ts
import csv from "bun:csv";
```

A single export — `parseCsv(input, opts?)` — that returns an async iterable of rows. The parser is a state machine over UTF-8 bytes; it never materializes the full file in memory regardless of size.

## `parseCsv(input, opts?)`

`input` can be:

- `Bun.BunFile` (recommended for files on disk).
- `ReadableStream<Uint8Array>` or `AsyncIterable<Uint8Array>` (for fetched content, pipes, sockets).
- `Uint8Array` or `string` (for in-memory).

```ts
import csv from "bun:csv";

for await (const row of csv.parseCsv(Bun.file("data.csv"), { header: true })) {
  process(row.id, row.name, row.score);
}
```

| Option | Default | Description |
| --- | --- | --- |
| `header` | `false` | When true, the first row is the column names; subsequent rows are emitted as objects keyed by column. When false, rows are `string[]`. |
| `delimiter` | `","` | Single-character cell separator. |
| `quote` | `"\""` | Single-character quote that wraps cells with embedded delimiters / newlines. |
| `escape` | same as `quote` | RFC 4180 doubles the quote (`""`) to escape; some dialects use `\\"`. |
| `comment` | none | If set, lines starting with this character are skipped. |
| `inferTypes` | `true` (with `header`) | Per-cell type inference: numeric → `number`, `true` / `false` → `boolean`, empty / `null` → `null`. Plain strings pass through. |
| `parallel` | `false` | See below. |

Without `header`, every row is an array of strings (no inference — keeps fast-path simple).

## Parallel mode

`parallel: true` chunks the input across [`bun:parallel`](parallel/)'s worker pool when the input has no quoted cells (the byte-boundary heuristic doesn't work otherwise). It runs the parse off the main thread.

```ts
for await (const row of csv.parseCsv(Bun.file("data.csv"), { header: true, parallel: true })) {
  // row processed off main thread
}
```

This is **not a per-file speedup**. The serial state machine is already memory-bandwidth-bound, and the parallel path's materialize-and-fork overhead grows with input size. Sweep on a 16-core x86 release build:

| Fixture | Serial (med) | Parallel (med) | Speedup |
| --- | --- | --- | --- |
| 5 MB · 128k rows | 152 ms | 129 ms | 1.18× |
| 50 MB · 1.25M rows | 1446 ms | 1528 ms | 0.95× |
| 200 MB · 4.92M rows | 5892 ms | 6363 ms | 0.93× |

Use `parallel: true` to keep the event loop responsive while parsing (parsing N files concurrently does scale across cores), not because you expect bigger files to go faster. `bench/parabun-csv-parallel/` reproduces the numbers.

## Bridging to columnar

`bun:csv` rows pair naturally with [`bun:arrow`](arrow/)'s `fromRows`:

```ts
import csv from "bun:csv";
import arrow from "bun:arrow";

const rows: any[] = [];
for await (const row of csv.parseCsv(Bun.file("data.csv"), { header: true })) rows.push(row);
const tbl = arrow.fromRows(rows);

arrow.mean(tbl.column("score"));
```

For very large CSVs, batch the bridge — call `arrow.fromRows` per N rows instead of materializing them all first.

## Limits

- Multi-byte delimiters / quotes aren't supported. RFC 4180 specifies single-byte for both.
- Parallel mode requires the input has no quoted cells (otherwise byte-boundary chunking can split a quoted region).
- Type inference is per-cell — there's no whole-column type promotion. If column `score` has mostly numbers and one `"N/A"`, you get a mix of `number` and `string`; coerce on your end if that's a problem.
