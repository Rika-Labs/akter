---
title: "Operator forks"
description: "Branch an actor's retained history into a new actor with a separately granted operator."
---

# Operator forks

A fork copies one actor's state and list roots at a past position into a new actor, so you can inspect or branch history. Forks are operator tools. They are not actor members and are not available at `/rpc`.

## Fork from the command line

```sh
akter fork Room source --at 12 --to branch --app src/app.ts --directory .akter
akter fork Room source --before 2026-10-12T18:00:00Z --directory .akter --to-directory .akter-branch
akter fork Room source --offset 45 --index 2 --directory .akter --to branch
akter fork Room source --at 12 --bucket example --prefix live/ --to-prefix branch/
```

Pass the actor type and the source id. Choose exactly one source: `--directory` or `--bucket` (with optional `--prefix` and `--endpoint`). Choose exactly one position:

| Flag                       | Position                                   |
| -------------------------- | ------------------------------------------ |
| `--at <version>`           | A durable command count for the actor      |
| `--before <timestamp>`     | The state before an ISO timestamp          |
| `--offset <n> --index <i>` | A segment offset and entry index; use both |

Other flags: `--to` (target id), `--to-directory`, `--to-prefix`, `--app` (default `src/app.ts`), `--with-work`, `--json-ids`, and `--token-env`.

The application module must export its `App` as the default export and an `authorizeOperator(token)` function that returns an Effect with an operator grant. The token comes only from `AKTER_OPERATOR_TOKEN`, or the variable named by `--token-env`. It is never printed or saved. The authorizer must authenticate the operator independently of application clients. S3 credentials use the SDK credential chain, and endpoint URLs cannot carry credentials.

The fork needs a grant with the `fork` capability for the source actor and tenant.

## From code

A trusted operator can call `Forks.fork(engine, options, sourceStore?)` from `@rikalabs/akter/server`. The source store defaults to the engine's own store. `Forks.run(app, sourceStore, targetStore, options)` opens a temporary local operator engine, installs the fork, and drains it.

## Ids

Ids are decoded and re-encoded with the actor's key schema. By default a literal string is tried before schema-encoded JSON. Use `--json-ids` to force JSON for both ids, including when a union admits both strings and numbers:

```sh
akter fork Numeric 17 --json-ids --at 1 --to 29 --directory .akter
```

If the key schema cannot accept a derived UUID, pass an explicit `--to`.

## What a fork copies

An actor version counts durable commands. Internally a position is `(shard, offset, entry index)`, because one segment can hold several commands.

- A fork copies state and list roots. It does not copy client deduplication state, presence, or pending sends.
- With `--with-work`, it also copies pending timers (with new ids) and open jobs (with new ids and their completed steps).
- A fork of a fork starts at version zero and can itself be forked.

## Limits

- The CLI owns the target store while it runs. Stop other runners that use the same target, or use a fresh directory or prefix while the source stays live. The in-process API can fork while the source is being written.
- A new target takes the source's shard count.
- Only the `default` tenant is supported. Other scopes are refused.
- Fork admission reads the effective retention when the request starts. A position between the old and new windows is allowed after widening only if its reconstruction data remains, and refused after narrowing. Trimmed history stays gone. A position older than every retained checkpoint is refused with `ForkRefused("retention")` when it is outside retention.
- If a delete's outcome is unknown, GC stays blocked rather than risk deleting a reachable page. If a publication's outcome is unknown, GC is blocked until the publication epoch expires, 60 seconds after its claim. There is no automatic reset command.

See the [evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e6-pages-history.md) for backend and performance limits.
