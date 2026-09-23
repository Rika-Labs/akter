---
allRules: true
concurrency: 512
batchSize: 1
timeoutMs: 3000
budgetMs: 5000
contextLines: 16
maxFileBytes: 262144
maxAdvisories: 512
---

# Rule engine settings

Every supported edit assesses all enabled code rules. `paths` and `exclude`
still constrain citable evidence; an unrelated rule must abstain. One aggregate
reports findings and incomplete coverage after the concurrent requests settle.

`batchSize: 1` gives each rule its own state/questions request. `concurrency: 512`
allows the whole catalog to start without local request waves; file reads remain
capped at 32. Set `batchSize: 512` to prefer shared-state batches instead; oversized
requests split before I/O. A live 42-rule sample favored single-rule fan-out,
but did not achieve the 300ms target. Provider quotas and latency still apply.

`timeoutMs` bounds one evaluation; `budgetMs` bounds evaluation and queue time,
excluding snapshot I/O. These are failure limits, not latency promises.
`contextLines` widens each changed hunk; `maxFileBytes` caps snapshot reads;
`maxAdvisories` allows one finding for every rule in a full 512-rule catalog.
Per-rule `timeoutMs` and `contextLines` are intentionally unset so these values
govern.
