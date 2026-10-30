# DigitalOcean

On DigitalOcean, the server runs on a Droplet with Docker, and the store is an R2 bucket. A Droplet with 1 GB of memory is enough to start.

Two DigitalOcean products look like a better fit and aren't:

- **App Platform** keeps the old instance running until the new one is healthy, so every deploy would start a new release while the old one still owns the store.
- **Spaces** doesn't support conditional writes, so it can't hold an Akter store.

You need the `src/server.ts`, `Dockerfile` and `.dockerignore` from [Deploying](overview.md), an [R2 bucket](overview.md#create-an-r2-bucket), a domain name, and the `doctl` command.

## Create the Droplet

```sh
doctl compute droplet create my-app \
  --image ubuntu-24-04-x64 --size s-1vcpu-1gb --region nyc1 \
  --ssh-keys <your key fingerprint> --wait
doctl compute droplet list my-app --format PublicIPv4
```

Point your domain's DNS at the Droplet's address, then connect with `ssh root@<address>`.

## Deploy

From here it's the same as any server with Docker. Follow [Your own server](docker.md) from [Install Docker](docker.md#install-docker).

If you'd rather run a cluster, DigitalOcean Kubernetes works with the [Kubernetes](kubernetes.md) manifest. Create one with `doctl kubernetes cluster create my-app --count 1`.
