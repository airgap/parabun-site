---
title: bun:arrow
tagline: In-memory columnar tables, computes, and Arrow IPC reader/writer — wire-compatible with apache-arrow, pyarrow, polars, duckdb.
section: modules
---

```ts
import arrow from "bun:arrow";
```

Apache Arrow's columnar model, in-process, with no npm dep on `apache-arrow`. RecordBatches are typed-array views with optional validity bitmaps; tables are sequences of batches sharing a schema. The Arrow IPC streaming + file formats round-trip both directions against the canonical implementations.

## Building tables

### `recordBatch({ ... })`

Takes a map of column name → values and infers per-column type. Values can be:

- A typed array — `Int32Array` → `int32`, `BigInt64Array` → `int64`, `Float32Array` → `float32`, `Float64Array` → `float64`, `Uint8Array` → `bool`.
- A `string[]` → `utf8`.
- A `T[][]` (array of arrays) → `list<T>` with the child type inferred from the flattened first non-empty row.

```ts
const batch = arrow.recordBatch({
  age:    new Int32Array([25, 30, 35]),
  score:  new Float64Array([0.95, 0.82, 0.71]),
  name:   ["alice", "bob", "carol"],
  tags:   [["a", "b"], [], ["c", "d", "e"]],   // list<utf8>
});

batch.numRows;                    // 3
batch.column("age").get(0);       // 25
batch.column("tags").get(2);      // ["c", "d", "e"]
```

### `table(batches)`

Concatenates batches sharing a schema. `Table` has a `.column(name)` that returns a `ConcatColumn` — a virtual view across batches. Pass it to any compute function for a table-wide aggregate.

### `fromRows(rows, opts?)` / `toRows(source)`

Bridge between row-shaped JS data and the columnar form. `fromRows` is the typical entry point from [`bun:csv`](csv/) output:

```ts
import csv from "bun:csv";
import arrow from "bun:arrow";

const rows: any[] = [];
for await (const r of csv.parseCsv(Bun.file("data.csv"), { header: true })) rows.push(r);
const tbl = arrow.fromRows(rows);
```

## Compute primitives

All take a `Column` or `ConcatColumn`. Numeric reductions return a single scalar; predicate-style return a column or new batch.

| Function | Description |
| --- | --- |
| `sum`, `mean` | Kahan-compensated sum / mean. |
| `min`, `max` | Skips nulls. NaN propagation matches IEEE 754. |
| `argMin`, `argMax` | First-occurrence tie-break, NaN-aware. |
| `count` | Counts non-null entries. |
| `variance(col, { ddof? })`, `stddev` | Welford accumulator. `ddof=0` (population) by default. |
| `quantile(col, q)`, `median(col)` | Sorts internally; honor nulls. |
| `distinct(col)` | Returns the unique values as a typed array (or string set for utf8). |
| `cumsum(col)`, `diff(col)` | New column of running totals / first differences. |
| `concat(col)` | Materializes a `ConcatColumn` into a single typed array. |

### `filter(batch, predicate)`

Returns a new RecordBatch keeping rows where `predicate(row)` is truthy. Predicate sees a row-shaped object keyed by column name.

```ts
const adults = arrow.filter(batch, row => row.age >= 30);
```

### `groupBy(batch, keys, aggs)`

Hash group-by. `keys` is a string or array of column names; `aggs` is a map of output-name → `{ column, op }`. Supported ops: `sum`, `mean`, `min`, `max`, `count`, `variance`, `stddev`, `distinct`.

```ts
const result = arrow.groupBy(batch, "city", {
  rows:    { column: "name",  op: "count" },
  avgAge:  { column: "age",   op: "mean"  },
  topScore:{ column: "score", op: "max"   },
});
```

### `sort(batch, by, opts?)`

Stable sort by one or more keys. `by` is `string | string[] | { name, descending?: boolean }[]`. Returns a new batch with rows reordered.

## Arrow IPC

### Streaming format

```ts
const bytes = arrow.toIPC(table);          // Uint8Array
const restored = arrow.fromIPC(bytes);     // Table
```

Continuation-prefixed `Schema` + `RecordBatch` messages, FlatBuffers metadata (hand-rolled builder/reader; no npm dep), 8-byte-aligned body buffers, EOS marker. `DictionaryBatch` decode is implemented for round-tripping apache-arrow's default `Dictionary<Utf8>` for string columns.

### File format

Pass `"file"` as the second arg to write the `ARROW1`-bracketed file format:

```ts
const fileBytes = arrow.toIPC(table, "file");   // ARROW1 + messages + EOS + Footer + len + ARROW1
const restored = arrow.fromIPC(fileBytes);      // auto-detects via head/tail magic
```

The Footer flatbuffer carries a redundant copy of the schema plus a list of `Block { offset, metaDataLength, bodyLength }` entries pointing at each RecordBatch / DictionaryBatch — random-access on read.

`fromIPC` auto-detects: if the bytes start with `ARROW1\0\0` and end with `ARROW1` the file path is taken (Footer's schema and Block list drive the decode); otherwise it falls through to the streaming reader. Same callsite, both formats.

### Type coverage

| Logical kind | In-memory storage | IPC type ID | Notes |
| --- | --- | --- | --- |
| `int32` | `Int32Array` | `Int(32, signed)` | Reads narrow int8/int16/uint8/uint16 by widening. |
| `int64` | `BigInt64Array` | `Int(64, signed)` | Reads uint32 by widening (zero-extend). uint64 throws — no lossless target. |
| `float32` | `Float32Array` | `FloatingPoint(SINGLE)` | |
| `float64` | `Float64Array` | `FloatingPoint(DOUBLE)` | |
| `bool` | `Uint8Array` (one byte/value) | `Bool` | Bit-packed on the wire. |
| `utf8` | `string[]` | `Utf8` | |
| `list<T>` | `Int32Array` offsets + recursive child column | `List` | Depth-first FieldNode + buffer walk. Lists of lists work. |

Date / Time / Timestamp from upstream Arrow streams are coerced to int32 / int64 on read (unit and timezone metadata dropped). Round-tripping re-emits them as plain ints.

### Wire compat

`bench/parabun-arrow-ipc-interop/` round-trips both directions against `apache-arrow@21.1.0`:

- Parabun encodes streaming + file → apache-arrow decodes.
- apache-arrow encodes streaming + file (including default `Dictionary<Utf8>` strings + `Date64`) → Parabun decodes.

Mixed type table (`Int8`, `Uint16`, `Uint32`, `Int32`, `Float64`, `Date64`, `Dictionary<Utf8>`, `List<Float64>`) round-trips bit-for-bit through both formats.

### Output you can read elsewhere

The bytes Parabun produces are the same wire format pyarrow, arrow-rs, nanoarrow, polars, and duckdb consume on the streaming + file paths. Save with `.arrow`:

```ts
await Bun.write("data.arrow", arrow.toIPC(table, "file"));
```

Then in Python:

```py
import pyarrow.feather as feather
df = feather.read_table("data.arrow")
```

## What's not here yet

- **Parquet** — separate format with its own thrift metadata + page-level encodings. Tracked.
- **Struct / Map / FixedSizeList / Union / Decimal128 / FixedSizeBinary** — nested + decimal types. The `List<T>` shape proves out the recursive FieldNode + buffer walk; the others reuse it.
- **Dictionary delta batches** (`isDelta=true`) — apache-arrow's default is non-delta, so this is a long-tail follow-up.
- **uint64** — no lossless 64-bit unsigned representation in JS Number / BigInt without losing range.
- **Lossless narrow-type round-trip** — Parabun reads int8 by widening to int32, then writes int32. Lossless on values, lossy on the type tag. A typed wrapper that remembers wire types can land if there's a use case.
