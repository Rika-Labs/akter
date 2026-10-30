# Actor and shard lifecycle

An actor is durable state and obligations, not a resident JavaScript object. Residency is a cache. A shard opens from its newest intact checkpoint plus a gapless segment tail and obtains a new create-once epoch before serving. Missing or corrupt data refuses recovery; it never substitutes the decode of `{}` for an existing actor.

A new actor starts from its state schema's decoding defaults. Commands execute one at a time per actor in admission order and may run on earlier speculative shard state. Copy-on-write drafts and staged work become visible only when the segment is durable.

Idle actors can stop being resident while their manifests, lists, timers, sends, and jobs remain in the store. A page miss pauses synchronous execution, loads outside the handler, and reruns with identical recorded inputs. Page-backed residency and GC are E6 guarantees; local cached reads alone do not prove them.

On drain the runner becomes unready, stops admission, flushes, checkpoints, appends `Released`, and reports each shard's durable offset and `nextDue`. A clean handoff permits the next release to open; an unclean tail requires its matching build. A stopped store needs a host to restart it for due work—no process can wake itself after all runners stop.

The drain report adds optional top-level `actions` and `jobSeconds` totals since runner open, including work on shards already released or lost. Attempt finalizers settle the local interval before the report is read. These attribution counters stay with the runner, not with a checkpoint or a shard's next owner; replay never replenishes them.

See [recovery](../contracts/09-recovery.md) for promotion status and [jobs](../../core/jobs.md) for journaled work.
