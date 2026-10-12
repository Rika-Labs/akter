# Self-host recipe evidence

**Responsibility:** bound the claims of the executable self-host recipe.
**Authority:** evidence.

The recipe is `apps/self-host`, documented in [self-host operations](../operations/self-host.md). It serves a 0.2 app with `Akter.serve` and `App.make` and uses only the framework's public package exports. No framework contract is changed by it.

## Commands and scope

Run from the repository root, with Docker Compose, OpenSSL, curl and `uuidgen` installed:

```sh
SELFHOST_RUNTIME=bun bash apps/self-host/verify.sh
SELFHOST_RUNTIME=node bash apps/self-host/verify.sh
bun run --cwd apps/self-host typecheck
bun run --cwd apps/self-host lint
```

Local evidence on 2026-10-12 uses Linux arm64 containers on Docker 29.8.2 on macOS arm64, Bun 1.4.2, Node 24.18.0 and MinIO RELEASE.2026-09-22T19-25-18Z (the digest pinned in `compose.yml`). Both images build and both runs print `S3_OK`, `FS_OK` and `SELFHOST_OK`. No CI job runs the recipe.

Each run refuses existing `akter-selfhost-*` containers, creates its own credentials, MinIO, bucket and runner, then removes the containers, the volume, the network and the credentials.

## Wrong implementations rejected

| Scenario            | Plausible wrong implementation                                           | Observation                                                                                                       |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Same-id retry       | The served wire runs a retried command again, or loses `replayed`.       | The first `add` of 3 answers `value: 3, replayed: false`; the same command id answers `value: 3, replayed: true`. |
| Credentials         | A wrong or missing bearer runs as `Anonymous` or reaches the actor.      | They answer `invalid_credentials` and `missing_credentials`.                                                      |
| Restart on a bucket | State or stored outcomes live only in the process.                       | After `compose restart runner`, the first command id still replays 3 and a new `add` of 7 answers 10.             |
| Restart on a disk   | The image cannot write its directory, or the directory is not the store. | With no `S3_BUCKET`, an `add` of 5 survives `docker restart`: its id replays 5 and a new `add` of 1 answers 6.    |

## Limits

This is one runner on one host. It establishes that the images build and serve the 0.2 wire on MinIO and on a directory with durable outcomes across a restart; it is not a multi-runner, failover, drain-under-load, performance or provider result, and a MinIO result is not an S3, R2 or Tigris result ([store providers](store-providers.md)). The example `auth` accepts one bearer token as one caller in one tenant.

The source-built images include the installed monorepo dependency tree; their size is not minimized.

The 0.1 recipe (two runners on Postgres with mTLS peers, SIGTERM drain and receipt replay) and its 2026-10-07 evidence were retired with the 0.1 runtime ([0.1 retirement](0.1-retirement.md)).
