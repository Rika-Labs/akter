# Cloudflare

On Cloudflare, the server runs in a [Container](https://developers.cloudflare.com/containers/) and the store is an R2 bucket. A small Worker sits in front and forwards every request, WebSockets included, to the one container. [Alchemy](https://alchemy.run) describes all of it in TypeScript and deploys it with one command.

You need:

- The `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md).
- Docker running locally. Alchemy builds the image on your machine and pushes it to Cloudflare.
- A Cloudflare account on the Workers Paid plan, which Containers require.

## Install

```sh
bun add -d alchemy @alchemy.run/cloudflare @cloudflare/containers @cloudflare/workers-types
```

The Worker runs on Cloudflare's runtime, not Bun. Add its types to `tsconfig.json`, so one config checks both:

```json
{
  "compilerOptions": {
    "types": ["bun", "@cloudflare/workers-types"]
  }
}
```

Add `.alchemy` to `.dockerignore` too.

## Describe the stack

Create `alchemy.run.ts` in the project root:

```ts
import * as Alchemy from "alchemy"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect } from "effect"
import type { Server } from "./src/worker.ts"

const Store = Cloudflare.R2.Bucket("Store")

export const Worker = Cloudflare.Worker("Worker", {
  main: "./src/worker.ts",
  crons: ["* * * * *"],
  env: {
    SERVER: Cloudflare.Container<Server>("Server", {
      context: ".",
      instanceType: "basic",
      maxInstances: 1,
    }),
    STORE: Cloudflare.R2.S3Credentials(Store, { access: "read-write" }),
    AUTH_ISSUER: "https://login.example.com/",
    AUTH_AUDIENCE: "my-app",
    AUTH_JWKS_URL: "https://login.example.com/.well-known/jwks.json",
  },
})

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>

export default Alchemy.Stack(
  "my-app",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Worker
    return { url: worker.url }
  }),
)
```

- **`Store`** is the R2 bucket.
- **`S3Credentials`** creates an API token that can only use that bucket, and hands its S3 keys to the Worker as a secret.
- **`Server`** is the container. Alchemy builds it from your `Dockerfile`. `maxInstances: 1` keeps it to one copy. `basic` gives it a quarter of a vCPU and 1 GiB of memory; pick a larger [instance type](https://developers.cloudflare.com/containers/platform-details/limits/) as you grow.
- **`crons`** runs the Worker every minute. The next section uses that to restart the container if it ever stops.
- **`Cloudflare.state()`** keeps Alchemy's record of what it deployed in your Cloudflare account, so you can deploy from any machine.

## Route requests to the container

Create `src/worker.ts`:

```ts
import { Container, getContainer } from "@cloudflare/containers"
import type * as Cloudflare from "@alchemy.run/cloudflare"
import type { WorkerEnv } from "../alchemy.run.ts"

const serverEnv = (env: WorkerEnv) => {
  const store: Cloudflare.R2.S3CredentialsValue = JSON.parse(env.STORE)
  return {
    AKTER_STORAGE_BUCKET: store.bucketName,
    AKTER_STORAGE_ENDPOINT: store.endpoint,
    AKTER_STORAGE_REGION: store.region,
    AWS_ACCESS_KEY_ID: store.accessKeyId,
    AWS_SECRET_ACCESS_KEY: store.secretAccessKey,
    AUTH_ISSUER: env.AUTH_ISSUER,
    AUTH_AUDIENCE: env.AUTH_AUDIENCE,
    AUTH_JWKS_URL: env.AUTH_JWKS_URL,
  }
}

export class Server extends Container<WorkerEnv> {
  override defaultPort = 8080
  override envVars = serverEnv(this.env)

  override async onActivityExpired() {}
}

export default {
  fetch(request: Request, env: WorkerEnv) {
    return getContainer(env.SERVER).fetch(request)
  },
  async scheduled(_controller: unknown, env: WorkerEnv) {
    await getContainer(env.SERVER).startAndWaitForPorts()
  },
}
```

- **`getContainer(env.SERVER)`** always names the same instance, so every request reaches the one server.
- **`envVars`** passes the bucket's keys and your auth settings to the server as environment variables.
- **`onActivityExpired`** normally stops a container that hasn't had a request for 10 minutes. Akter has timers and jobs to run between requests, so this one does nothing and the container keeps running.
- **`scheduled`** runs every minute and starts the container if it isn't running, for example after Cloudflare moved it to another machine.

## Deploy

```sh
bun alchemy deploy
```

The first time, Alchemy has you connect your Cloudflare account, and asks before it sets up its state store there. Then it shows the plan, builds and pushes the image, and prints the Worker's URL. The first deploy takes a few minutes. Check the server:

```sh
curl https://<worker url>/ready
```

The container starts on the first request, or within a minute from the cron trigger, and opens the store. `/ready` then answers `{"ready":true}`. Point your client at the same URL, with `/rpc` on the end.

To check the bucket, copy the keys from the R2 dashboard into the variables in [Check it](overview.md#check-it) and run `bunx akter storage check`.

## Releases

Run `bun alchemy deploy` again. Cloudflare sends SIGTERM to the running container, gives it up to 15 minutes to exit, and only then starts the new image, which is the order Akter needs. Requests that arrive in between wait or are retried by the client.

`bun alchemy destroy` tears the stack down.
