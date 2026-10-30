# Fly.io

On Fly.io, the server runs on one [Fly Machine](https://fly.io/docs/machines/) and the store is an R2 bucket. `fly deploy` can build the image on Fly's builders, so you don't need Docker locally.

Fly's own buckets come from Tigris, which no longer accepts the path-style requests Akter sends for new buckets, so this guide uses R2. Put the bucket near the app: an R2 location hint of Eastern North America suits the `iad` region below.

You need the `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), an [R2 bucket](overview.md#create-an-r2-bucket), and the `fly` command.

## Configure the app

Create `fly.toml`:

```toml
app = "my-app"
primary_region = "iad"
kill_signal = "SIGTERM"
kill_timeout = "15s"

[deploy]
  strategy = "rolling"

[env]
  AKTER_STORAGE_BUCKET = "my-app-store"
  AKTER_STORAGE_ENDPOINT = "https://ACCOUNT_ID.r2.cloudflarestorage.com"
  AKTER_STORAGE_REGION = "auto"
  AUTH_ISSUER = "https://login.example.com/"
  AUTH_AUDIENCE = "my-app"
  AUTH_JWKS_URL = "https://login.example.com/.well-known/jwks.json"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = false

  [[http_service.checks]]
    interval = "10s"
    timeout = "2s"
    grace_period = "10s"
    method = "GET"
    path = "/ready"

[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"
```

- **`auto_stop_machines = "off"`** keeps the server running when no requests arrive.
- **`strategy = "rolling"`** replaces the machine in place: Fly stops it, then starts it on the new image.
- **`kill_timeout`** gives the server 15 seconds after SIGTERM. Fly's default is 5.
- **The check** sends traffic to the machine only while `/ready` answers `200`.

## Deploy

```sh
fly apps create my-app
fly secrets set --app my-app AWS_ACCESS_KEY_ID=<access key id> AWS_SECRET_ACCESS_KEY=<secret access key>
fly deploy --ha=false
```

`--ha=false` creates one machine. Without it, the first deploy creates two, and the second would take the store from the first. If you ever see two, run `fly scale count 1`.

Check the server:

```sh
curl https://my-app.fly.dev/ready
```

## Releases

Run `fly deploy` again. With one machine, Fly stops it, waits for the drain, and starts it again on the new image. Clients retry through the gap. Don't switch to the `bluegreen` or `canary` strategies: they start the new machine while the old one still runs.
