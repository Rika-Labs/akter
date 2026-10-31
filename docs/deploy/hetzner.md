# Hetzner

On [Hetzner Cloud](https://www.hetzner.com/cloud), the server runs in a Docker container on a Cloud server, with [Caddy](https://caddyserver.com) in front for HTTPS, and the store is an R2 bucket. Alchemy's [Hetzner provider](https://alchemy.run/hetzner) creates the server and its firewall, and its [Docker provider](https://alchemy.run/docker) runs the containers on it over SSH.

You need:

- The `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), and `infra/store.ts` from [The bucket](overview.md#the-bucket).
- `infra/docker.ts` and the `caddy` folder from [Your own server](docker.md#the-server).
- A Hetzner Cloud project and a Read & Write API token for it.
- An SSH key, loaded in your SSH agent, and the `docker` command. It needs no local daemon: the images build on the server.
- A domain name you can point at the server.

## Install

```sh
bun add -d alchemy @alchemy.run/cloudflare @alchemy.run/hetzner @alchemy.run/docker
```

## Describe the stack

Create `alchemy.run.ts` in the project root:

```ts
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Docker from "@alchemy.run/docker"
import * as Hetzner from "@alchemy.run/hetzner"
import * as Alchemy from "alchemy"
import { Config, Effect, Layer, Redacted, Schedule } from "effect"
import { Server } from "./infra/docker.ts"

const installDocker = `#cloud-config
write_files:
  - path: /etc/docker/daemon.json
    content: |
      {"log-driver": "local"}
runcmd:
  - curl -fsSL https://get.docker.com | sh
`

const DockerReady = Alchemy.Action(
  "DockerReady",
  Effect.fn(function* (input: {
    host: string | undefined
    privateKey: Redacted.Redacted<string> | undefined
  }) {
    if (input.host === undefined || input.privateKey === undefined) {
      return yield* Effect.die("The server has no public IPv4 address or deploy key")
    }
    const ssh = yield* Hetzner.openSshClient({
      host: input.host,
      privateKey: Redacted.value(input.privateKey),
    })
    yield* ssh
      .exec("cloud-init status --wait > /dev/null; docker info > /dev/null")
      .pipe(
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
        Effect.scoped,
        Effect.ensuring(ssh.close),
      )
    return { docker: `host=ssh://root@${input.host}` }
  }),
)

export default Alchemy.Stack(
  "my-app",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Hetzner.providers(), Docker.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const key = yield* Hetzner.SshKey("Key", {
      publicKey: yield* Config.String("SSH_PUBLIC_KEY"),
    })
    const firewall = yield* Hetzner.Firewall("Firewall", {
      rules: ["22", "80", "443"].map((port) => ({
        direction: "in" as const,
        protocol: "tcp" as const,
        port,
        sourceIps: ["0.0.0.0/0", "::/0"],
      })),
    })
    const machine = yield* Hetzner.Server("Machine", {
      serverType: "cx23",
      image: "ubuntu-24.04",
      location: "nbg1",
      sshKeys: [key],
      firewalls: [firewall],
      userData: installDocker,
    })

    const ready = yield* DockerReady({ host: machine.ipv4, privateKey: machine.privateKey })
    const engine = yield* Docker.Context("Engine", { docker: ready.docker })
    const server = yield* Server(engine)

    return { ...server, ip: machine.ipv4 }
  }),
)
```

- **`installDocker`** is cloud-init: it installs Docker the first time the server boots.
- **`DockerReady`** waits over SSH until cloud-init has finished and Docker answers. The server reports `running` long before that.
- **`Machine`** is a `cx23` server, with 2 shared vCPUs and 4 GB, in Nuremberg. Pick another [type and location](https://www.hetzner.com/cloud) to suit; cost-optimized types like `cx23` sometimes sell out, and `cpx22` is the regular choice.
- **`Firewall`** lets in SSH, HTTP and HTTPS.
- **`Engine`** is a Docker context that reaches the server's Docker over SSH, and **`Server`** from `infra/docker.ts` runs the server and Caddy there.

## Deploy

Set `SSH_PUBLIC_KEY`, `DOMAIN` and your `AUTH_*` settings, in your shell or `.env`. The server's address isn't known until it exists, so let SSH accept its host key the first time, in `~/.ssh/config`:

```text
Host *
  StrictHostKeyChecking accept-new
```

Then deploy:

```sh
bun alchemy deploy --stage prod
```

The first time, Alchemy asks for your Hetzner token and your Cloudflare account. In CI it reads `HCLOUD_TOKEN`. It creates the server, waits for Docker, builds both images on the server, starts the containers, and prints the server's `ip`.

Point an `A` record for your domain at that address. Caddy gets a certificate as soon as the name resolves. Check the server:

```sh
curl https://<domain>/ready
```

## Releases

Run `bun alchemy deploy --stage prod` again. Alchemy builds the new image on the server, then stops the old container, giving it 30 seconds after SIGTERM, and starts the new one. Caddy holds requests for up to 30 seconds while the server restarts.

Changing the server's type, location, image or cloud-init makes Alchemy create a new server before it deletes the old one, so two servers would run at once. Resize from the Hetzner console instead, or move in two deploys: remove the server from the stack, deploy, then add the new one.

`bun alchemy destroy --stage prod` deletes the containers and the server. It leaves the bucket while it holds objects.
