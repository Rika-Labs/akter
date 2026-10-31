# Your own server

Any Linux machine with Docker can run Akter: a VPS, an EC2 instance, a box under your desk. The server runs in a Docker container with [Caddy](https://caddyserver.com) in front for HTTPS, and the store is an R2 bucket. Alchemy's [Docker provider](https://alchemy.run/docker) builds and runs the containers on the machine over SSH.

You need:

- The `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), and `infra/store.ts` from [The bucket](overview.md#the-bucket).
- A machine with Docker, ports 80 and 443 open, and SSH access with a key. Docker's [install script](https://get.docker.com) sets it up: `curl -fsSL https://get.docker.com | sh`.
- The `docker` command locally. It needs no local daemon: the images build on the machine.
- A domain name pointing at the machine.

## Install

```sh
bun add -d alchemy @alchemy.run/cloudflare @alchemy.run/docker
```

Make sure SSH reaches the machine without a prompt, and that Docker answers there:

```sh
ssh root@203.0.113.10 docker version
```

## The server

Create `infra/docker.ts`. It runs the server and Caddy on a Docker host, and the [Hetzner guide](hetzner.md) uses it too:

```ts
import * as Docker from "@alchemy.run/docker"
import { Config, Effect } from "effect"
import { R2Store } from "./store.ts"

/**
 * The Akter server and Caddy on one Docker host. Caddy gets a certificate for the domain and
 * forwards every request to the server.
 */
export const Server = (engine: Docker.Context) =>
  Effect.gen(function* () {
    const store = yield* R2Store
    const network = yield* Docker.Network("Network", { name: "akter", context: engine })

    const image = yield* Docker.Image("Image", {
      name: "akter",
      context: engine,
      build: { context: "." },
    })
    yield* Docker.Container("Server", {
      name: "akter",
      context: engine,
      image,
      start: true,
      restart: "unless-stopped",
      stopTimeout: "30 seconds",
      networks: [{ name: network.name, aliases: ["akter"] }],
      environment: {
        AKTER_STORAGE_BUCKET: store.bucket,
        AKTER_STORAGE_ENDPOINT: store.endpoint,
        AKTER_STORAGE_REGION: "auto",
        AWS_ACCESS_KEY_ID: store.accessKeyId,
        AWS_SECRET_ACCESS_KEY: store.secretAccessKey,
        AUTH_ISSUER: yield* Config.String("AUTH_ISSUER"),
        AUTH_AUDIENCE: yield* Config.String("AUTH_AUDIENCE"),
        AUTH_JWKS_URL: yield* Config.String("AUTH_JWKS_URL"),
      },
    })

    const domain = yield* Config.String("DOMAIN")
    const certificates = yield* Docker.Volume("Certificates", {
      name: "akter-caddy",
      context: engine,
    })
    const caddy = yield* Docker.Image("CaddyImage", {
      name: "akter-caddy",
      context: engine,
      build: { context: "./caddy" },
    })
    yield* Docker.Container("Caddy", {
      name: "akter-caddy",
      context: engine,
      image: caddy,
      start: true,
      restart: "unless-stopped",
      environment: { DOMAIN: domain },
      ports: [
        { external: 80, internal: 80 },
        { external: 443, internal: 443 },
      ],
      volumes: [{ hostPath: certificates.name, containerPath: "/data" }],
      networks: [{ name: network.name }],
    })

    return { url: `https://${domain}` }
  })
```

Create `caddy/Caddyfile`:

```text
{$DOMAIN} {
	reverse_proxy akter:8080 {
		lb_try_duration 30s
		lb_try_interval 250ms
	}
}
```

And `caddy/Dockerfile`, so the Caddyfile travels inside the image:

```dockerfile
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
```

- **`Image`** builds your `Dockerfile` on the machine, so nothing goes through a registry.
- **`Server`** runs it with `restart: "unless-stopped"`, and gives it 30 seconds after SIGTERM. The name `akter` means Docker never runs two.
- **Caddy** gets a certificate for `DOMAIN`, keeps it in the `Certificates` volume, and forwards every request to the server, WebSockets included. While the server restarts, `lb_try_duration` holds requests for up to 30 seconds instead of failing them.

## Describe the stack

Create `alchemy.run.ts` in the project root:

```ts
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Docker from "@alchemy.run/docker"
import * as Alchemy from "alchemy"
import { Config, Effect, Layer } from "effect"
import { Server } from "./infra/docker.ts"

export default Alchemy.Stack(
  "my-app",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Docker.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const engine = yield* Docker.Context("Engine", {
      name: "my-app",
      docker: `host=ssh://${yield* Config.String("SERVER_SSH")}`,
    })
    return yield* Server(engine)
  }),
)
```

`Engine` is a Docker context that reaches the machine's Docker over SSH. `SERVER_SSH` is the user and host, such as `root@203.0.113.10`; a user in the `docker` group works too.

## Deploy

Set `SERVER_SSH`, `DOMAIN` and your `AUTH_*` settings, in your shell or `.env`, then:

```sh
bun alchemy deploy --stage prod
```

The first time, Alchemy asks you to connect your Cloudflare account. Then it builds both images on the machine and starts the containers. Check the server:

```sh
curl https://<domain>/ready
```

## Releases

Run `bun alchemy deploy --stage prod` again. Alchemy builds the new image on the machine, then stops the old container, giving it 30 seconds after SIGTERM, and starts the new one. Caddy holds requests while the server restarts.

`bun alchemy destroy --stage prod` removes the containers, images and volume, and leaves the machine alone. It leaves the bucket while it holds objects.

## Your own bucket

To keep the store on your own hardware too, run [MinIO](https://min.io) and point the server's `AKTER_STORAGE_*` and `AWS_*` variables at it instead of `R2Store`. The [self-host example](../../apps/self-host) in this repository runs Akter with MinIO, and checks retries, refused credentials and restarts end to end. Run [`akter storage check`](overview.md#check-it) against your MinIO before you rely on it.
