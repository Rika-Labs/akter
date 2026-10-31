# Railway

On Railway, the server runs as one service and the store is an R2 bucket. Alchemy's [Railway provider](https://alchemy.run/railway) creates the project and the service, uploads your code, and Railway builds it from your `Dockerfile`.

Railway's own buckets come from Tigris, which doesn't accept the path-style requests Akter sends for new buckets, so the store is R2.

You need:

- The `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), and `infra/store.ts` from [The bucket](overview.md#the-bucket).
- A Railway account, and an account or workspace token if you deploy from CI.

## Install

```sh
bun add -d alchemy @alchemy.run/cloudflare @alchemy.run/railway
```

## Describe the stack

Create `alchemy.run.ts` in the project root:

```ts
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Railway from "@alchemy.run/railway"
import * as Alchemy from "alchemy"
import { Config, Effect, Layer } from "effect"
import { R2Store } from "./infra/store.ts"

export default Alchemy.Stack(
  "my-app",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Railway.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const store = yield* R2Store
    const project = yield* Railway.Project("Project")
    const volume = yield* Railway.Volume("Volume", { project, mountPath: "/data" })

    const server = yield* Railway.Service(
      "Server",
      {
        project,
        context: ".",
        dockerfilePath: "Dockerfile",
        port: 8080,
        healthcheckPath: "/ready",
        healthcheckTimeout: 120,
        drainingSeconds: 30,
        overlapSeconds: 0,
        sleepApplication: false,
        restartPolicyType: "ALWAYS",
        env: {
          AKTER_STORAGE_BUCKET: store.bucket,
          AKTER_STORAGE_ENDPOINT: store.endpoint,
          AKTER_STORAGE_REGION: "auto",
          AWS_ACCESS_KEY_ID: store.accessKeyId,
          AWS_SECRET_ACCESS_KEY: store.secretAccessKey,
          AUTH_ISSUER: yield* Config.String("AUTH_ISSUER"),
          AUTH_AUDIENCE: yield* Config.String("AUTH_AUDIENCE"),
          AUTH_JWKS_URL: yield* Config.String("AUTH_JWKS_URL"),
        },
      },
      Effect.gen(function* () {
        yield* Railway.MountVolume(volume, { path: "/data" })
        return {}
      }).pipe(Effect.provide(Railway.MountVolumeLive)),
    )

    return { url: server.url }
  }),
)
```

- **`Volume`** holds nothing. It's there for how Railway deploys a service with a volume: it never runs two deployments of it at once, so it stops the old one before it starts the new one, and never runs replicas. Without a volume, Railway starts the new deployment first.
- **`context: "."`** uploads the project, minus what `.dockerignore` leaves out, and Railway builds it with your `Dockerfile`. You don't need Docker locally.
- **`drainingSeconds: 30`** gives the server 30 seconds between SIGTERM and SIGKILL. Railway's default is none.
- **`healthcheckPath`** makes Railway wait for `/ready` before it routes traffic to a new deployment.
- **`sleepApplication: false`** keeps the server running when no requests arrive.
- **`url`** is the service's generated `*.up.railway.app` domain, which forwards to port 8080. WebSockets work through it.

## Deploy

```sh
bun alchemy deploy --stage prod
```

The first time, Alchemy asks you to connect Railway, with OAuth or a token, and your Cloudflare account. In CI it reads `RAILWAY_API_TOKEN`. Then it uploads the project and waits for the deployment to pass its health check. Check the server:

```sh
curl <url>/ready
```

## Releases

Run `bun alchemy deploy --stage prod` again. Railway builds the new image while the old deployment keeps serving, then stops the old deployment with SIGTERM and starts the new one. Clients retry through the gap.

Because the old deployment stops before the new one passes its health check, a release that doesn't start leaves nothing running. Fix it and deploy again, or redeploy the previous deployment from Railway's dashboard.

`bun alchemy destroy --stage prod` deletes the project. It leaves the bucket while it holds objects.
