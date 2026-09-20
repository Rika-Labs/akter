# Open questions with decision owners

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

| Question | Proposed resolution | Next evidence |
|---|---|---|
| Exact public actor client syntax | One canonical Effect RPC-derived client, convenience submit/request | Compile representative API/type tests |
| Default mutable-turn API | Effect handler under runtime-bound DB tx with explicit staged intents | Type/lint limitations and unsafe escape-hatch review |
| Remote sink fencing | DB-side installed monotonic fence and same-tx check | Provider failpoint test |
| How local outboxes are discoverable | Register recoverable relay work before retiring inbound command | Crash/high-water concurrency test |
| Required Turso engine/contract | libSQL-compatible endpoint with tested capabilities | Vendor answers + G02 |
| Railway per-runner identity | Explicit addressable services initially | G06 |
| Workflow bridge API | Named workflow inputs and completion routes | G10 |
| Table descriptor scope | Limited scalar codecs, metadata/DDL registration, not ORM | Migration/projection prototype |
| Effect EventLog reuse | Only if journaling order/tx fits; otherwise simple actor SQL journal | Transaction semantics spike |
| Effect/Vite exact package | Optional development integration only after version/API verification | Source/registry/plugin smoke |
| Alchemy selected API/provider | Pin one verified edition and provider set | Infra preview in test account |
| All Effect diagnostic rules | Explicit installed rule inventory + error severity + sentinel | G01 |
| License and public scope | Apache-2.0 recommended, owner approval needed | Legal/maintainer decision |
| Public rate card | No fixed rates until amplification costs measured | G12 + actual vendor quotes |
| Multi-tenant code hosting | Not initial; separate isolated deployments | G08 security review |

The owner is the founding engineering team unless otherwise assigned. The repository must not convert these conditional choices into claimed implemented guarantees merely to remove TODOs.

## Sources and evidence

- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
- [E12: Effect Oxlint integration guide](https://github.com/Effect-TS/tsgo/blob/main/docs/README.md) — Resolve the patching/configuration syntax from the selected version, not an invented plugin interface.
- [E14: Effect Vite integration](https://github.com/Effect-TS/effect/tree/main/packages/vite) — Candidate integration; availability and APIs require compatibility gate. Do not invent effect/vite imports.
- [D05: Alchemy](https://alchemy.run/) — Infrastructure-as-code choice; resolve exact version/provider support before runnable stack.
- [T01: libSQL versus Turso Database](https://docs.turso.tech/libsql) — The maintained SQLite fork and newer Rust rewrite are different engine/driver compatibility targets.
