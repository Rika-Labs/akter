# Jev rule catalog

**Responsibility:** catalog the semantic quality rules under `.amp/rules/` and record how they relate to existing enforcement.
**Authority:** advisory evidence — rules flag candidate violations for review; they do not change contract authority.
**Owner role:** verification.
**Change policy:** rule additions or removals update this catalog in the same change.

## What this is

`.amp/rules/` holds 45 Markdown rule files evaluated in-thread by the global
Jev plugin, plus the reserved `_config.md` engine settings file. Each rule
carries strict frontmatter — `enabled` (boolean), `paths`/`exclude` (lists of
`*`, `?`, `**` globs; no brace expansion), `on` (`code-change` and/or
`command`), `severity` (`info`/`warning`/`error`), `threshold` (0..1),
`priority` (-100..100), and optional `contextFiles` (at most 4 exact
workspace-relative paths, no globs). Per-rule `timeoutMs` and `contextLines`
are intentionally unset so `_config.md` governs. The body states a single
invariant, what violates it, what is clean, and when to abstain.

Rules detect explicit, locally visible problematic sequences — a commit path
without a fence, a dedup key that includes caller identity, a test that fakes
recovery. They do not prove the absence of races, do not judge test
completeness, and never flag code they cannot see.

## How evaluation works

After a file-modifying tool call completes, the plugin diffs before/after
snapshots of the touched files. This project's `allRules: true` assesses all
45 enabled code rules on every supported edit, including unrelated rules,
which must abstain. `batchSize: 1` sends one state/questions request per rule;
`concurrency: 512` admits the whole catalog without local request waves.
Alternatively, `batchSize: 512` combines shared-state questions and splits
requests exceeding the plugin's 120,000-byte heuristic before I/O. These are
local bounds, not a provider question-count limit or a token guarantee.
Each code rule is asked three questions per batch: a comply/violate/unknown
verdict, a supporting-snippet citation, and an exact changed-line citation —
a violation is emitted only when the cited line is a real changed line in a
snippet the rule's `paths` actually cover, or the complete edit is removal-only
and the removal itself is cited. Truncation cannot turn a replacement into a
removal-only edit. `contextFiles` excerpts are
read-only supporting evidence and are never citable as the violation itself.
A `threshold` of 0.9 is the catalog-wide starting point: conservative and
uncalibrated.

`on: command` rules evaluate the shell command text itself, not file paths.

## Authority and reporting

Evaluation is advisory only. Findings are emitted as advisories in the
thread; they do not block tool calls, they are not a Turbo task, they are not
run in CI, and they are not a pre-push gate. One aggregate per assessed edit
contains coverage counts and one representative finding per broken rule.
`maxAdvisories: 512` allows every catalog rule to appear, even when several
evidence windows implicate the same rule. Finished findings survive a sibling
request timing out; failures and abstentions remain explicitly unchecked.
Proof no longer runs in this
repository — `proof.rules.ts`, its plugin, and `bun run proof:check` are
removed, and the generic semantics worth keeping migrated into the `quality/`
rules.

The engine checks only files it can snapshot and diff through the modifying
tool call. Changes produced by shell formatters and by external editors are
not source-snapshotted and are not guaranteed to be checked; a silent hook is
not a green result. There is no all-file completeness: unchanged files are
never evaluated.

`jev_rules_status` reports the last check as `complete`, `unchecked`, or
`stale`. `complete` means scheduled assessments returned, not that the code
passed; inspect the violation counts. Any unknown answer, skipped or oversized file, truncated snippet,
unavailable evaluation, or diagnostic marks the check `unchecked` — unknown,
skipped, and truncated evidence is reported, never counted as clean. A
`stale` result means the files or catalog changed mid-evaluation and the
report was discarded.

## Why these rules

The catalog encodes the invariants in `docs/contracts/` and
`docs/verification/invariants.md` that a linter cannot see: transactional
scoping, authority boundaries, identity stability, and honest test evidence.
Domain rules name their owning contract in `contextFiles` so evaluation reads
the normative text, not folklore. The `quality/` rules carry generic
engineering semantics (naming, comments, cohesion, error typing, assertion
honesty, and the no-AI-surface constraint) that previously lived in the
Proof rule set.

## Overlap decisions against existing enforcement

`.oxlintrc.json` and the custom `durable-actors`/`anti-slop` lint rules
(mechanical lint) already cover adjacent ground. Deliberate splits:

- Linted concerns — filename shape, directory structure, import surfaces,
  Effect idioms, barrel indexes — are not duplicated.
- The `quality/` rules cover semantic judgments lint cannot compute: whether
  a name identifies its operation, whether a comment adds information,
  whether unrelated domains share a module, whether a typed error keeps its
  cause, whether a new API exists only for AI consumers, whether a test's
  assertions can actually fail.
- Type assertions do not require `SAFETY:` prose. The mandatory-comment lint
  rule is disabled; the comment rule rejects boilerplate assertion
  justifications and test-location breadcrumbs while allowing non-obvious
  constraints and public contract documentation.
- Testing rules judge the honesty of test evidence (independent expectations,
  real volatile-state loss, real contention, truthful skips, barriers,
  durable assertions) rather than demanding coverage — a rule must never
  claim a missing test from a narrow snippet it cannot fully see.

## Scope and activation

Rules are `enabled: true` with narrow `paths`. Six rules target subsystem
directories that are currently `.gitkeep` placeholders — `runtime/events`
(19), `runtime/connections` (20), `runtime/database/neki` (21),
`runtime/effects` (22), `runtime/workflows` (23, 24). All-rule mode evaluates
them too, but their paths have no citable implementation until it lands;
they must abstain rather than demand future features. Rules 25 and 29
also cover `serve/` (likewise a placeholder) but additionally scope
`runtime/`, so they are active on the `runtime/` portion now. The remaining
rules match live code or test files today. Rule 43 guards the public actor
capability and minted-only identity boundary. Rules 44–45 cover the API's
handler/service/repository split and Effect-native Drizzle usage. The existing
creation-marker (06) and contention-test (33) rules also cover the specific
pre-policy creation and fake lock-timeout regressions found in the M0 review.

## Limitations

- Rules flag explicit local violations only; absence of findings is not proof
  of correctness.
- A rule firing on deliberately bad fixture/test code is a false positive by
  design tolerance — bodies instruct abstention, but judgment is
  probabilistic (`threshold` sets the bar).
- `contextFiles` are the normative anchor; when a contract and a rule
  disagree, the contract wins and the rule is a bug.
- Jev cannot observe runtime behavior; concurrency claims still require the
  failure matrix and conformance gates.
- Unit or mock tests of rule parsing prove format validity only; they do not
  prove Jev classification accuracy, which is calibrated by dry-runs and
  seeded violations, not asserted.

## Local validation (2026-09-22)

The production loader with the real privacy filter loaded the original 42 rules with
zero catalog diagnostics. Reference-file checks skip `10-security.md`,
`01-conformance.md`, and `02-failure-matrix.md`: their credential-example
prose triggers the conservative privacy filter. Four other references exceed
the 4KiB excerpt cap (`02-command-turns.md`, `invariants.md`,
`01-server-api.md`, and `02-context.md`). Dependent checks remain explicitly
incomplete; no privacy bypass or contract rewrite was added to hide this.
The original 42-rule catalog was not calibrated against live predictions; the
three new rules have not been calibrated either.

The global plugin's `evals/rules-benchmark.ts --fanout --live --catalog=<project>`
measured the original 42-rule catalog against a synthetic one-line runtime edit, with the real
privacy filter, default 8-line context, one reused client and an empty answer
cache per trial (74 provider calls total). The 500-rule trial repeats the
42-rule catalog; it is not 500 independently calibrated rules.

| Rules | Request mode    | Concurrent requests | End-to-end | Returned assessments | Returned by 300ms |
| ----- | --------------- | ------------------- | ---------- | -------------------- | ----------------- |
| 42    | Batched         | 2                   | 1049ms     | 42/42                | 0/42              |
| 42    | One per rule    | 42                  | 527ms      | 42/42                | 14/42             |
| 500   | Batched         | 28                  | 1042ms     | 438/500              | 0/500             |
| 42    | Batched, repeat | 2                   | 668ms      | 42/42                | 0/42              |

These include snapshot/diff and freshness checks, not just network time.
Returned assessments include `unknown`: 26 of 42 abstained in the single-rule
trial; the existing unavailable/truncated references also keep coverage
unchecked. Four requests in the 500-rule trial failed before the timeout,
leaving 62 assessments unavailable; the experiment does not distinguish
transport/provider failures from invalid normalized answers.

The current choice of one request per rule follows this sample, not an
optimality claim. **The under-300ms complete-result target is not met.** A
300ms deadline would return incomplete coverage, not make the provider finish
faster. Mock barrier tests verify 500 requests can start before any answers and
produce one aggregate with all expected findings; they do not establish live
provider capacity. No 500-request live burst was run.

## Evaluation plan

1. Dry-run the catalog against the current tree; expected result is zero or
   near-zero findings (M0 evidence is green). Investigate any finding as
   either a real defect or a rule calibration error.
2. Seed known violations on a scratch branch (e.g. a dedup key including
   caller, a recovery test without a kill) and confirm the matching rule
   fires at its threshold.
3. Tune `threshold`/`severity` per observed noise; record tuning changes here.
4. When placeholder-path subsystems land, verify their rules can cite the new code and re-run
   step 1.
