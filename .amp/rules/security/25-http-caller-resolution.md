---
enabled: true
paths:
  - packages/durable-actors/src/serve/**
  - packages/durable-actors/src/runtime/**
exclude:
  - "**/*.test.ts"
on: code-change
severity: error
threshold: 0.9
priority: 20
contextFiles:
  - docs/contracts/10-security.md
  - docs/contracts/protocol.md
---

# Served endpoints resolve the caller per request

Caller identity is resolved per request at the trusted edge: concurrent
requests with different access tokens get different principals, and an
endpoint that requires authentication fails missing or invalid credentials
with `ActorError(Unauthorized)` — it never runs as `Anonymous`. `Actor.serve`
requires auth configuration; `Actor.auth.none` is the explicit public opt-out.

Violations: resolving the caller once per connection or process instead of
per request; falling back to `Anonymous` when credentials are absent or
invalid on an authenticated endpoint; caching a principal across requests;
letting a client-supplied identity header through unverified at the edge.

Clean: `CurrentCaller` defaults to `System({ source: "process" })` for code in the application's own process; each HTTP
request decodes and verifies its own credentials before any turn runs;
`Unauthorized.code` carries `missing_credentials` / `invalid_credentials` /
`expired`.

Flag only a visible shared-resolution or anonymous-fallback defect. Explicitly
public endpoints under `Actor.auth.none` are correct — do not flag them. Serve
is not yet implemented; match only real code.
