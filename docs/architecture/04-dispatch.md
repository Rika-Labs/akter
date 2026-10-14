# Dispatch and fencing

```text
/rpc -> authenticate -> access -> route to shard owner
     -> admit stable command id -> synchronous draft
     -> create-once segment -> publish reply and staged consequences
```

Admission records the caller and inputs. Client command ids expire after ten minutes; a retry uses the same id and encoded request. A repeated id returns its durable outcome; changed input is rejected. Derived sends, timers, and job calls use stream identities and sequence watermarks rather than arbitrary client-id buckets.

One actor executes actions in admission order. The shard can group actions into a segment and run dependents speculatively, but a lost segment discards every draft and consequence that depends on it. Replies, views, events, sends, and job starts wait for durability.

A segment is created once at the next offset. A racing open creates a new epoch and fences stale owners through the log, not a lease clock. An ambiguous append is resolved by reading the segment identity; it is never answered as success from memory. A failed verification closes reads and writes until authority can be reestablished.

Cross-shard sends are durable obligations retried with their original identity. A target rejection is recorded at the target and visible through telemetry and inspection; it has no dead letter or reply to the sender. See [messaging](../contracts/05-messaging.md) and [durability](../contracts/03-durability.md).
