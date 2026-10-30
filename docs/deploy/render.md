# Render

On Render, the server is one web service built from your `Dockerfile`, and the store is an R2 bucket. The service is described in a `render.yaml` [Blueprint](https://render.com/docs/infrastructure-as-code).

The service has a small disk it never uses. Render normally starts the new instance and stops the old one a minute after traffic moves, which is the opposite of what Akter needs. With a disk attached, Render stops the old instance before it starts the new one. Disks need a paid instance type, and the free one would sleep anyway.

You need the `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), an [R2 bucket](overview.md#create-an-r2-bucket), and the project in a Git repository Render can read.

## Describe the service

Create `render.yaml` in the repository root:

```yaml
services:
  - type: web
    name: my-app
    runtime: docker
    plan: starter
    numInstances: 1
    healthCheckPath: /ready
    disk:
      name: handoff
      mountPath: /handoff
      sizeGB: 1
    envVars:
      - key: AKTER_STORAGE_BUCKET
        value: my-app-store
      - key: AKTER_STORAGE_ENDPOINT
        value: https://ACCOUNT_ID.r2.cloudflarestorage.com
      - key: AKTER_STORAGE_REGION
        value: auto
      - key: AWS_ACCESS_KEY_ID
        sync: false
      - key: AWS_SECRET_ACCESS_KEY
        sync: false
      - key: AUTH_ISSUER
        value: https://login.example.com/
      - key: AUTH_AUDIENCE
        value: my-app
      - key: AUTH_JWKS_URL
        value: https://login.example.com/.well-known/jwks.json
```

- **`disk`** attaches the disk, for the reason above.
- **`numInstances: 1`** runs one server.
- **`healthCheckPath`** makes Render wait for `/ready` before it sends traffic, and stop sending it while `/ready` fails.
- **`sync: false`** marks the bucket's keys as secrets. Render asks for them when you create the Blueprint and never reads them from the file.

Render sets `PORT`, and the server listens on it. With a disk, Render gives the server 30 seconds between SIGTERM and SIGKILL.

## Deploy

Push `render.yaml`, then in the Render dashboard choose **New**, then **Blueprint**, and pick the repository. Enter the two keys when Render asks, and deploy. Check the server:

```sh
curl https://<service url>/ready
```

## Releases

Each push to the branch deploys. Render stops the old instance, waits for it to drain, and starts the new one. Expect a short gap; clients retry through it.
