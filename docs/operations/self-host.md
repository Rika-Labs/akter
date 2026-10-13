---
title: "Self-host with Docker Compose"
description: "Build a Bun or Node image and run one runner on an S3-compatible bucket or a directory."
---

# Self-host with Docker Compose

The runnable files are in [`apps/self-host`](https://github.com/Rika-Labs/akter/tree/main/apps/self-host). `src/server.ts` serves a counter actor with `Akter.serve` and `App.make` from `@rikalabs/akter/server`: one `add` action, a `count` view, and a bearer-token `auth`. The store is a bucket: MinIO in the compose file, or any S3-compatible service, or a directory for a single container.

<Warning>
This recipe tracks `rewrite/0.2` and defaults to one runner. Several runners require directly reachable peer addresses and mTLS credentials as described below; the compose file does not provision that fleet. Pin the checkout commit you deploy, and resolve the store-scoped peering identity before a production rollout.
</Warning>

## Build and boot

You need Docker with Compose, OpenSSL, and a checkout of this repository. Run from its root:

```sh
mkdir -p .local
export SELFHOST_SECRETS_DIR="$PWD/.local/self-host-secrets"
bash apps/self-host/credentials.sh "$SELFHOST_SECRETS_DIR"

export SELFHOST_RUNTIME=bun
docker compose -f apps/self-host/compose.yml build runner
docker compose -f apps/self-host/compose.yml up -d --wait runner
```

For Node, set `SELFHOST_RUNTIME=node`. `Dockerfile.bun` uses Bun 1.4.2 and `Dockerfile.node` Node 24.18.0, both on Debian; both build the framework's JavaScript distribution from this checkout and resolve only its public exports, with dependencies from `bun.lock`.

The generator refuses a nonempty directory. It writes a bearer token (`api-token`) and the bucket's secret key (`s3-secret-access-key`) into an owner-only directory, which Compose mounts as read-only secrets. Never commit it.

Compose starts MinIO, a one-shot `bucket` container that creates the `akter-store` bucket, and the runner, which listens on `127.0.0.1:18080`. MinIO is not published to the host; its data is the named `data` volume.

## Configuration

`src/server.ts` reads:

| Setting            | Meaning                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `S3_BUCKET`        | Use `Store.s3` on this bucket. Without it the store is a directory.                                      |
| `S3_ENDPOINT`      | An S3-compatible endpoint such as MinIO, R2 or Tigris; path-style addressing is used with it.            |
| `S3_REGION`        | Default `us-east-1`.                                                                                     |
| `S3_ACCESS_KEY_ID` | The access key; the secret key is the `s3-secret-access-key` secret.                                     |
| `STORE_DIRECTORY`  | The `Store.fileSystem` directory when `S3_BUCKET` is unset; default `/data/store`, which the image owns. |
| `api-token` secret | The one bearer token the example's `auth` accepts, as `self-host-client` in the `default` tenant.        |

Replace the bearer provider with your application's own `Auth.jwt` or `Auth.make` before exposing an ingress, and serve it behind TLS.

## Ready and call

```sh
curl --fail http://127.0.0.1:18080/ready
```

`/ready` answers `200 { ready: true }` while the server runs and `503` once it starts shutting down. Container health uses it.

Call the counter with the Effect client:

```ts
import { AkterClient } from "@rikalabs/akter/client"

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

The client mints the command id and keeps it across retries; a retry after a lost reply returns the stored outcome instead of adding again.

## Stop

```sh
docker compose -f apps/self-host/compose.yml stop
```

Compose sends SIGTERM and allows 30 seconds. The recipe waits for SIGTERM or SIGINT without interrupting the runtime, makes `/ready` answer `503`, drains with a 15-second bound and prints `DRAINED {"outcome":...,"shards":[{"shard":...,"offset":...,"nextDue":...}],"actions":...,"jobSeconds":...}` before closing its server/store scope and exiting. `nextDue` is an epoch-millisecond instant or `null`. Optional `actions` and `jobSeconds` are cumulative runner-local attribution since open, not billing authority; legacy reports without them remain valid and mean unknown usage. A stopped self-host store fires overdue timers when a runner starts again; proactive scheduled startup is the host's responsibility. The `data` volume survives `stop` and `down`; never use `down --volumes` on data you keep.

For several runner containers, give each a unique directly reachable `RUNNER_HOST` and a nonzero `RUNNER_PORT`; the listener binds that port on `0.0.0.0`. All runners share the same S3 bucket and `PEER_IDENTITY`, stable across releases, and mount the `peer-ca`, `peer-certificate` and `peer-key` secrets. Issue each runner's certificate from the trusted authority with only `spiffe://akter/deployment/<PEER_IDENTITY>` as its URI SAN. Do not reuse that identity or credentials in another store. See [server composition](../api/01-server-api.md#several-runners-and-graceful-shutdown-02) and the [store-scoped peering identity](../contracts/10-security.md#runner-trust); the simple compose file remains a one-runner recipe until those peer mounts and addresses are configured.

## Reproduce the evidence

`verify.sh` creates its own credentials, builds the image, runs the stack and removes its containers, volume and credentials afterwards. It refuses to run while any `akter-selfhost-*` container exists, so don't run it alongside a deployment:

```sh
SELFHOST_RUNTIME=bun bash apps/self-host/verify.sh
SELFHOST_RUNTIME=node bash apps/self-host/verify.sh
```

It checks, over `/rpc`, that a retry with the same command id replays, that wrong and missing credentials are refused, and that state and stored outcomes survive a runner restart, first on MinIO and then on a directory. The [verification record](../verification/self-host.md) lists the evidence and its limits.
