---
title: "Self-host with Docker Compose"
description: "Build Bun or Node images and run two mutually authenticated runners on one host."
---

# Self-host with Docker Compose

The runnable files are in [`apps/self-host`](https://github.com/Rika-Labs/akter/tree/main/apps/self-host). They run a real counter actor with one `Increment` command and one `GetCount` read, two runner processes, and a persistent Postgres server 18.6.

<Warning>
Published npm versions lag main until alpha.2. Build this recipe from a reviewed checkout of main, not the published alpha.1 package. Pin the checkout commit for your deployment; don't silently deploy a moving branch.
</Warning>

## Build and boot

You need Docker with Compose, OpenSSL, and a checkout of this repository. Run from its root:

```sh
mkdir -p .local
export SELFHOST_SECRETS_DIR="$PWD/.local/self-host-secrets"
bash apps/self-host/credentials.sh "$SELFHOST_SECRETS_DIR"

export SELFHOST_RUNTIME=bun
docker compose -f apps/self-host/compose.yml build runner-a
docker compose -f apps/self-host/compose.yml up -d --wait
```

For Node 24, set `SELFHOST_RUNTIME=node` before the build and startup commands. `Dockerfile.bun` uses Bun 1.4.2 on Debian; `Dockerfile.node` uses Node 24.18.0 on Debian. Both build the framework's JavaScript distribution from this checkout and resolve only its public exports. Dependencies come from `bun.lock`.

The generator refuses a nonempty directory. It creates a database password, a bearer token, a local signing authority, and separate runner private keys. The directory is owner-only; files mounted into non-root containers are readable within that private directory. Compose mounts them as read-only secrets. Never commit this directory or copy the signing key into an image. For production, replace the generated short-lived development credentials with your managed certificate and secret lifecycle; keep backups of the database credentials separate from database backups.

The compose project and containers are named `akter-selfhost-*`. The two HTTP listeners are `127.0.0.1:18081` and `127.0.0.1:18082`; the Postgres server binds `127.0.0.1:55477`. A project-local Docker bridge connects the runners and the Postgres server. Peer port 9000 is not published to the host, and mTLS authenticates every peer connection. This bridge is not an outbound firewall.

## Health, readiness and migrations

```sh
curl --fail http://127.0.0.1:18081/health
curl --fail http://127.0.0.1:18081/ready
curl --fail http://127.0.0.1:18082/ready
```

`/health` answers `alive` once application routes install; it is not a database or routing check. Container health uses `/ready`, not a listening port. Startup may refuse connections or return 404 while routes are installing; treat every response other than readiness 200 as unready.

Each runner builds `Actors.layer`, which runs missing framework migrations under database coordination before registering actors. Two concurrent first starts share one migration history; there is no separate migration command in this example. Readiness becomes green only after migrations, actor registration, healthy runner registration and acquisition of the runner's currently assigned shards. It becomes red during drain. [Migration operations](/operations/02-migrations) covers application-owned schema migrations and expand/contract upgrades; don't replace this with arbitrary startup DDL.

Each runner uses pools of 10 turn, 5 off-turn and 5 query connections. Two runners therefore budget 40 connections plus operator, migration and monitoring headroom on the Postgres server. [Deployment operations](/operations/01-deployment) explains the budget and the settings that every runner must share.

## Call either runner

The example's provider authenticates a single bearer credential as `self-host-client` in the `default` tenant. Missing or wrong credentials are denied. Replace it with your application's authentication and access policy before exposing an ingress. The actor's public access policy is still behind this provider.

This containerized Promise-client check reads the mounted token without printing it, sends increments of 3 and 7 through different runners, and checks that both read 10. Run it once against a fresh example database:

```sh
docker compose -f apps/self-host/compose.yml exec -T runner-a \
  "$SELFHOST_RUNTIME" apps/self-host/src/check.ts
```

Your application can use the same public client shape:

```ts
const counter = Counter.client({ baseUrl, headers: { authorization: `Bearer ${token}` } }).get(
  "visits",
)
await counter.Increment(3)
const count = await counter.GetCount()
```

The client's command ID is reused during delivery retries. If a request loses its reply during shutdown, preserve that ID when retrying against a ready runner; a committed receipt replays rather than incrementing again. A timeout is an unknown outcome, not proof of rollback.

## Authenticated peers

`Runner.socket` advertises `runner-a:9000` or `runner-b:9000`, not the HTTP proxy address. `Runner.mtls` requires TLS 1.3, a trusted certificate chain, and exactly `spiffe://akter/deployment/self-host` as the peer certificate's URI identity. The authority is valid for 30 days and generated runner certificates for seven days. Replace them before expiry. The transport reloads mounted credentials on its regular refresh; replacement strategy and certificate rotation are your operational responsibility.

```sh
docker compose -f apps/self-host/compose.yml exec -T runner-a \
  "$SELFHOST_RUNTIME" apps/self-host/src/peers.ts
```

This check completes an authenticated TLS 1.3 handshake and then sends plaintext to the same live peer listener. It fails unless the plaintext connection closes without application bytes. An unreachable port or a timeout is a failure, not evidence of mTLS.

## Stop and drain

```sh
docker compose -f apps/self-host/compose.yml stop
```

Compose sends SIGTERM. The entry point keeps its runtime scope alive while `RuntimeControl.drain({ deadline: "15 seconds" })` makes readiness red, refuses new turns and stops claims. An admitted turn gets time to commit; after the deadline an interrupted turn rolls back or resolves through its durable receipt on retry. The scope then closes to release shards. Compose allows 30 seconds before SIGKILL. Stop ingress first and preserve client command IDs; the two stopping runners are not a destination for new traffic.

The named `data` volume survives `stop` and `down`. Never use `down --volumes` on production data. Back up and restore using the [backup procedure](/operations/04-backup-restore). This single Postgres server is not high availability, and this recipe has no public TLS ingress, automated certificate renewal or backup scheduler.

## Reproduce the evidence

The verification command owns and removes a temporary database volume and all `akter-selfhost-*` test containers. It refuses to run if its named containers or volume already exist. Do not run it alongside your deployment:

```sh
SELFHOST_RUNTIME=bun bash apps/self-host/verify.sh
SELFHOST_RUNTIME=node bash apps/self-host/verify.sh
```

It holds the first migration's history-table creation open, starts both runners concurrently, checks readiness and registration, sends real client commands, and checks mTLS. It overlaps an admitted command with runner-only SIGTERM, observes red readiness before completion, restarts the runners and checks the receipt and unchanged migration history. A second admitted command overlaps a full `compose stop`, including the Postgres server, and must finish or retry with the same ID after restart; its receipt must replay without another increment. `COMMAND_DELAY_MS=3000` is used only by this drill; normal startup leaves it at zero. The [verification record](https://github.com/Rika-Labs/akter/blob/main/docs/verification/self-host.md) defines the exact evidence and its limits. CI runs this in the optional `self-host-recipe` job, outside the required `verify` aggregate.
