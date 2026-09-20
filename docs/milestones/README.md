# Milestones

**Responsibility:** sequence implementation and prevent scope drift.  
**Authority:** delivery plan.  
**Owner role:** delivery/runtime lead.

Each milestone owns a vertical slice with explicit non-goals, acceptance tests, evidence, and exit criteria. No later feature is allowed to hide an unproven earlier invariant.

- M0: repository, contracts, test harness, and disposable Postgres
- M1: one actor, one turn, receipts, ownership, fencing, restart
- M2: messaging, events, timers, and post-commit delivery
- M3: Effect API, Drizzle integration, and TypeScript SDK
- M4: realtime, blobs, activities, jobs, and workflows
- M5: live SQL, transfer, hibernation, operations, and backend conformance
