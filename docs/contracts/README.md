# Runtime contracts

**Responsibility:** index the runtime contracts and their authority order.  
**Authority:** normative.  
**Owner role:** runtime architecture.  
**Change policy:** contract changes require an ADR, updated conformance tests, and an API/versioning review.

These documents define the settled v4 guarantees. The public distribution is `@rikalabs/akter` with four subpaths:

- `@rikalabs/akter` — `Actor.make`, contracts, policies, errors, identity, `Actors`, serving, and auth;
- `@rikalabs/akter/runtime` — `Actors.layer`, topology, database, and migrations;
- `@rikalabs/akter/client` — browser-safe Promise client;
- `@rikalabs/akter/testing` — `ActorTest` and conformance support.

The runtime supports embedded, served, and hosted modes. Repository placement is defined by [repository structure](../architecture/repository-structure.md).

- [Actor identity and authority](01-actor-authority.md)
- [Command turns](02-command-turns.md)
- [Transactions and commit](03-transactions.md)
- [Receipts and retries](04-receipts.md)
- [Messaging and events](05-messaging.md)
- [Storage and ownership](06-storage-ownership.md)
- [Realtime continuity](07-realtime.md)
- [Workflows, schedules, and jobs](08-background-work.md)
- [Failure and recovery](09-recovery.md)
- [Security and tenancy](10-security.md)
- Control plane (a hosted-platform record, private)
- [Error model](error-model.md)
- [Wire protocol](protocol.md)
- Control-plane feature flags (a hosted-platform record, private)
