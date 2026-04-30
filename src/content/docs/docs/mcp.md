---
title: para:mcp
description: Model Context Protocol client. Stdio + WebSocket transports. Composes with para:assistant's tool dispatch.
---

```ts
import mcp from "para:mcp";
```

A Model Context Protocol client. Two transports for v1 — stdio (subprocess over newline-delimited JSON-RPC 2.0) and ws (WebSocket text frames) — plus the structural surface [`para:assistant`](/docs/assistant/) reuses for its `tools:` option. Out of scope for v1: server hosting, HTTP / SSE transport, OAuth wrappers, resources / prompts surfaces (`tools/*` only).

## `mcp.connect(transport, target, opts?)`

Connects to a remote MCP server. Performs the `initialize` handshake, sends `notifications/initialized`, fetches `tools/list`, and returns a connection object whose `tools` array is populated.

```ts
// Stdio: spawn a server process, talk over its stdin/stdout
await using conn = await mcp.connect("stdio", "/path/to/server", {
  args: ["--config", "/etc/server.toml"],
  env: { ...process.env, FOO: "bar" },
});

// WebSocket: connect to a long-running daemon
await using conn = await mcp.connect("ws", "ws://hub.local:8080/mcp");
```

The connection is `AsyncDisposable` — `await using` releases the transport at scope exit. `close()` is also explicit and idempotent.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `protocolVersion` | `"2025-03-26"` | Override the spec version sent in `initialize`. |
| `clientInfo` | `{ name: "para:mcp", version: "0.1.0" }` | Client identifier sent in `initialize`. |

Stdio transport adds:

| Option | Default | Description |
| --- | --- | --- |
| `args` | `[]` | argv for the subprocess. |
| `env` | inherited | Environment for the subprocess. |
| `cwd` | inherited | Working directory. |

## Connection surface

```ts
conn.tools;             // ToolDescriptor[] — { name, description?, inputSchema }
conn.serverInfo;        // { name, version } | null
conn.protocolVersion;   // resolved spec version
conn.serverCapabilities; // raw capabilities object from initialize

await conn.call(name, args);   // invoke a tool, returns ToolCallResult
await conn.refreshTools();     // re-fetch the tool catalog
await conn.close();            // tear down the transport (idempotent)
```

`call` rejects with an `MCPError` (with `name`, `code`, `data` fields matching the JSON-RPC error response) when the server returns an error.

```ts
try {
  await conn.call("nonexistent");
} catch (e) {
  if (e.name === "MCPError" && e.code === -32601) {
    // method not found — handle gracefully
  }
}
```

## Composing with `para:assistant`

The connection object is structurally compatible with `para:assistant`'s `tools:` option — the assistant flattens every tool the connection exposes into its own catalog and routes calls back through `conn.call`.

```ts
import assistant from "para:assistant";
import mcp from "para:mcp";

await using conn = await mcp.connect("stdio", "home-assistant-mcp");
await using bot = await assistant.create({
  llm: "/models/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
  stt: "/models/ggml-tiny.en.bin",
  tts: "/models/en_US-lessac-medium.onnx",
  tools: [conn],   // every tool the MCP server exposes is callable mid-turn
});
await bot.run();
```

You can mix MCP connections with inline `{ name, schema, run }` tools in the same `tools:` array — the assistant flattens both into a single catalog.

## Why two transports

Stdio is the canonical MCP transport — every reference server (Anthropic's, Continue, Zed, etc.) speaks it. WebSocket isn't part of the spec yet but every long-running MCP-style daemon (smart-home hubs, IoT gateways, browser-extension bridges) needs a network-reachable variant. The two share the same `Transport` interface internally so adding HTTP / SSE later is a single new factory.

## Limits

- v1 is tools-only. Resources (`resources/list`, `resources/read`) and prompts (`prompts/list`, `prompts/get`) are part of the spec but rare in practice; we'll add them when a real consumer needs them.
- No notification surface for server-emitted events (`notifications/tools/list_changed` is recognized but ignored — call `refreshTools()` manually). A subscription API lands when an actual server pushes notifications worth handling.
- WebSocket transport assumes text frames carrying one JSON-RPC message each. Binary frames are silently dropped.
