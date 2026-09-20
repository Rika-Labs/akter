# v1 — recovered source material

Recovered on **2026-09-19** from [the original discussion](https://ampcode.com/threads/T-01a0b54d-b476-74c0-81bc-b3aae5ce5784). This is a historical snapshot, not the current implementation specification.

## Artifact inventory and provenance

All six generated documents were downloaded directly from the source thread workspace. Their source paths were `/home/user/workspace/<filename>`; the destination preserves their exact bytes under `generated/`.

| Artifact | Role in original discussion |
| --- | --- |
| [Architecture](generated/durable-actors-architecture.md) | Latest consolidated design; superseded earlier documents in that discussion |
| [Adversarial review](generated/durable-actors-adversarial-review.md) | Earlier risks and two-store analysis |
| [V1 surface](generated/durable-actors-v1-surface.md) | Proposed public API and examples |
| [Scenarios](generated/durable-actors-scenarios.md) | Use cases and unmeasured capacity estimates |
| [Hybrid review](generated/durable-actors-hybrid-review.md) | Historical Cloudflare/Neki assessment |
| [Global distribution](generated/durable-actors-global-distribution.md) | Historical cells and regional deployment design |
| [Execution-package ZIP](source/durable-actors-execution-package.zip) | Original archive, retained intact |
| [Extracted execution package](source/extracted-package/durable-actors/START_HERE.md) | All 323 archive entries, including hidden files, docs, research data, scaffold, tests, infrastructure, and validation artifacts |

Archive source workspace path: `/home/user/workspace/attachments/durable-actors-execution-package.zip`.

Original attachment: [durable-actors-execution-package.zip](https://ampcode.com/user-content/attachments/3d71600a750cdd4c16e25e914eb624d79f997091beb00934076109330098f6db-durable-actors-execution-package.zip).

`SHA256SUMS` records the recovered documents, archive, and extracted files relative to this directory. Verify with `sha256sum -c SHA256SUMS` from `research/v1`.

## Preservation boundaries

- The source thread inventory identified these six documents and the execution package. All were recovered. The rendered portal is a presentation of the source documents, not a recovered static site: [historical portal](https://t-03gw4r76drn66hifzdqmej24k-p24169.onamp.dev/).
- A DOCX named `tcc-proposal-v2-draft (1)(1).docx` was mentioned in the source discussion but was not available there; it is not included and must not be claimed recovered.
- Original Cloudflare, Turso, licensing, and roadmap references remain as history. They do not override the user's newer requirements.
- The execution package is a scaffold, **not a working actor runtime**. Its own [validation report](source/extracted-package/durable-actors/VALIDATION.md) records a failed topic-coverage check and explicitly disclaims runtime verification.
- Imported scripts, workflows, and services have not been executed or promoted to the repository root. Their inclusion is preservation, not endorsement.
- Importing the package's license does not select a license for the new project. Older materials conflict on MIT versus Apache-2.0.

See [v2](../v2/README.md) for the revised assessment.
