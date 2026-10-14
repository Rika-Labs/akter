# Operator forks

Forks are not actor members and are not exposed at `/rpc`. A trusted operator can use `Forks.fork(engine, options, sourceStore?)` from `@rikalabs/akter/server`; the source defaults to the engine's store. `Forks.run(app, sourceStore, targetStore, options)` opens a temporary local operator engine, installs the fork and drains it. Both require an authenticated `OperatorGrant` with the `fork` capability scoped to the source actor and tenant.

```sh
akter fork Room source --at 12 --to branch --app src/app.ts --directory .akter
akter fork Room source --before 2026-10-12T18:00:00Z --directory .akter --to-directory .akter-branch
akter fork Room source --offset 45 --index 2 --directory .akter --to branch
akter fork Room source --at 12 --bucket example --prefix live/ --to-prefix branch/
```

The application module must export its `App` as default and a separate `authorizeOperator(token)` function returning an Effect with a grant. The token comes only from `AKTER_OPERATOR_TOKEN`, or the variable selected by `--token-env`; it is never printed or persisted. The authorizer must authenticate the operator independently of application clients. S3 credentials use the SDK's credential chain; endpoint URLs cannot carry credentials.

Ids are decoded and re-encoded with the actor's key schema. By default a literal string is tried before schema-encoded JSON. Use `--json-ids` to force JSON for both ids, including when a union admits both strings and numbers: `akter fork Numeric 17 --json-ids --at 1 --to 29 --directory .akter`. A key schema that cannot admit a derived UUID requires an explicit `--to`.

An actor version counts durable actions. Internally a position is `(shard, offset, entry index)`, because a segment may contain several actions. Forking copies state and list roots, not client deduplication state, presence or pending sends. `--with-work` explicitly copies pending timers with new ids and open jobs with new ids and their completed steps. A fork of a fork starts at version zero and can itself be forked.

The local CLI owns the target store temporarily. Stop other runners when targeting the same store, or use a fresh directory/prefix while the source remains live. A new target adopts the source shard count. The in-process operator API can fork during concurrent source writes. Only the default tenant is currently supported; other scopes are refused, not flattened into it.

An unknown delete outcome leaves GC blocked rather than risking deletion of a reachable page; an unknown publication outcome blocks it until the publication epoch expires, 60 seconds after its claim. There is no automatic unsafe-reset command. See [E6 evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e6-pages-history.md) for backend and performance limits.

Fork admission reads effective retention (`meta/retention`, or the initial `meta/store` value) when the request begins. `Store.setRetention` or `akter retention` can change it without recreating the store. A position between the old and new windows is allowed after widening only if its reconstruction bytes remain, and refused after narrowing even before GC deletes them. Already-trimmed history stays gone. [E8e evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e8e-retention.md) covers these transitions.
