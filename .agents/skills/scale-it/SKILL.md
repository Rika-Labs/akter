---
name: scale-it
description: Estimates and load-tests what breaks between 10 and 100k users, locally or in development, never production. Use for "will this hold up", "load test", "how fast is it", or any new endpoint, query, list, feed or fan-out.
---

# Scale it

Done: the first bottleneck is named with evidence, and you know whether p99 stays under 1 s at each load.
Nothing a user waits on may take seconds. Label every figure measured or projected.

1. **Estimate.** One row per user action:

   | Action | RPC requests | Store reads/appends | Connections | Memory | External calls and limits |
   | ------ | ------------ | ------------------- | ----------- | ------ | ------------------------- |

   At 10, 1k and 100k users (1 action per user per 10 s unless known): arrival rate, concurrent
   connections, pages per read, and what breaks first (bucket latency, hot shard, full scan, unbounded
   list, fan-out writes, memory per connection, provider rate limit, single-writer actor).

2. **Measure** on your own stack (`../prove-it/references/stack.md`) with realistic volume; say which actors
   and lists stay at test size. Protocol-correct HTTP journeys with k6, single endpoints with oha:
   [references/load.md](references/load.md). Watch bucket operations, shard load, CPU and memory to
   name the limiter. If the load generator saturates the machine first, say so.
3. **Decide.** Fix or write down the first bottleneck and re-measure. Extrapolate to 100k only from a
   measured curve, labeled projected.

**Reply:** the estimate table; p50, p99, errors and rps per journey and endpoint with run counts; maximum
load sustained; the first bottleneck with evidence; what 100k needs, by impact; whether the bar holds.
