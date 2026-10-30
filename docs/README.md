# Akter documentation

New to Akter? Start with [Getting started](getting-started.md), then read the core concepts in order. Each page is short.

## Start here

- [Getting started](getting-started.md): build, run, call and test a counter.
- [Why Akter](why-akter.md): the problem Akter solves, and what it costs.

## Core concepts

1. [Actors](core/actors.md): state, ids, and putting an app together.
2. [Commands](core/commands.md): changing state, failing safely, messages, timers and cron.
3. [Jobs](core/jobs.md): I/O with recorded steps, retries and timeouts.
4. [Lists](core/lists.md): data that grows without limit.
5. [Realtime](core/realtime.md): live state, views, broadcasts and presence.
6. [Access](core/access.md): authentication and who may do what.
7. [Finding actors](core/find.md): looking up actor ids by their state.

## Guides

- [Calling actors](guides/client.md): the client, credentials, errors and retries.
- [Testing](guides/testing.md): `Story` for handlers, `Simulation` for everything else.
- [Operating](guides/operating.md): metrics, operator tools, history, backups and troubleshooting.
- [Changing state](guides/changing-state.md): evolving schemas without migrations.

## Deploy

Start with [Deploying](deploy/overview.md): what a server needs from a platform, the entry point, the image and the bucket. Then follow your platform's guide:

- [Cloudflare](deploy/cloudflare.md), with Alchemy
- [AWS](deploy/aws.md), with the CDK
- [Google Cloud](deploy/google-cloud.md)
- [Azure](deploy/azure.md)
- [Fly.io](deploy/fly.md)
- [Railway](deploy/railway.md)
- [Render](deploy/render.md)
- [DigitalOcean](deploy/digitalocean.md)
- [Kubernetes](deploy/kubernetes.md), on any cluster
- [Your own server](deploy/docker.md), with Docker Compose

## Reference

- [CLI](reference/cli.md)
- [Server](reference/server.md)
- [Errors](reference/errors.md)
- [Guarantees and limits](reference/guarantees.md)

## Internals

[Internals](internals/README.md) is for people working on Akter itself: the runtime contracts, design decisions, architecture and test evidence. You don't need any of it to use Akter.
