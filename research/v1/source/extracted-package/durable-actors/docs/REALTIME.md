# Realtime delivery

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Choose HTTP requests for commands and SSE for one-way observation first. WebSocket is a later transport for workloads that truly need bidirectional connection semantics. Both address the same authorized actor protocol and retained event feed.

## Connect without a snapshot gap

A client requests a snapshot plus an event cursor representing that snapshot, then subscribes after the cursor. Both must have a coherent ordering relation. An independent snapshot read followed by a live PubSub subscription can miss changes between the two. Use journal replay to bridge that race.

## Gateway design

Gateways authenticate every connection, scope authorization to application/environment/actor, and enforce subscription quotas. They maintain bounded upstream subscriptions and fan out events. A sleeping actor need not remain activated merely because many clients watch its retained history. The gateway can use source notifications and replay service reads according to a tested architecture.

SSE event IDs are retained cursors. Honor Last-Event-ID or an explicit cursor. Send keepalive comments, document proxy buffering/timeouts, and cap queued bytes per connection. Disconnect slow consumers with a replayable cursor rather than retaining unbounded memory. Reauthentication/authorization changes must revoke existing subscriptions.

## Ephemeral versus durable

Presence, typing indicators and connection pings can be ephemeral broadcasts. Mutations, task completion and important domain transitions should be retained. A successful broadcast means best-effort handoff to connected consumers, not that all clients rendered it.

## Scaling claim

Hundreds of connected clients do not imply hundreds of concurrent actor mutations. They share an actor coordination boundary and a gateway fan-out path. Benchmark connection memory, bytes/sec, reconnect storms and hot-key mutation throughput separately. A projection actor can be a useful named view, but does not remove its own per-actor serialization ceiling.

## Cross-runtime verification

Run identical SSE framing/cursor tests under Bun and Node adapters. Include socket close, client abort, HTTP proxy idle timeout, graceful runner restart, slow readers, binary payload conversion and Unicode boundaries. HTTP/stream compatibility is more important than a synthetic hello-world throughput number.

## Sources and evidence

- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
- [B01: Bun Node compatibility](https://bun.com/docs/runtime/nodejs-compat) — Bun tracks Node compatibility; compatibility is not completeness and requires our own production path tests.
- [B08: Bun HTTP server](https://bun.com/docs/runtime/http/server) — Server/WebSocket APIs belong in Bun adapter, not portable actor core.
- [D01: Railway monorepos](https://docs.railway.com/guides/monorepo) — Service build/start boundaries and watch paths.
