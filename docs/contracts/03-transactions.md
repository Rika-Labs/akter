# Transactions and commit

**Responsibility:** define atomic local facts.  
**Authority:** normative.  
**Owner role:** storage/runtime.  
**Change policy:** every adapter must run the same transaction conformance suite.

One actor turn transaction includes, when used:

- owned business rows;
- command receipt;
- durable events;
- timer records;
- outgoing messages;
- activity, job, and workflow intents;
- ownership/version fences.

Nothing externally visible may be published before the outer transaction commits. Savepoints do not create an external commit boundary.

External calls, WebSocket writes, unbounded streams, and long model calls are outside this transaction. Their intent is recorded locally and delivered after commit.

Ordinary Postgres can provide this boundary within one transaction domain. A sharded backend must explicitly prove locality; SQL protocol compatibility alone is insufficient.
