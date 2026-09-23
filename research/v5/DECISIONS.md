# Durable Actors — post-foundation decision ledger (v5, 2026-09-23)

This ledger captures the owner's direction after reviewing the roadmap gaps and Rivet's current agentOS and Dynamic Apps products. It is a product decision record, not runtime evidence.

| Area | Decision | Status |
| --- | --- | --- |
| Existing Postgres | Support observe-then-enforce adoption of legacy tables with explicit ownership mappings. | accepted direction; M6 gate |
| Live data | Build bounded query observation, not arbitrary SQL incremental maintenance. | accepted direction; M6 gate |
| Offline clients | Persist optimistic commands and replay original IDs; expired IDs become visible conflicts. | accepted direction; M6 gate |
| Workflow changes | Require stable step names, version markers, and active-execution deployment checks. | accepted direction; M2 gate |
| Inspection | Provide authorized inspection and export/seed before promising historical rewind. | accepted direction; M6 gate |
| Client reach | Derive MCP and non-Effect language clients from public actor contracts; preserve command identity. | accepted direction; M6 gate |
| Serving | Support scale-to-zero only with measured wake, state-load, due-work, and connection behavior. | accepted direction; M6 gate |
| Agent runtime | Make the database authoritative and sandboxes replaceable effects; keep the core AI-neutral. | accepted direction; M7 gate |
| Dynamic apps | Generate validated Durable Actor contracts, not arbitrary servers; hostile-code isolation remains unsupported until proven. | exploratory direction; M8/security gate |
| Rivet relationship | Compete on durable relational authority and governance rather than reproducing the Rivet VM/kernel. | product positioning |
| Package names | `durable-apps` and `durable-os` were unregistered in the npm registry lookup on 2026-09-23. Availability is a point-in-time observation and must be rechecked before publish. | research evidence |

## Open questions

- Which query algebra can guarantee bounded invalidation cost while remaining useful to Drizzle users?
- Which sandbox providers meet the agent runtime's reconciliation, latency, and cost requirements?
- Does generated-app activation require a first-party VM, or can a reviewed provider boundary satisfy the threat model?
- What package split best communicates that the agent runtime and generated-app platform are optional adapters rather than core actor APIs?
