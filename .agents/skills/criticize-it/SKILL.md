---
name: criticize-it
description: A fresh-context critic attacks a plan before it is built and returns SOUND, REVISE or RETHINK with evidence. Use before building any plan bigger than a one-line fix, for "poke holes" or "is this the right approach".
---

# Criticize it

Done: a verdict with every lens checked or marked n/a and every finding backed by evidence.

If you wrote the plan, send a fresh agent [references/brief.md](references/brief.md), on a different model
family when available and the most careful level for auth, data model, migrations or money. If you are the
critic, continue.

1. **Steelman.** The goal and approach in three sentences. If you can't, that is the first finding.
2. **Lenses.** One line each: what you checked, or n/a and why.
   - **Problem:** root cause or symptom; evidence it exists.
   - **Simpler:** delete, reuse, a setting or nothing; why the plan wins or loses against it.
   - **Assumptions:** about code, data, users, providers; verify load-bearing ones read-only and mark each
     verified, false or unverified.
   - **Failure:** dependencies slow, down, wrong or rate-limited; concurrency, crash midway, retries.
   - **Data:** migrations, backfills, old and new versions side by side, real rollback.
   - **Scale and cost:** calls and money per action; what breaks at 10× and 1000× (`scale-it`).
   - **Security:** who sees or does what; leaks across callers, tenants or actor scopes.
   - **Blast radius:** other callers, other people working there, user-visible change.
   - **Proof:** a failing test first, and a proof that would catch the failures above.
   - **Scope:** what the goal doesn't need (`simplify-it`), what it needs that's missing.
   - **Rules:** conflicts with `AGENTS.md`, the owning runtime contract, a skill or a decision; cite it.
3. **Findings.** At most seven, ranked. Each: severity (blocker, major, minor), evidence (`file:line`,
   command output, doc, number), consequence, and the smallest plan change that fixes it. A worry without
   evidence is a question. No style or taste. Don't rewrite the plan or reopen decided items; a decision
   that causes a blocker is a challenge for its owner.

## Verdict

- **SOUND:** no blocker or major finding; every lens checked or n/a.
- **REVISE:** right approach, listed changes needed. Too vague to judge is REVISE, never SOUND.
- **RETHINK:** wrong approach; give the one you would take.

The author answers every blocker and major. A RETHINK gets a fresh critic on the revision; a second RETHINK
goes to the decision owner.

**Reply:** verdict on the first line, then steelman, ranked findings, assumptions marked, questions for the
owner, what you couldn't check.
