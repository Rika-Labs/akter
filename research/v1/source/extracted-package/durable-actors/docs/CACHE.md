# Cache policy

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Do not add Redis to the minimum correct deployment. Start with activation-local bounded Effect caching for recomputable data. Cache contents disappear on passivation or crash without changing correctness. Add an application-shared Valkey service only when measured cache reuse across activations or gateway workloads justifies its baseline cost.

## Interface semantics

Keys are actor/app scoped by the provided capability. Every entry has a bounded size and TTL policy. Cached reads may be stale. Cache errors default to a controlled miss for optional optimizations; avoid cascading retries into expensive source overload. Use request coalescing with bounded concurrency to prevent stampedes.

A cache cannot be the only source of order status, a deduplication receipt, a fencing token or a quota that must never be exceeded. Invalidation after a local commit is an asynchronous side effect. Include revision in keys or validate cached revision against the actor's current version where needed.

## Why Valkey is the later default

The RESP ecosystem offers operational familiarity and compatible clients. Valkey provides a sensible self-host path; Redis, Dragonfly, Garnet and Upstash remain alternatives with different command coverage, licensing, cost and scaling tradeoffs. The framework exposes cache semantics, not arbitrary Redis commands. Do not provision one server per actor.

## Bounded resource rules

Cap process memory per actor and total process cache. TTL expiry must not be the only limit. Namespace by environment/incarnation to avoid stale values after restore. Observe hit/miss ratio, bytes, eviction, fill latency and stampede suppression. Never use actor ID as an unbounded metric label in Prometheus.

## Acceptance test

Run the application with cache disabled, flushed, unavailable and intermittently stale. Functional results must remain correct. Compare the total provider/compute cost with and without cache, including invalidation/fill traffic. Adopt shared cache only if that experiment gives a clear win.

## Sources and evidence

- [A04: Valkey](https://valkey.io/) — Shared ephemeral cache candidate; loss must not affect correctness.
- [A05: Redis docs](https://redis.io/docs/latest/) — Compatibility/licensing and hosted service options require current terms.
- [A06: Dragonfly](https://www.dragonflydb.io/docs/) — Alternative cache; command compatibility and licenses are not assumed identical.
- [A07: Garnet](https://microsoft.github.io/garnet/) — Alternative RESP implementation; assess only if cache is actual bottleneck.
- [A08: Upstash Redis](https://upstash.com/docs/redis/overall/getstarted) — Managed cache option; request/connection/latency economics vary.
- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
