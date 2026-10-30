# Internals

These pages are for people working on Akter itself. They record what the runtime must guarantee, why it's built the way it is, and the evidence that it works. To use Akter, read the [documentation](../README.md) instead.

| Folder or page                         | What's in it                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| [contracts](contracts/README.md)       | The runtime's guarantees, written as requirements. Code changes start here.     |
| [decisions](decisions/README.md)       | Architecture decision records, including the ones that were later superseded.   |
| [architecture](architecture/README.md) | How the engine is put together, and the repository's layout rules.              |
| [verification](verification/README.md) | The failure scenarios each guarantee is tested against, and dated test records. |
| [vision](vision/README.md)             | What the product is for, and what it deliberately isn't.                        |
| [milestones](milestones/README.md)     | The rewrite plan that produced 0.2, and the 0.1 milestones before it.           |
| [security](security/threat-model.md)   | The threat model, authorization model and data classification.                  |
| [product](product/customer-stories.md) | Intended workloads and positioning notes.                                       |
| [glossary](glossary.md)                | The internal vocabulary: shards, epochs, segments and the rest.                 |
| [benchmarks](benchmarks.md)            | Local performance runs and profiling notes.                                     |
| [releasing](releasing.md)              | How packages are published to npm.                                              |

When these pages disagree, an accepted decision wins over a contract, and a contract wins over an architecture page. Dated verification records describe what was observed on that date and aren't rewritten afterward, so older ones may describe code that no longer exists.
