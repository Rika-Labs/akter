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
packages/observability   logs, metrics, traces, inspection
apps/*                   runnable processes and examples
infra                    deployment and local services
```

Effect remains the implementation foundation across these packages. There is no separate `effect` package. Packages may expose Effect services without wrapping Effect in another runtime abstraction.
