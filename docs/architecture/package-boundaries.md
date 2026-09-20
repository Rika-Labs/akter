# Package boundaries

**Responsibility:** keep the monorepo modular.  
**Authority:** architecture.  
**Owner role:** runtime architecture.

```text
packages/protocol       schemas, frames, errors, versions
packages/runtime         actor definitions, turns, dispatch, fencing
packages/database        Postgres transaction and runtime storage
packages/drizzle         Drizzle adapter and ownership integration
packages/sdk             Promise client and async iterators
packages/gateway         HTTP, WebSocket, SSE, auth
packages/work            activities, jobs, workflows, timers
packages/realtime        subscriptions, replay, presence, signals
packages/blobs           actor-scoped objects, uploads, cleanup
packages/testing         reusable actor fixtures and fault injection
packages/cli             development and operator commands
packages/observability   logs, metrics, traces, inspection
apps/server              HTTP admission and server composition
apps/worker              background execution composition
apps/console             operator UI
infra                    deployment and local services
```

Effect remains the implementation foundation across these packages. There is no separate `effect` package. Packages may expose Effect services without wrapping Effect in another runtime abstraction.

## Workspace setup versus implemented features

The actor-specific packages are private, source-exporting workspace scaffolds. Their empty entrypoints reserve ownership without inventing public APIs or pretending durability is implemented. Each participates in TypeScript and lint checks. Add a test task with the first real behavior test; do not add placeholder passing tests or `--passWithNoTests`.

Use the existing `@project/*` workspace namespace internally. Public npm naming, compiled JavaScript/declaration exports, licensing metadata, and release automation must be settled before publishing. These packages are not currently installable public SDKs. The CLI has no `bin` until commands exist.

`gateway` owns transports; do not create a competing `transport` package. `protocol` owns actor wire schemas, while the existing `contracts` package currently owns the template console/account HTTP API. The SDK depends on protocol, not the server runtime, storage, or authentication providers. Its TypeScript environment excludes Bun/Node ambient globals.

The existing `auth`, `billing`, `email`, `ui`, `contracts`, and database/auth migrations remain because the server and console consume them. They are template/control-plane code, not evidence of actor support. Actor runtime dependencies must not pull billing, email, or the console into self-hosted execution. `database` currently provides the template database layer, not fenced actor transactions.

Dependency declarations establish the initial shared-protocol edges. Add database/runtime integration edges when concrete Effect services are implemented, keeping the graph acyclic. Applications compose layers; reusable packages must not import applications. The server will compose runtime and gateway, and the worker will compose runtime and work. Neither currently executes actors.

Only server, worker, and console are apps. No examples, documentation app, benchmark app, or conformance app is included. The testing package is reusable library infrastructure, not a separate runnable test product.
