# Research and validation limitations

This is a dated design and setup package, not a certification of the upstream projects or a production system.

- Source inspection establishes what a specific revision says. It does not prove the correctness of that implementation under partitions or release compatibility with every example online.
- Source-derived package version candidates must be distinguished from installed and tested dependencies. Consult `toolchain.lock.json` and `../VALIDATION.md`.
- Provider pricing is time-sensitive, location/plan-dependent and may require a fleet/resale agreement. The numerical cost model uses labeled hypotheses rather than presenting an enterprise quote.
- A self-hostable database engine is not automatically equivalent to a managed many-database cloud. Provisioning, backup, credential scoping, fleet limits and recovery remain operational concerns.
- No paid infrastructure, Railway deployment, Turso database, PlanetScale branch, secret or npm package was created by this task.
- No actor runtime, server, projection relay, workflow adapter or managed service has been implemented. Empty entry points and deliberate failure scripts keep that distinction visible.
- Local validation of reference SQLite triggers is a SQL experiment, not proof of Turso trigger support or the end-to-end projection pipeline.
- A generated repository with contract/import tests cannot establish latency, throughput, durability or isolation. Release gates in `VALIDATION_GATES.md` require implementation and fault injection.
- Legal terms, licensing and commercialization decisions should receive qualified review before publication or customer contracting.

The package includes source links and dated decision status so later evidence can change a decision without rewriting the project story.
