# CLI

The `akter` command comes from `@rikalabs/akter-cli`. Install it at the same version as `@rikalabs/akter`, and run it with `bunx akter` or `npx akter`. `akter --help` and `akter <command> --help` list every flag.

| Command                                                                         | What it does                               |
| ------------------------------------------------------------------------------- | ------------------------------------------ |
| [`akter dev`](#akter-dev)                                                       | Runs your app locally                      |
| [`akter storage check`](#akter-storage-check)                                   | Checks that a bucket works with Akter      |
| [`akter inspect`, `log`, `snapshot`, `replay`, `retention`](#operator-commands) | Operator requests to a running server      |
| [`akter fork`](#akter-fork)                                                     | Copies an actor's history into a new actor |

## `akter dev`

```sh
bunx akter dev
```

Imports `src/app.ts`, which must default-export an `App.make(...)`, and serves it on `127.0.0.1:8080` with a filesystem store in `.akter/store`.

| Flag             | Default                | Meaning                         |
| ---------------- | ---------------------- | ------------------------------- |
| `--entry`        | `src/app.ts`           | The app module                  |
| `--dir`          | `.akter/store`         | The store directory             |
| `--port`         | `8080`                 | The port                        |
| `--devtools`     | off                    | Sends traces to Effect DevTools |
| `--devtools-url` | `ws://localhost:34437` | Where DevTools listens          |

Every request is anonymous, so actors need an [`access`](../core/access.md) function that admits `Anonymous` callers while you develop. `/metrics` is on. If `AKTER_OPERATOR_TOKEN` is set, the operator endpoint is on too, and that token can `inspect`, read logs, snapshots, outcomes and audits, and `replay`.

## `akter storage check`

```sh
bunx akter storage check --bucket my-app-production --endpoint https://s3.example.com --region auto
bunx akter storage check --directory .akter/store
```

Runs seven probes against a bucket or a directory, and prints each result with what it measured:

1. **Conditional create race.** Concurrent writes with `If-None-Match` produce exactly one winner.
2. **Compare-and-swap race.** Concurrent writes with `If-Match` produce at most one winner.
3. **List after write.** A new key is listed right away, and a deleted key isn't.
4. **Ordered listing.** Keys list in byte order and page correctly.
5. **Overwrite refreshes last-modified.** Rewriting the same bytes moves the timestamp forward.
6. **Per-key write rate.** Rapid writes to one key succeed or are throttled, and never fail any other way.
7. **Batch delete.** One multi-key delete removes every key.

| Flag          | Default | Meaning                                                |
| ------------- | ------- | ------------------------------------------------------ |
| `--bucket`    |         | The bucket to check                                    |
| `--endpoint`  |         | The S3 endpoint, for providers other than AWS          |
| `--region`    |         | The bucket's region                                    |
| `--prefix`    |         | A key prefix inside the bucket                         |
| `--directory` |         | Check a directory instead of a bucket                  |
| `--writers`   | `16`    | Concurrent writers in each race                        |
| `--rounds`    | `10`    | Rounds of each race and of the listing probe           |
| `--writes`    | `10`    | Back-to-back writes in the write-rate probe            |
| `--settle-ms` | `2000`  | Wait between the two writes of the last-modified probe |
| `--json`      | off     | Prints one JSON document                               |

Credentials come only from the environment: `AKTER_STORAGE_ACCESS_KEY_ID`, `AKTER_STORAGE_SECRET_ACCESS_KEY` and `AKTER_STORAGE_SESSION_TOKEN`, or the matching `AWS_*` variables. The bucket, endpoint, region and prefix can also come from `AKTER_STORAGE_BUCKET`, `AKTER_STORAGE_ENDPOINT`, `AKTER_STORAGE_REGION` and `AKTER_STORAGE_PREFIX`.

The check writes only under `check/<run>/` and deletes what it wrote. It ends with `Passed: all 7 probes.` or names the probes that failed.

## Operator commands

These send requests to a running server's `/operator` endpoint, which is on only when the server has [`operatorAuth`](../guides/operating.md#operator-access). Each needs a capability in the operator's grant.

| Command                                               | Capability      | Shows or does                                       |
| ----------------------------------------------------- | --------------- | --------------------------------------------------- |
| `akter inspect actor <Type> <id>`                     | `inspect`       | An actor's stored state, lists and pending work     |
| `akter inspect shard <n>`                             | `inspect`       | A shard's log position, checkpoints and owner       |
| `akter log tail <shard> [--from <offset>] [--follow]` | `log.read`      | The shard's recorded commands                       |
| `akter log export <shard> [--from <offset>]`          | `log.read`      | The same, as NDJSON                                 |
| `akter snapshot <shard>`                              | `snapshot.read` | The shard's latest checkpoint and pages             |
| `akter replay <shard> [--current]`                    | `replay`        | Replays a shard; `--current` uses the running build |
| `akter retention <duration>`                          | `retention.set` | Sets how long the store keeps history               |

Reading stored replies and errors also needs `outcomes.read`.

| Flag          | Default                 | Meaning                                    |
| ------------- | ----------------------- | ------------------------------------------ |
| `--url`       | `http://127.0.0.1:8080` | The server                                 |
| `--tenant`    | `default`               | The tenant                                 |
| `--reason`    | `operator inspection`   | Why, recorded in the audit log             |
| `--token-env` | `AKTER_OPERATOR_TOKEN`  | The environment variable holding the token |

The URL must be HTTPS, except on `localhost`. For an actor whose id isn't a string, pass `--id-json` and give the id as JSON.

## `akter fork`

```sh
akter fork Room lobby --at 120 --to lobby-copy --directory .akter/store
akter fork Room lobby --before 2026-10-12T18:00:00Z --bucket my-app-production --to-prefix forks/
```

Copies the actor `lobby` as it was at an earlier point into a new actor. It works on the store directly rather than through a server, so it loads your app module (`--app`, default `src/app.ts`). That module must default-export the app and export an `authorizeOperator(token)` function that returns an Effect of the operator's grant, which needs the `fork` capability.

Choose the source with `--directory`, or `--bucket` with optional `--prefix` and `--endpoint`. Choose the point in history with one of:

| Flag                       | Point                                |
| -------------------------- | ------------------------------------ |
| `--at <n>`                 | After the actor's first `n` commands |
| `--before <timestamp>`     | Just before an ISO timestamp         |
| `--offset <n> --index <i>` | A position in the shard's log        |

`--to` names the new actor; `--to-directory` and `--to-prefix` write it to another store. `--with-work` also copies pending timers and open jobs. A fork doesn't copy presence or pending sends.

The point must still be inside the store's history [retention](../guides/operating.md#history).

## Exit codes

| Code | Meaning                                                                                |
| ---- | -------------------------------------------------------------------------------------- |
| 0    | Success, or help and version output                                                    |
| 1    | The server refused the request, or a storage probe failed                              |
| 2    | Bad arguments, missing credentials, an app that won't load, or an unreachable endpoint |
