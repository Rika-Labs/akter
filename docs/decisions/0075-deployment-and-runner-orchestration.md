# ADR 0075: Deployment and runner orchestration

**Status:** implementation decision for #503, #504, #507 and #510; provider support remains gated by its own evidence.

**Responsibility:** serialize rollouts, preserve rollback snapshots, recover runner provisioning and establish the hosted client-IP trust boundary.

**Authority:** design decision record.

**Owner role:** cloud, security and reliability.

**Change policy:** supersede through a new ADR.

## Decision

`DeploymentLifecycle` is an Akter actor per project environment, with the organization as its tenant. It records the external build result, runs migrate and start jobs, and activates a replacement only after it answers ready. The activation turn compare-and-sets the environment pointer through `Repository.activateDeployment`, changes host routing and lifecycle statuses, and appends `deployment.live` in one fenced Postgres transaction. Provider calls never run inside that turn. The lifecycle's owned read-model tables are bootstrapped under an advisory transaction lock. Better Auth continues to own identity; API startup applies only hosted migrations starting at `0002`, not the retired `0001_initial` identity schema.

A rollback creates a new deployment from an earlier live image and recorded environment snapshot, sets `rolledBackFrom`, skips build and migrate, and replaces the current deployment only when ready. Its audience and region are rebound to the new deployment. Platform bindings recorded with the target are copied rather than resolved again from current process configuration. A failed migration, start or activation leaves the current live deployment unchanged and schedules cleanup of capacity started for the failed deployment. Drain failures after activation are visible on the drain step and do not reverse activation.

`CloudRunners` serializes each release-region's capacity. A wake commits a start job before any platform call. Retries reuse the durable job identity, hashed to the provider token. The provider returns an address before readiness; the edge probes readiness before forwarding a cold request. Registration and wake deletion commit in the runner actor's result turn. Drain withdraws the registration before sending SIGTERM. A drain requested during startup is retained and stops the resulting task instead of registering it. Reconciliation removes stopped tasks and paid deployments request replacement capacity.

Free deployments may sleep after their committed activity timestamp is older than the idle bound; paid deployments request at least one runner. Activity is recorded before forwarding, and an idle decision locks that deployment row while withdrawing ingress. Due work at zero waits for the next wake as in ADR 0062. Parked connections do not survive a scale-to-zero cycle. Cold-start readiness remains bounded by the edge's 30-second default; no local timing is evidence of Fargate latency.

The local platform runs Docker images and their explicit migration command. Hosted providers use Distilled AWS, ECS Fargate and ARM64 task definitions pinned to the image digest. Hosted runner origins default to HTTPS; production refuses HTTP configuration, and TLS-capable images and trusted certificates are an operator requirement, not established by fake HTTP tests. Neither provider stops capacity merely because the orchestration process closes. Unmeasured runner actor counts and CPU percentages are null, never fabricated as zero.

The NLB preserves the Cloudflare source address and the service security group admits ingress only from the NLB security group. The edge honors `CF-Connecting-IP` only when the operator enables that NLB-only network guarantee and the TCP peer belongs to the configured Cloudflare ranges. Private/VPC addresses are not trusted proxies. Client attribution and forwarding headers are removed before the edge writes its own forwarding headers. HTTP response bodies, SSE and WebSocket bytes remain streaming.

The API's supported runtime operations resolve a deployment host and use a deployment-bound service credential through the edge. The caller's Better Auth credential and the edge's private signing key never reach a runner. Runtime endpoints whose required fields are absent from the runner's inspection surface remain `NotImplemented`; unknown telemetry is not synthesized.

Served command replies add `durable-replayed`, sourced from the runtime's receipt admission or committed replay set. The cloud API requires that marker on command outcomes. An inspector lookup before sending is not authoritative under concurrent retries and was rejected. This metadata changes no durable identity or migration and leaves the command's JSON result unchanged.

## Evidence and limits

The focused lifecycle, runner-actor, API, edge and provider suites establish only their stated local or fake-HTTP boundaries. Real ECS/ECR, GitHub App installation, Cloudflare-to-NLB traffic, hosted TLS, Neki and Fargate cold-start timings need credential-bearing provider evidence. Local Docker is a development platform, not a hostile-code sandbox or evidence of VM isolation. Shared-cell routing and tenant relocation across release changes are not certified by this slice.
