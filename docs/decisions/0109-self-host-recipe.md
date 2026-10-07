# 0109: source-built self-host images and serialized startup migrations

Status: accepted

## Context

A self-hoster needs reproducible files for two runner processes on one host. The published npm version is still alpha.1; it lags main until alpha.2 and cannot establish the current runner recipe. The framework already serializes startup migrations before actor registration and supplies authenticated peer transport and bounded drain through its public runtime API.

## Decision

Keep the executable example in `apps/self-host`, a private workspace app. Build the checked-out framework with its normal TypeScript build, select its published JavaScript exports, and copy that output and the installed, lockfile-pinned dependencies into both runtime images. Use Debian-based Bun 1.4.2 and Node 24.18.0 images, keeping the native framework dependencies on glibc rather than introducing an Alpine/musl variant without evidence. The app entry points use native TypeScript support outside `node_modules`; the framework is compiled JavaScript.

Both processes build `Actors.layer` at startup. Do not add a second migration tool or run unsynchronized DDL in the app. Successful framework migration completion precedes actor registration and readiness. This counter has no application-owned tables. Application schema changes still require the migration and expand/contract procedures in [migration operations](../operations/02-migrations.md).

Each process advertises its own Compose service name through `Runner.socket`, using `Runner.mtls` and a deployment-specific URI identity. Generate a different private key for each runner, mount credentials read-only, and keep the signing key outside containers. The HTTP and database ports bind only to host loopback, on a project-local Docker bridge; no peer port is published. This bridge is not an outbound firewall. The bundled single-principal bearer provider is a minimal authenticated example, not a tenant identity system.

Handle SIGTERM and SIGINT as normal completion of a waiting Effect, not immediate root-fiber interruption. Call `RuntimeControl.drain` with a 15-second deadline while the HTTP and actor layers remain alive, then close the layer scope. Give Compose 30 seconds before SIGKILL. The test-only command delay makes an admitted command overlap the signal without importing runtime hooks.

## Consequences

The images depend on this repository checkout until alpha.2 and include the monorepo's installed dependency tree. This is a working deployment recipe, not a minimum-size image or a database high-availability topology. It does not claim managed certificates, public ingress security, backups, Neki support, cross-host routing, or a production availability objective.

The optional `self-host-recipe` CI job builds and boots each runtime independently and is not part of the required `verify` aggregate. Its real-server verification script is [apps/self-host/verify.sh](../../apps/self-host/verify.sh); the evidence scope is recorded in [self-host verification](../verification/self-host.md).
