# Runtime contracts

**Responsibility:** define externally observable behavior.  
**Authority:** normative.  
**Owner role:** runtime architecture.  
**Change policy:** contract changes require an ADR, updated conformance tests, and an API/versioning review.

These documents are the promises implementation must satisfy. They are more authoritative than code examples and more specific than the vision documents.

- [Actor identity and authority](01-actor-authority.md)
- [Command turns](02-command-turns.md)
- [Transactions and commit](03-transactions.md)
- [Receipts and retries](04-receipts.md)
- [Messaging and events](05-messaging.md)
- [Storage and ownership](06-storage-ownership.md)
- [Realtime continuity](07-realtime.md)
- [Background work and effects](08-background-work.md)
- [Failure and recovery](09-recovery.md)
- [Security and tenancy](10-security.md)
