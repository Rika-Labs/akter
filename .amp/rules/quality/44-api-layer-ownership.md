---
enabled: true
paths:
  - apps/api/src/**
exclude: []
on: code-change
severity: warning
threshold: 0.9
priority: 10
---

# API handlers, services, and repositories own distinct work

`app.ts` composes layers and routes. Feature `handler.ts` files own HTTP
request parsing, origin checks, cookies, and responses. Feature `service.ts`
files own authorization decisions, provider calls, and business mapping.
Feature `repository.ts` files own application database queries and transaction
boundaries. Do not put SQL or Drizzle queries directly in HTTP handlers or
business services.

Violations: a handler or `app.ts` selecting or writing application rows;
a repository making HTTP responses or authorizing a user; a service embedding
a SQL statement or calling Drizzle's query builder instead of its repository.

Clean: health and auth forwarding without a repository; composition imports
several feature handlers; a service calls a repository and maps its result;
the repository checks membership again inside a transaction. Flag only a
visible misplaced implementation, not a missing layer inferred from a narrow
diff or a file name alone.
