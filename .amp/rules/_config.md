---
concurrency: 8
batchSize: 4
timeoutMs: 1500
budgetMs: 5000
contextLines: 16
maxFileBytes: 262144
maxAdvisories: 12
---

# Rule engine settings

Shared engine settings for the `.amp/rules/` catalog. `concurrency` bounds
concurrent file reads and Jev batches (code batches are clamped to 10 rules);
`batchSize` is rules per evaluation; `timeoutMs` bounds one evaluation and
`budgetMs` the whole post-change check; `contextLines` widens each changed
hunk; `maxFileBytes` caps snapshot reads; `maxAdvisories` caps emitted
findings. Per-rule `timeoutMs` and `contextLines` are intentionally unset so
these values govern.
