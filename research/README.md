# Durable Actors research

Versioned research for an **open-source, self-hostable durable actor framework with first-class PostgreSQL and Neki support**. Cloudflare Durable Objects are not part of the proposed runtime.

| Version | Purpose | Status |
| --- | --- | --- |
| [v1](v1/README.md) | Original thread artifacts and complete execution package | Historical, preserved unchanged |
| [v2](v2/README.md) | Feasibility assessment under the updated requirements | Preserved technical assessment, 2026-09-19; limits still apply unless superseded |
| [v3](v3/README.md) | Consolidated product specification: 16 feature folders, diagrams, API sketches and validation gates | Current direction, 2026-09-20; not an implemented runtime |
| [v4](v4/README.md) | Effect-native actor API: typechecked `Actor.make` / `X.get(id)` surface, contract–server split, lifecycle policies, mapping to Cluster/Rpc primitives | Supersedes the v3 `Actor.define` sketch only, 2026-09-21; runtime internals unchanged |

## Iteration policy

- Preserve imported artifacts in `v1`; do not silently correct historical documents.
- Preserve the v2 assessment; refine `v3` while this research iteration is active. Use Git for edits within an iteration.
- Start `v4`, `v5`, etc. when adopting a materially different architecture or reviewing new implementation evidence. Each version needs a README stating its date, predecessor, changes, evidence, and unresolved questions.
- Copy only documents needed for the new iteration; link unchanged evidence instead of repeatedly copying the entire original package.
- Research version numbers are **not** product release numbers. The old documents' “V1/V2” refer to their proposed product milestones.
- The user's requirements outrank every research recommendation. The latest research version supersedes earlier recommendations only where it explicitly says so.

Start with [the v3 feature index](v3/README.md) and [decision ledger](v3/DECISIONS.md). The [v2 assessment](v2/README.md) and [validation gates](v2/VALIDATION.md) remain technical evidence. Nothing here authorizes deployments, provider provisioning, or production changes.
