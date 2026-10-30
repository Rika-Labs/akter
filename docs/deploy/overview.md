# Deploying

Your actors don't change between your laptop and production. Three things do: the store becomes a bucket, requests need real authentication, and you run the server process yourself. This page covers the parts every deployment shares. The pages after it set up each platform step by step.

## What Akter needs

An Akter server is one long-running process that owns your app's state. That shapes what it needs from a platform:

- **It stays running.** Timers, cron, retries and jobs run inside the server, so it has to keep running between requests. Turn off scale to zero, sleeping and idle shutdown.
- **One copy at a time.** A server takes ownership of the store when it starts, and any other server using the same bucket loses it. Run exactly one, unless you set up [several servers](#several-servers).
- **The old server stops before the new one starts.** When a server crashes, the next one replays the commands it hadn't checkpointed, and only the build that wrote them may replay them. A clean stop writes a checkpoint, so the next release starts from it. If a new release starts while the old one is still running, it takes over a store full of the old build's commands, can't replay them, and both servers stop serving. See [Releases](#releases).
- **A health check on `/ready`.** It answers `200` while the server takes traffic and `503` while it starts up or shuts down.
- **Time to shut down.** On SIGTERM the server drains for up to the deadline you give it, 8 seconds in the example below. Give it at least 15 seconds before the platform kills it.
- **An S3-compatible bucket** with conditional writes. See [Choose a bucket](#choose-a-bucket).

Many platforms start the new version first and stop the old one once it's healthy, which is the opposite of what Akter needs. The guides below pick a product, or a setting, on each platform that stops the old server first.

## Where to deploy

| Platform                        | The server runs on                  | The bucket      |
| ------------------------------- | ----------------------------------- | --------------- |
| [Cloudflare](cloudflare.md)     | Containers, set up with Alchemy     | R2              |
| [AWS](aws.md)                   | ECS on Fargate, set up with the CDK | S3              |
| [Google Cloud](google-cloud.md) | GKE Autopilot                       | R2              |
| [Azure](azure.md)               | AKS                                 | R2              |
| [Fly.io](fly.md)                | a Fly Machine                       | R2              |
| [Railway](railway.md)           | a service with a volume             | R2              |
| [Render](render.md)             | a web service with a disk           | R2              |
| [DigitalOcean](digitalocean.md) | a Droplet                           | R2              |
| [Kubernetes](kubernetes.md)     | any cluster                         | R2 or S3        |
| [Your own server](docker.md)    | Docker Compose                      | R2, S3 or MinIO |

Serverless functions such as AWS Lambda and Vercel can't run Akter, because nothing keeps running between requests.

## Write the server

`akter dev` is for development. In production, write a small entry point, `src/server.ts`, that reads its settings from the environment and serves your app with `Akter.serve`:

```ts
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { BunServices } from "@effect/platform-bun"
import { Config, Effect, Layer } from "effect"
import { Akter, Auth, RuntimeControl, Store } from "@rikalabs/akter/server"
import akter from "@rikalabs/akter/package.json" with { type: "json" }
import app from "./app.ts"

const server = Layer.unwrap(
  Effect.gen(function* () {
    const store = Store.s3({
      bucket: yield* Config.String("AKTER_STORAGE_BUCKET"),
      endpoint: yield* Config.String("AKTER_STORAGE_ENDPOINT").pipe(Config.withDefault(undefined)),
      region: yield* Config.String("AKTER_STORAGE_REGION").pipe(Config.withDefault(undefined)),
      build: {
        bundle: createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex"),
        framework: akter.version,
      },
    })
    const auth = Auth.jwt({
      issuer: yield* Config.String("AUTH_ISSUER"),
      audience: yield* Config.String("AUTH_AUDIENCE"),
      jwks: yield* Config.URL("AUTH_JWKS_URL"),
      tenant: () => "default",
    })
    const port = yield* Config.Port("PORT").pipe(Config.withDefault(8080))
    return Akter.serve({ app, auth, port }).pipe(Layer.provide(store))
  }),
)

const main = Effect.scoped(
  Effect.gen(function* () {
    const running = yield* Layer.build(server)
    yield* RuntimeControl.waitForSignal({ deadline: "8 seconds" }).pipe(
      Effect.provideContext(running),
    )
  }),
)

Effect.runPromise(main.pipe(Effect.provide(BunServices.layer)))
```

It reads these variables:

| Variable                                        | Meaning                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `AKTER_STORAGE_BUCKET`                          | The bucket's name                                                          |
| `AKTER_STORAGE_ENDPOINT`                        | The S3 endpoint, for any provider but AWS                                  |
| `AKTER_STORAGE_REGION`                          | The bucket's region, `auto` for R2                                         |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`    | The bucket's keys. On AWS, leave them out and use a role instead.          |
| `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` | Your identity provider, for [`Auth.jwt`](../core/access.md#authentication) |
| `PORT`                                          | The port to listen on, `8080` by default                                   |

A few things worth knowing:

- **The build.** `build` labels everything this release writes, and replay after a crash only runs on the same build. Here the label is a hash of the file the server runs. The [image](#build-an-image) bundles your whole app into that one file, so the label changes whenever any of your code or dependencies do, with no release number to remember.
- **Authentication.** Use whatever provider you chose in [Access](../core/access.md). Every request without valid credentials is refused.
- **Shutdown.** `RuntimeControl.waitForSignal` waits for SIGTERM or SIGINT, then drains. Run the program with `Effect.runPromise`, as above. `BunRuntime.runMain` handles those signals itself and stops the server without draining.
- **Node.** Use `NodeServices` from `@effect/platform-node`, and hash the file `node` runs the same way.

The [server reference](../reference/server.md) lists every option of `Akter.serve`.

## Build an image

Every platform below runs a container. This `Dockerfile` bundles the server into one file, so the final image holds Bun and that file and nothing else:

```dockerfile
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build src/server.ts --target=bun --outfile=dist/server.js

FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY --from=build /app/dist/server.js ./
USER bun
EXPOSE 8080
CMD ["bun", "server.js"]
```

Add a `.dockerignore`, so local files stay out of the build:

```text
node_modules
dist
.akter
```

You can try the bundle without Docker: run `bun build src/server.ts --target=bun --outfile=dist/server.js`, set the variables above, and run `bun dist/server.js`.

## Choose a bucket

Akter writes everything to one bucket, and settles who owns the store with conditional writes (`If-None-Match` and `If-Match`). The provider has to support them exactly.

- **Cloudflare R2** works with every platform, and doesn't charge for traffic out. The guides use it unless the platform has its own bucket that works.
- **AWS S3** is the natural choice on AWS, where the server can use a role instead of keys.
- **MinIO** works if you run your own storage.

Some buckets don't work:

| Bucket                                       | Why                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Google Cloud Storage                         | Its S3-compatible API has no conditional writes                                                    |
| DigitalOcean Spaces                          | No conditional writes                                                                              |
| Azure Blob Storage                           | No S3 API                                                                                          |
| Tigris, including Fly.io and Railway buckets | New buckets only accept virtual-hosted URLs, and Akter uses path-style URLs with a custom endpoint |

### Create an R2 bucket

1. In the Cloudflare dashboard, open **R2 Object Storage** and create a bucket, `my-app-store` say. Put it near where the server will run.
2. Under **API Tokens**, create an account API token with **Object Read & Write** permission, limited to that bucket.
3. Copy the **Access Key ID** and **Secret Access Key**. Cloudflare shows the secret once.

Then set:

```sh
AKTER_STORAGE_BUCKET=my-app-store
AKTER_STORAGE_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
AKTER_STORAGE_REGION=auto
AWS_ACCESS_KEY_ID=<access key id>
AWS_SECRET_ACCESS_KEY=<secret access key>
```

`<ACCOUNT_ID>` is on the R2 overview page. Give each environment its own bucket and its own token.

### Check it

Before you rely on a bucket, check it from a machine with the same variables set:

```sh
bunx akter storage check
```

The check races conditional writes, lists, overwrites and deletes against the real bucket, and prints what it measured. It writes only under `check/` and cleans up after itself. Every probe should pass. Keep the output: it's the evidence that this provider, region and endpoint behave the way Akter needs. See [`akter storage check`](../reference/cli.md#akter-storage-check).

## Releases

A release goes like this:

1. The platform sends SIGTERM to the old server.
2. The old server stops taking new work, finishes what it accepted, writes a checkpoint for every shard, prints a `DRAINED` report and exits.
3. The new server starts, opens every shard from its checkpoint, and `/ready` turns `200`.

Between steps 1 and 3 the app is unavailable, usually for a few seconds and up to a minute on slower platforms. Clients don't see errors: the [client](../guides/client.md#retries) retries for up to ten minutes with the same command ids, so each command still runs once.

If a server crashes instead, the next start of the same release replays what wasn't checkpointed, and nothing acknowledged is lost. Deploying a different release on top of a crash doesn't work: the new release refuses those shards until the release that wrote them recovers them. [Operating](../guides/operating.md#when-something-goes-wrong) has the fix.

State written by the old release opens in the new one, as long as your schemas can still decode it. See [Changing state](../guides/changing-state.md).

## Health and shutdown

`GET /ready` answers `200` while the server takes traffic and `503` while it starts or shuts down. Point the platform's health check at it, and use it to decide when to send traffic, not when to restart: a server that can't open a shard stays unready until someone fixes the shard, and restarting it doesn't help.

On SIGTERM the server stops taking new work, finishes what it accepted, writes a checkpoint, and hands its shards back. Then it prints a `DRAINED` report and exits. A server killed mid-drain loses nothing that was acknowledged, but the next server has to replay more of the log.

The report includes `nextDue` for each shard: the next time a timer, retry or durable sleep comes due. Akter can't wake itself up when nothing is running, which is why the server has to keep running.

## Shards

Akter splits a store into shards, 16 by default, fixed when the store is created. Each actor belongs to one shard, and each shard is owned by one server at a time. The owner runs that shard's commands and writes its log.

Ownership is settled in the bucket. A server that takes over a shard writes a new starting entry to the shard's log, and the bucket's conditional writes reject anything the old owner tries to write after that. So even if two servers briefly both think they own a shard, only one of them can write.

## Several servers

One server is enough for many apps. To run more, give each one a `runner` option:

```ts
Akter.serve({
  app,
  auth,
  runner: {
    address: { host: "10.0.0.12", port: 7070 },
    peering: {
      deployment: "my-app-production",
      credentials: Effect.succeed({ ca, certificate, key: Redacted.make(privateKey) }),
    },
  },
})
```

Servers sharing a bucket divide the shards between them, forward each request to the shard's owner, and move shards when a server joins, drains or dies. They talk to each other directly over mutual TLS, so each needs an address the others can reach, and a certificate from a CA they all trust. Kubernetes, ECS and Fly.io all give instances private addresses they can use.

`deployment` is the peering identity for this store. Keep it the same across releases, and never reuse it, or its certificates, for another store.

With several servers, a new release can start before the old one stops: new servers wait until the old ones release their shards, then take them over. When a server drains, its shards move to the others within a few seconds. When a server crashes, the others take its shards once its lease runs out, a few seconds by default.
