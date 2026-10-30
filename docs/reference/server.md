# Server

Everything on this page comes from `@rikalabs/akter/server`. For a walkthrough, see [Deploying](../deploy/overview.md).

## `App.make`

```ts
App.make({ actors: [Room, Table], layer: Layer.mergeAll(RoomLive, TableLive) })
```

Lists the actors a server runs and the layer that implements them. It doesn't compile if an actor has no implementation in the layer. `akter dev` expects your app module to default-export one.

## `Akter.serve`

```ts
Akter.serve({ app, auth }).pipe(Layer.provide(Store.s3({ bucket })))
```

Returns a `Layer` that runs the app's actors and serves them over HTTP. Provide exactly one store.

| Option             | Default    | Meaning                                                                       |
| ------------------ | ---------- | ----------------------------------------------------------------------------- |
| `app`              | required   | The app from `App.make`                                                       |
| `auth`             | required   | How requests are authenticated; see [Access](../core/access.md)               |
| `port`             | `8080`     | The port; `0` picks a free one                                                |
| `hostname`         | `0.0.0.0`  | The address to listen on                                                      |
| `basePath`         | none       | A prefix for every route, such as `/api`                                      |
| `origins`          | none       | Browser origins allowed besides the server's own                              |
| `reauthorizeEvery` | 60 seconds | How often a live session runs `auth` and `access` again                       |
| `credentialBytes`  | 8 KiB      | The largest credential a request may carry                                    |
| `runner`           | none       | Settings for [running several servers](../deploy/overview.md#several-servers) |
| `operatorAuth`     | none       | Turns on the [operator endpoint](../guides/operating.md#operator-access)      |
| `prometheus`       | `false`    | Serves metrics at `/metrics`                                                  |

### Routes

| Route            | What it serves                                               |
| ---------------- | ------------------------------------------------------------ |
| `/rpc`           | Every actor call: WebSocket with JSON, or `POST` with NDJSON |
| `/ready`         | `200` while serving, `503` while shutting down               |
| `/metrics`       | Prometheus metrics, with `prometheus: true`                  |
| `POST /operator` | Operator requests, with `operatorAuth`                       |

## `Auth`

| Provider                                                                               | Use                                                                                      |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Auth.jwt({ issuer, audience, jwks, tenant, subject?, algorithms?, clockTolerance? })` | Verifies bearer JWTs. `jwks` is a URL or static keys. RS256, ES256 and EdDSA by default. |
| `Auth.make(authenticate)`                                                              | Your own check, reading the `authorization` header                                       |
| `Auth.make({ authenticate, cookies: { name }, bearer? })`                              | Your own check, reading a cookie                                                         |
| `Auth.none`                                                                            | Every caller is `Anonymous`                                                              |

`tenant` must return `"default"`.

## `Store`

| Store                                                                         | Use                                  |
| ----------------------------------------------------------------------------- | ------------------------------------ |
| `Store.s3({ bucket, endpoint?, region?, credentials?, prefix?, ...options })` | Production: an S3-compatible bucket  |
| `Store.fileSystem(directory, options?)`                                       | Development and tests on one machine |
| `Store.memory(options?)`                                                      | Tests; nothing survives the process  |

Every store takes these options:

| Option      | Default | Meaning                                                                |
| ----------- | ------- | ---------------------------------------------------------------------- |
| `build`     | empty   | `{ bundle, framework }` recorded with everything this release writes   |
| `shards`    | 16      | Shards in a new store; an existing store keeps its own count           |
| `retention` | 7 days  | History kept by a new store; change it later with `Store.setRetention` |

`Store.retention` reads the store's current retention in milliseconds. `Store.setRetention(duration, { grant, reason })` changes it, given an operator grant with `retention.set`.

## `RuntimeControl`

`RuntimeControl.waitForSignal({ deadline })` waits for SIGTERM or SIGINT, makes the server unready, drains for up to `deadline`, and prints the `DRAINED` report with each shard's log position and `nextDue`. Run it inside the scope that built the server.

## `DurableClock`

`DurableClock.sleep({ name, duration })` waits inside a job, and survives restarts. See [Jobs](../core/jobs.md#wait-for-a-while).

## `Telemetry`

| Member                                  | What it does                                                      |
| --------------------------------------- | ----------------------------------------------------------------- |
| `Telemetry.layer({ otlp?, devtools? })` | Exports traces and metrics over OTLP, or to Effect DevTools       |
| `Telemetry.prometheus()`                | The current metrics in Prometheus text format                     |
| `Telemetry.usage`                       | Successful commands and job seconds on this server, by actor type |

## `OperatorAuth`

`OperatorAuth.tokens([{ token, grant }])` authenticates operator requests by bearer token. See [Operating](../guides/operating.md#operator-access).

## `Forks`

`Forks.fork(engine, options)` and `Forks.run(app, sourceStore, targetStore, options)` fork an actor from code, for operator tooling. Most people use [`akter fork`](cli.md#akter-fork) instead.
