# Fly.io

On Fly.io, the server runs on one [Fly Machine](https://fly.io/docs/machines/) and the store is an R2 bucket. Alchemy's [Fly provider](https://alchemy.run/fly) creates the app, its addresses, its secrets and the Machine, and pushes your image to Fly's registry.

Fly's own buckets come from Tigris, which doesn't accept the path-style requests Akter sends for new buckets, so the store is R2.

You need:

- The `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), and `infra/store.ts` from [The bucket](overview.md#the-bucket).
- Docker running locally. Alchemy builds the image on your machine.
- A Fly.io account and an API token from `fly tokens create org`.

## Install

```sh
bun add -d alchemy @alchemy.run/cloudflare @alchemy.run/fly @alchemy.run/docker
```

## Describe the stack

Create `alchemy.run.ts` in the project root:

```ts
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Docker from "@alchemy.run/docker"
import * as Fly from "@alchemy.run/fly"
import * as Alchemy from "alchemy"
import * as Output from "alchemy/Output"
import { Config, Effect, Layer } from "effect"
import { R2Store } from "./infra/store.ts"

export default Alchemy.Stack(
  "my-app",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Fly.providers(), Docker.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const store = yield* R2Store
    const fly = yield* yield* Fly.FlyEnvironment

    const app = yield* Fly.App("App")
    yield* Fly.IpAssignment("Ipv4", { app, type: "shared_v4" })
    yield* Fly.IpAssignment("Ipv6", { app, type: "v6" })

    const image = yield* Docker.Image("Image", {
      name: app.appName.pipe(Output.map((name) => `registry.fly.io/${name}`)),
      build: { context: ".", platform: "linux/amd64" },
      registry: { server: "registry.fly.io", username: "x", password: fly.apiKey },
    })

    const keyId = yield* Fly.Secret("KeyId", {
      app,
      name: "AWS_ACCESS_KEY_ID",
      value: store.accessKeyId,
    })
    const secretKey = yield* Fly.Secret("SecretKey", {
      app,
      name: "AWS_SECRET_ACCESS_KEY",
      value: store.secretAccessKey,
    })

    yield* Fly.Machine("Server", {
      app,
      region: "iad",
      count: 1,
      image: image.repoDigest.pipe(
        Output.mapEffect((digest) =>
          digest === undefined
            ? Effect.die(new Error("registry.fly.io reported no digest for the image"))
            : Effect.succeed(digest),
        ),
      ),
      guest: { cpuKind: "shared", cpus: 1, memoryMb: 1024 },
      env: {
        AKTER_STORAGE_BUCKET: store.bucket,
        AKTER_STORAGE_ENDPOINT: store.endpoint,
        AKTER_STORAGE_REGION: "auto",
        AUTH_ISSUER: yield* Config.String("AUTH_ISSUER"),
        AUTH_AUDIENCE: yield* Config.String("AUTH_AUDIENCE"),
        AUTH_JWKS_URL: yield* Config.String("AUTH_JWKS_URL"),
      },
      metadata: { secrets: Output.interpolate`${keyId.digest}.${secretKey.digest}` },
      restart: { policy: "always" },
      deploy: { strategy: "rolling", healthTimeout: "120 seconds" },
      shutdown: { signal: "SIGTERM", timeout: "30 seconds" },
      services: [
        {
          protocol: "tcp",
          internalPort: 8080,
          autostop: "off",
          minMachinesRunning: 1,
          ports: [
            { port: 80, handlers: ["http"], forceHttps: true },
            { port: 443, handlers: ["tls", "http"] },
          ],
          checks: [
            {
              type: "http",
              port: 8080,
              method: "GET",
              path: "/ready",
              interval: "5s",
              timeout: "2s",
              gracePeriod: "10s",
            },
          ],
        },
      ],
    })

    return { url: app.url }
  }),
)
```

- **`App`** is the Fly app, with a shared IPv4 address and its own IPv6 address. Its URL is `https://<app>.fly.dev`.
- **`Image`** builds your `Dockerfile` for `linux/amd64` and pushes it to `registry.fly.io`, signing in with your Fly token. The Machine runs it by digest, so every new build updates the Machine.
- **The secrets** hold the bucket's keys. The Machine's `metadata` carries their digests, so new keys restart it.
- **`count: 1`** keeps one Machine, and **`autostop: "off"`** keeps it running when no requests arrive.
- **`shutdown`** stops the Machine with SIGTERM and gives it 30 seconds. Fly's default is SIGINT.
- **The check** sends traffic to the Machine only while `/ready` answers `200`. A failing check doesn't restart it.
- **`strategy: "rolling"`** updates the one Machine in place. Don't use `bluegreen`: it starts new Machines next to the old ones.

## Deploy

```sh
bun alchemy deploy --stage prod
```

The first time, Alchemy asks for your Fly API token and your Cloudflare account. In CI it reads `FLY_API_TOKEN`. Then it builds and pushes the image, creates the app and the Machine, waits for the check to pass, and prints the URL. Check the server:

```sh
curl https://<app>.fly.dev/ready
```

## Releases

Run `bun alchemy deploy --stage prod` again. Alchemy updates the Machine in place, and Fly stops it with SIGTERM, waits for it to exit, and starts it on the new image. There is never a second Machine. Clients retry through the gap.

Fly closes a connection that has been idle for about a minute. A client on a `wss:` URL pings every 5 seconds, so its WebSocket stays open.

`bun alchemy destroy --stage prod` stops the Machine gracefully and deletes the app. It leaves the bucket while it holds objects.
