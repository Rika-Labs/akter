# Control-plane feature flags

**Responsibility:** define evaluation and override persistence for `@akter/flags`.
**Authority:** normative.
**Owner role:** control plane.
**Change policy:** changes require matching API documentation and failure evidence.

Flags MUST be declared in application code using a synchronous Effect Schema codec with a JSON encoded representation and a typed default. Defaults MUST validate when declared. Overrides MUST validate their entire rule, including targets that do not match the current caller, against the declaration before replacement. Invalid rules MUST fail without changing stored state.

Evaluation MUST use this precedence: exact user override, exact organization override, matching percentage rollout, global value, declaration default. `false`, zero, empty strings and `null` are values, not missing overrides. Unknown or inherited declaration keys MUST fail with `UnknownFlag`; overrides for retired flags MUST be ignored. Invalid known rules MUST fail with `InvalidOverride` rather than silently falling back.

Rollout MUST use FNV-1a with offset 2166136261 and multiplier 16777619 over the UTF-16 code units of the compact JSON array `[flagKey, identityKind, identityId]`. The unsigned 32-bit result modulo 10000 is selected only when strictly less than `percentage * 100`. Percentages MUST be finite and between 0 and 100 inclusive. A user identity takes precedence over an organization identity; the identity kind is `user` or `organization`, preventing namespace collisions. A caller without either identity MUST NOT enter a rollout, even at 100 percent. Assignment MUST NOT depend on time, process state, rule order or a random seed.

The Postgres store MUST replace each flag's complete rule atomically by primary key and delete idempotently. Evaluation MUST read the store without a process cache. Store or decode failures MUST remain `StoreError`, never a default. Writes inside an Effect SQL transaction MUST share its commit, rollback and interruption outcome. Simultaneous complete replacements are last-committed-write wins; compare-and-swap, audit history and multi-flag transactions are not provided by the package.

Target identifiers MUST come from authenticated server context. Flags MUST NOT grant authorization. Only trusted administrative application code may write overrides; the package provides no public management endpoint. Browser snapshots MUST contain only resolved JSON values for the authenticated target, never the full user or organization targeting dictionaries. The browser-safe export MUST not import SQL or server storage. Browser snapshots can be stale and MUST NOT be trusted by the API for access control.

The memory store is test-only, isolated per layer build and non-durable. The flags package owns its schema as idempotent statements (`flagMigrations`, applied by `migrateFlags` under an advisory lock) that a host runs at startup; the store MUST NOT create tables during evaluation. Neki and hosted API/console endpoint wiring remain unverified.
