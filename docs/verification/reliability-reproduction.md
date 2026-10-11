# Reliability reproduction

**Responsibility:** distinguish reproduced faults from unresolved intermittent reports.  
**Authority:** evidence.  
**Owner role:** runtime/reliability.

## October 2026 baseline

The baseline was clean framework commit `ef1f12e16178220016a12662ad3a6ea43091e248`, Bun 1.4.2, PGlite 0.5.8 and a dedicated Postgres 18.6 database server on Dallen's Mac. Unloaded runs added no synthetic CPU work; other issue-sweep processes still shared the machine. Loaded runs added 18 independent CPU loops. Every full PGlite run retained the backend's existing capability exclusions: 588 passed cases and 252 unsupported cases, not 840 exercised cases.

| Report                                                     | Baseline attempts                                                             | Result                                                                                                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #716: full-suite offline-client and content-grant failures | Two full PGlite conformance runs without injected load; two with 18 CPU loops | All four passed, including every offline-client and applicable content-grant case. The reported intermittent failures were not reproduced; their cause remains unknown. |
| #621: relay local deadline under contention                | Ten focused real-database runs without injected load; forty with 18 CPU loops | Unloaded: 10 passed. Loaded: 36 passed, four failed the existing `ran >= 2900 && ran < 4000` assertion.                                                                 |

The diagnosed loaded failure recorded `ran = 2866`, `remainingAtStart = 2866`, and `stoppedAfterDatabaseDeadline = 0`, all in milliseconds. The attempt ended exactly at its durable claim deadline, but the provider started 134 milliseconds after the lease began. The fixture had measured the provider's running duration as if dispatch created a fresh lease. Runtime code instead measures the lease conservatively from sending the claim, as required for work that may have stalled before execution.

The corrected case derives elapsed claim duration from the independently configured three-second lease and the unchanged durable `due_at_ms` row. It retains both the 2900–4000 millisecond bound and the separate `endedAt <= due_at_ms + 100` assertion. A deliberate 200-millisecond `beforeExecute` delay makes dispatch and claim time distinct even without contention. An implementation that grants a fresh three-second lease at dispatch would exceed the unchanged durable-deadline assertion. Renewal failure, interruption, ambiguous durable state, takeover and the once-only success receipt remain asserted.

No runtime change or fixture change is claimed to resolve #716. These repetitions establish a non-reproduction result, not absence of a race or a full monorepo verification pass.

After the measurement correction, all forty focused loaded runs passed, as did the complete 33-case real-database relay shard. The final fixture also passed a fresh focused run, conformance typecheck, focused lint and formatting. The corrected repetitions preserve the same timing limits; they do not certify arbitrary event-loop starvation or remote-provider latency.

## Reproduce

Set `TEST_DATABASE_URL` to a dedicated Postgres 18.6 database server with permission to create disposable databases. Prefix repeated suites with `~/.capy/work/akter-launch/heavy.sh` on the shared Mac.

```sh
bun --bun node_modules/vitest/vitest.mjs run tooling/conformance/src/conformance/pglite/backend.test.ts
bun --bun node_modules/vitest/vitest.mjs run --config tooling/conformance/vitest.integration.config.ts --project postgres:relay -t 'interrupts an attempt at its local deadline'
```

The stress load must run in separate processes and be stopped after each batch; it must not block the test event loop itself. Keep original and corrected logs separate, and record claim and dispatch timestamps before changing timing bounds.
