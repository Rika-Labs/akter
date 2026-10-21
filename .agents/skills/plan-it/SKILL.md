---
name: plan-it
description: Writes a plain, visual plan with diagrams, code sketches and small checkable steps, compares two designs, finds everything that must change with parallel agents, and has fresh agents attack it. Use for "plan it" or any change beyond an obvious fix.
---

# Plan it

Done: a plan a newcomer understands in one read, covering everything that must change, in small steps
that each name their evidence, with every blocker and major hole from the reviewers fixed or answered.

Skip the plan when the change is one or two files with an obvious approach; say so and build.

1. **Learn first.** Run `learn-it` on the parts the change touches.
2. **Goal.** One sentence: what changes for whom. Simplify the scope (`simplify-it`).
3. **Settle open questions by prototype.** If a question can be answered by running something (layout,
   behavior, timing, which approach), build a throwaway in a scratch directory, try it, and keep the
   result. Ask the user only for product or preference calls, as numbered options with a recommendation.
4. **Find everything that must change.** Send 2–4 fresh agents in parallel with
   [references/explorer.md](references/explorer.md), one per slice (for example web, API, data, actors,
   infra, docs and skills). Merge their lists; check anything they disagree on yourself.
5. **Design it twice.** Sketch at least two structurally different approaches, in parallel agents when the
   change is large. For each, write the caller's usage first, then the types, signatures and module
   boundaries with unimplemented bodies. Pick the one with the smaller public surface that hides more,
   and the one where the next agent, copying the nearest example from one file, still does the right
   thing for the whole repo.
6. **Write the plan** in [references/plan.md](references/plan.md)'s shape: before and after diagrams, one
   traced case, the chosen sketch as code, the rejected design in two sentences, the change list by owner,
   and steps that each name their files, what you'll see and the evidence that checks them. Use
   `../explain-it/references/visuals.md` for diagrams and `explain-it`'s plain sentences.
7. **Attack it in parallel.** Send 2–3 fresh agents `../criticize-it/references/brief.md` at once, each
   leading with different lenses (data and failure; security and scale; scope and simpler alternatives),
   on a different model family when available.
8. **Close the holes.** Fix or answer every blocker and major finding, note what you rejected and why, and
   re-send a reviewer if the approach changed. After two rounds, take open disagreements to the user.
9. **Build step by step**, checking each step's box only when its evidence exists (`test-it`). If building
   keeps fighting the chosen design, stop and run `rethink-it` instead of patching around it.

**Reply:** the plan itself, then the reviewers' verdicts, what changed because of them, and what you
rejected and why.
