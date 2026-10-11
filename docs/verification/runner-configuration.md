# Runner shutdown configuration

`packages/akter/src/runtime/runner.test.ts` rejects a missing guard, a strict inequality that rejects equality, an uncapped configured refresh, failure to apply default termination timeouts, an untyped refusal, and changed accepted configuration values.

```sh
bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/runtime/runner.test.ts
```

The boundary cases are independent constants: 35-second expiration with 10-second refresh permits 25 seconds, with 5-second refresh permits 30 seconds, and a 3-second expiration with default refresh permits 2 seconds. Each permits equality and refuses one additional millisecond. A 30-second expiration with a 60-second configured refresh permits 20 seconds because the effective refresh is capped at 10 seconds.

These tests exercise synchronous public configuration and its resulting layer, without starting sockets or touching a database. No durable transition is added by the guard. The separate real Postgres database multi-runner and crash drills remain the authority for runtime ownership and recovery behavior; this guard does not expand their support claim.

The existing layout-refusal drill uses an explicit 2-second termination timeout so its 3-second lease case reaches the database layout check, with its assertions unchanged:

```sh
TEST_DATABASE_URL=postgres://project:project@127.0.0.1:55493/project bun --bun node_modules/vitest/vitest.mjs run tooling/conformance/src/conformance/crash/drills/production.test.ts -t 'fails closed on a different shard layout'
```
