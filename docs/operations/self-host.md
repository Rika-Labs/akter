---
title: "Self-host with Docker Compose"
description: "Build a Bun or Node image from this repository and run one runner on MinIO, an S3-compatible bucket, or a directory."
---

# Self-host with Docker Compose

This recipe runs a counter app with Docker Compose so you can see a complete self-hosted deployment. It is for developers who plan to run their own Akter runners.

The files are in [`apps/self-host`](https://github.com/Rika-Labs/akter/tree/main/apps/self-host). `src/server.ts` serves a counter actor with `Akter.serve` and `App.make`: one `add` command, a `count` view, and bearer-token authentication. The store is MinIO in the compose file, any S3-compatible bucket, or a directory for a single container.

<Warning>
This recipe tracks `main` and runs one runner. Several runners need directly reachable peer addresses and mutual TLS credentials, which the compose file does not provision. Pin the commit you deploy.
</Warning>

## Build and start

You need Docker with Compose, OpenSSL, and a checkout of this repository. From its root:

```sh
mkdir -p .local
export SELFHOST_SECRETS_DIR="$PWD/.local/self-host-secrets"
bash apps/self-host/credentials.sh "$SELFHOST_SECRETS_DIR"

export SELFHOST_RUNTIME=bun
docker compose -f apps/self-host/compose.yml build runner
docker compose -f apps/self-host/compose.yml up -d --wait runner
```

Set `SELFHOST_RUNTIME=node` to use Node. `Dockerfile.bun` builds and runs on Bun 1.4.2. `Dockerfile.node` builds with Bun 1.4.2 and runs on Node 24.18.0. Both build the framework from your checkout.

`credentials.sh` refuses a non-empty directory. It writes a bearer token (`api-token`) and the bucket secret key (`s3-secret-access-key`) to an owner-only directory, which Compose mounts as read-only secrets. Never commit that directory.

Compose starts MinIO, a one-shot container that creates the `akter-store` bucket, and the runner on `127.0.0.1:18080`. MinIO is not published to the host. Its data is in the named `data` volume.

## Check it and call it

```sh
curl --fail http://127.0.0.1:18080/ready
```

`/ready` answers `200` with `{"ready":true}` while the server runs, and `503` once it starts shutting down. The container health check uses it.

Call the counter with the Effect client, sending the token:

```ts
import { Effect } from "effect"
import { AkterClient } from "@rikalabs/akter/client"
import { Counter } from "./counter.ts"

const program = Effect.flatMap(Counter.client("visits"), (counter) => counter.add(3)).pipe(
  Effect.scoped,
  Effect.provide(
    AkterClient.layer({
      url: "http://127.0.0.1:18080/rpc",
      actors: [Counter],
      headers: { authorization: `Bearer ${token}` },
    }),
  ),
)
```

## Configuration

`src/server.ts` reads these settings:

| Setting            | Meaning                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `S3_BUCKET`        | Use `Store.s3` on this bucket. Without it, the store is a directory.                     |
| `S3_ENDPOINT`      | An S3-compatible endpoint, such as MinIO. Path-style addressing is used with it.         |
| `S3_REGION`        | Defaults to `us-east-1`.                                                                 |
| `S3_ACCESS_KEY_ID` | The access key. The secret key is the `s3-secret-access-key` secret.                     |
| `STORE_DIRECTORY`  | The `Store.fileSystem` directory when `S3_BUCKET` is unset. Defaults to `/data/store`.   |
| `api-token` secret | The one bearer token the example accepts, as `self-host-client` in the `default` tenant. |

Replace the bearer check with your own `Auth.jwt` or `Auth.make` before you expose the server, and serve it behind TLS.

## Stop and drain

```sh
docker compose -f apps/self-host/compose.yml stop
```

Compose sends SIGTERM and waits up to 30 seconds. The runner then:

1. Makes `/ready` answer `503`.
2. Drains for up to 15 seconds.
3. Prints a `DRAINED` report with the outcome, each shard's durable `offset` and `nextDue` (an epoch-millisecond time, or `null`), and optional cumulative `actions` and `jobSeconds`.
4. Closes the server and store and exits.

A stopped store fires overdue timers when a runner starts again. Starting it when work is due is your responsibility. The `data` volume survives `stop` and `down`; do not use `down --volumes` on data you keep.

## Several runners

Give each runner container a unique, directly reachable `RUNNER_HOST` and a nonzero `RUNNER_PORT`. The listener binds that port on `0.0.0.0`. All runners share the same S3 bucket and the same `PEER_IDENTITY`, which must stay stable across releases, and mount the `peer-ca`, `peer-certificate`, and `peer-key` secrets.

Issue each runner's certificate from the trusted authority, with only `spiffe://akter/deployment/<PEER_IDENTITY>` as its URI SAN. Do not reuse that identity or its credentials for another store. See [Several runners and graceful shutdown](../api/01-server-api.md#several-runners-and-graceful-shutdown-02) and the [peering contract](https://github.com/Rika-Labs/akter/blob/main/docs/contracts/10-security.md#runner-trust).

## Reproduce the evidence

`verify.sh` creates its own credentials, builds the image, runs the stack, and removes its containers, volume, and credentials afterward. It refuses to run while any `akter-selfhost-*` container exists, so do not run it next to a deployment:

```sh
SELFHOST_RUNTIME=bun bash apps/self-host/verify.sh
SELFHOST_RUNTIME=node bash apps/self-host/verify.sh
```

It checks over `/rpc` that a retry with the same command id replays, that missing or wrong credentials are refused, and that state and stored outcomes survive a runner restart, first on MinIO and then on a directory. The [verification record](https://github.com/Rika-Labs/akter/blob/main/docs/verification/self-host.md) lists the results and their limits.
