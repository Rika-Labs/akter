# Sources for the post-foundation review

Checked on 2026-09-23. These are vendor descriptions and point-in-time registry lookups, not performance or security evidence for Durable Actors.

- [Rivet Actors](https://rivet.dev/actors/docs/) — actor identity, state, hibernation, and client surface.
- [Rivet actor actions](https://rivet.dev/actors/docs/actions/) — actions run concurrently by default; queues provide explicit serialized processing.
- [agentOS architecture](https://rivet.dev/agentos/docs/architecture/) — isolated VM, filesystem, syscall mediation, session persistence, and Rivet orchestration.
- [agentOS direct VM API](https://rivet.dev/agentos/docs/core/) — direct VM versus actor-hosted VM integration boundary.
- [Dynamic Apps](https://rivet.dev/dynamic-apps/docs/) — AI-generated Node.js applications in isolated agentOS VMs; preview status.
- [npm: durable-apps](https://registry.npmjs.org/durable-apps) and [npm: durable-os](https://registry.npmjs.org/durable-os) — both returned HTTP 404 on the check date. A 404 is not a reserved name, a trademark clearance, or a guarantee that the name will remain available.

No claim of Rivet's security, latency, or cost superiority follows from these pages; those require comparable measurements and independent review.
