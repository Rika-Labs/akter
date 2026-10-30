# Your own server

Any Linux machine with Docker can run Akter: a Droplet, a Hetzner server, an EC2 instance, a box under your desk. Docker Compose runs the server, and [Caddy](https://caddyserver.com) in front of it gets an HTTPS certificate and forwards requests, WebSockets included.

You need the `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), a bucket and its keys (see [Choose a bucket](overview.md#choose-a-bucket)), and a domain name pointing at the machine.

## Install Docker

On a fresh Ubuntu or Debian machine:

```sh
curl -fsSL https://get.docker.com | sh
```

## Configure

Copy the project to the machine, with `git clone` or `rsync`. Next to the `Dockerfile`, create `compose.yaml`:

```yaml
services:
  server:
    build: .
    restart: unless-stopped
    stop_grace_period: 15s
    env_file: .env

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    command: caddy reverse-proxy --from api.example.com --to server:8080
    volumes:
      - caddy:/data

volumes:
  caddy:
```

Replace `api.example.com` with your domain. Then create `.env` with the server's settings, and keep it out of Git:

```sh
AKTER_STORAGE_BUCKET=my-app-store
AKTER_STORAGE_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
AKTER_STORAGE_REGION=auto
AWS_ACCESS_KEY_ID=<access key id>
AWS_SECRET_ACCESS_KEY=<secret access key>
AUTH_ISSUER=https://login.example.com/
AUTH_AUDIENCE=my-app
AUTH_JWKS_URL=https://login.example.com/.well-known/jwks.json
```

- **`restart: unless-stopped`** brings the server back after a crash or a reboot.
- **`stop_grace_period`** gives it 15 seconds to drain. Docker's default is 10.
- **The server has no `ports`.** Only Caddy is reachable from outside.

## Run

```sh
docker compose up -d --build
curl https://api.example.com/ready
```

Caddy gets a certificate the first time it serves your domain, so the first request can take a few seconds.

## Releases

```sh
git pull
docker compose up -d --build
```

Compose builds the new image, stops the old container, waits for it to drain, and starts the new one, which is the order Akter needs. Clients retry through the gap.

## Your own bucket

To keep the store on your own hardware too, run [MinIO](https://min.io) next to the server and point `AKTER_STORAGE_ENDPOINT` at it. The [self-host example](../../apps/self-host) in this repository does that, with Compose files for Bun and Node and a script that checks retries, refused credentials and restarts end to end:

```sh
export SELFHOST_SECRETS_DIR="$PWD/.local/self-host-secrets"
bash apps/self-host/credentials.sh "$SELFHOST_SECRETS_DIR"
docker compose -f apps/self-host/compose.yml up -d --wait runner
curl http://127.0.0.1:18080/ready
```
