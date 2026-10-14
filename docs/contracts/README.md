# Runtime contracts

Status: proposal (0.2), owned by ADR 0124; promoted when every contract it indexes is promoted. No indexed contract is fully promoted yet; each one's status line names its normative sections and the items still waiting for evidence.

**Responsibility:** index the runtime contracts and their authority order.  
**Authority:** normative 0.2 target on `main`; the 0.1 contracts ended with the swap from `rewrite/0.2`.  
**Owner role:** runtime architecture.  
**Change policy:** a contract change requires an ADR, updated failure evidence, and an API and versioning review.

These documents define the 0.2 guarantees. Each starts as a proposal owned by one of [ADRs 0124–0137](../decisions/README.md#02-rewrite-proposed) and is promoted, section by section where its status line says so, when the failure evidence of its milestone lands. Until a clause is promoted, code may still implement 0.1 behavior that the clause replaces; the clause is the target, not a claim of support. Where a clause and an accepted ADR disagree, stop and record an ADR.

The public distribution is `@rikalabs/akter` with three entries:

- `@rikalabs/akter`: `Actor`, contracts, `Caller`, errors and the Effect client;
- `@rikalabs/akter/server`: `Akter.serve`, `Store.s3`, `Store.fileSystem`, `Store.memory` and `App.make`;
- `@rikalabs/akter/testing`: `Simulation`.

Framework conformance and the bucket-protocol suites are repository-only tools in `tooling/conformance`, not public APIs ([ADR 0111](../decisions/0111-framework-verification-workspace.md)). The seeded `Simulation` is the public testing entry at `@rikalabs/akter/testing`; its implementation and conformance harness remain repository code. Repository placement is defined by [repository structure](../architecture/repository-structure.md).

Key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Invariant ids (I1–I9) and failure ids (F1–F27) name rows of the 0.2 verification matrix, written in E1.

| Contract                                                              | Owner    | Promoted at |
| --------------------------------------------------------------------- | -------- | ----------- |
| [Actor identity and authority](01-actor-authority.md)                 | ADR 0126 | E2          |
| [Actions](02-actions.md)                                              | ADR 0125 | E1          |
| [Durability, identity and outcomes](03-durability.md)                 | ADR 0124 | E2          |
| [Messaging](05-messaging.md)                                          | ADR 0126 | E3          |
| [Storage](06-storage.md)                                              | ADR 0127 | E2 and E6   |
| [Realtime: state, views, presence, events and `find`](07-realtime.md) | ADR 0130 | E4 and E7   |
| [Jobs, timers and cron](08-background-work.md)                        | ADR 0129 | E3 and E5   |
| [Failure and recovery](09-recovery.md)                                | ADR 0126 | E2          |
| [Security and tenancy](10-security.md)                                | ADR 0130 | E2 and E4   |
| [Error model](error-model.md)                                         | ADR 0128 | E1 and E4   |
| [Wire protocol](protocol.md)                                          | ADR 0130 | E4          |

The number 04 is intentionally unused: the 0.1 receipt contract merged into [durability](03-durability.md).
