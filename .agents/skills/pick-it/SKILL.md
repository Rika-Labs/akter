---
name: pick-it
description: Routes a task to the right -it skills, in order, and holds the rules every task follows. Use at the start of any non-trivial task or when unsure which skill applies.
---

# Pick it

Done: the task's skills are chosen and read, in order, and the rules below are followed.

Read only the skills the task needs, at `../<name>/SKILL.md` (replace the placeholder).
The repository's [AGENTS.md](../../../AGENTS.md) and owning contracts win over every skill rule below.

| Situation                                                              | Skill        |
| ---------------------------------------------------------------------- | ------------ |
| Unfamiliar code; "how does X work"                                     | learn-it     |
| A change bigger than a one-line fix                                    | plan-it      |
| Scoping a change, page, copy or plan; "distill it"; it feels cluttered | simplify-it  |
| The same thing exists in more than one place                           | dedupe-it    |
| A plan to attack before building                                       | criticize-it |
| The change keeps fighting the code                                     | rethink-it   |
| A bug, regression, red CI or flaky test                                | root-it      |
| Any page, route, panel or navigation                                   | ssr-it       |
| UI must match an outside reference                                     | match-it     |
| Off-center, sits low, uneven spacing                                   | align-it     |
| A number should move; "which is better"                                | climb-it     |
| New endpoint, query, list or fan-out                                   | scale-it     |
| Any browser step                                                       | browse-it    |
| Tests for a change; using it like a caller before done                 | test-it      |
| The change is written                                                  | prove-it     |
| Before it ships                                                        | break-it     |
| Explaining a system, finding or change                                 | explain-it   |
| Naming a package, file, function, type or skill                        | name-it      |
| Writing or editing a skill                                             | make-it      |

**Order.** Change: learn-it → plan-it (simplify-it, criticize-it) → build (ssr-it, align-it, match-it) → test-it → prove-it → break-it.
Bug: learn-it → root-it → test-it → fix → prove-it → break-it. After a criticize-it RETHINK, a third break-it round, or a cause in the
design: rethink-it.

## Rules for every task

- **The real thing.** Match evidence to the claim: public-API seeded Simulation for engine failures,
  real buckets for protocol behavior, browser evidence for documentation UI. Follow
  [testing](../../../docs/guides/testing.md) and [verification](../../../docs/verification/README.md);
  local or MinIO evidence never certifies a provider.
- **Measure.** Visuals, speed and scale are decided by numbers, never by eye.
- **Causes.** Fix where the system first went wrong; retries, sleeps and guards are not fixes.
- **Subtract first.** Remove before you add. The smallest change that meets the goal wins.
- **Fresh eyes.** Plans, tests and finished changes come from a fresh-context agent that did not write the code.
- **Doubt the check.** When a check disagrees with you, suspect how you observed before the system.
- **Pause** for production, shared infrastructure and destructive steps unless explicitly authorized.
- **Evidence** lives outside the repo. Never print or save secrets or auth state.

**Reply:** name the skills you used and what each changed.
