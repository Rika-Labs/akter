# Railway

On Railway, the server is one service built from your `Dockerfile`, and the store is an R2 bucket. The service is described in `.railway/railway.ts`, Railway's [infrastructure as code](https://docs.railway.com/infrastructure-as-code) file.

Two things are different from a typical Railway app:

- **The service has a volume it never uses.** Railway normally starts the new deployment and stops the old one once the new one is healthy, which is the opposite of what Akter needs. It never runs two deployments of a service that has a volume, so attaching one makes every deploy stop the old server first.
- **The bucket is R2, not a Railway bucket.** Railway's buckets come from Tigris, which no longer accepts the path-style requests Akter sends for new buckets.

You need the `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), an [R2 bucket](overview.md#create-an-r2-bucket), and the `railway` command.

## Describe the service

```sh
bun add -d railway
```

Create `.railway/railway.ts`:

```ts
import { defineRailway, preserve, project, service, volume } from "railway/iac"

export default defineRailway(() => {
  const handoff = volume("handoff")

  const server = service("server", {
    healthcheck: "/ready",
    volumeMounts: { "/handoff": handoff },
    deploy: { drainingSeconds: 15 },
    env: {
      AKTER_STORAGE_BUCKET: "my-app-store",
      AKTER_STORAGE_ENDPOINT: "https://ACCOUNT_ID.r2.cloudflarestorage.com",
      AKTER_STORAGE_REGION: "auto",
      AWS_ACCESS_KEY_ID: preserve(),
      AWS_SECRET_ACCESS_KEY: preserve(),
      AUTH_ISSUER: "https://login.example.com/",
      AUTH_AUDIENCE: "my-app",
      AUTH_JWKS_URL: "https://login.example.com/.well-known/jwks.json",
    },
  })

  return project("my-app", { resources: [server, handoff] })
})
```

- **`volumeMounts`** attaches the volume, for the reason above. A volume also keeps the service to one replica.
- **`healthcheck`** makes Railway wait for `/ready` before it sends traffic to a new deployment.
- **`drainingSeconds`** gives the server 15 seconds between SIGTERM and SIGKILL. Railway's default is 0.
- **`preserve()`** leaves the bucket's keys out of the file. You set them with the CLI below, and later applies keep them.

Railway sets `PORT`, and the server listens on it.

## Deploy

```sh
railway login
railway init --name my-app
railway config apply
railway variable set --service server AWS_ACCESS_KEY_ID=<access key id> AWS_SECRET_ACCESS_KEY=<secret access key>
railway up --service server
railway domain --service server
```

`config apply` shows the plan and creates the service and volume. `railway up` uploads the project, and Railway builds the `Dockerfile` it finds. `railway domain` gives the service a public URL. Check the server:

```sh
curl https://<your domain>/ready
```

## Releases

Run `railway up --service server` again, or connect the service to your GitHub repository so each push deploys. Railway stops the old deployment, waits up to `drainingSeconds` for it to drain, and starts the new one. Clients retry through the gap.

Railway sometimes moves a service to another host on its own. That's a restart of the same release, so it needs nothing from you.
