---
name: make-it
description: Writes or edits a skill in `.agents/skills` to the house standard, so it never needs a refactor. Use for "make a skill", "write a skill for X", "turn this into a skill", or any edit to a SKILL.md.
---

# Make it

Done: the skill is short, triggers on its own situations only, holds only what an agent wouldn't already
know, and passes the checks below.

1. **Earn it.** A skill is for a task done repeatedly or a correction given twice. Otherwise:
   - a one-off: say it in the prompt;
   - a rule for every task: `AGENTS.md` or the rules in `../pick-it/SKILL.md`;
   - a rule a type, test, lint or CI step can enforce: enforce it there instead.

   Read the `pick-it` table. If an existing skill covers half of it, extend that skill.

2. **Name.** `<verb>-it`, lowercase, chosen with `name-it`. Folder name equals `name`.
3. **Description.** `<What it does, one clause>. Use for <user phrases and situations>.` Under 250
   characters, third person, no procedure, no triggers another skill already claims.
4. **Body.** Follow [references/template.md](references/template.md):
   - under 50 lines, 80 at most; split detail into `references/*.md`, one level deep;
   - a `Done:` line, numbered imperative steps, a one-line `**Reply:**`;
   - only what the agent can't know: repo paths, commands, thresholds, gotchas, decisions;
   - no reasons unless the rule is confusing without one; one default, not a menu; one term per concept;
   - no dates, people, model ids or machine-specific paths;
   - link shared procedures instead of copying them: `../prove-it/references/stack.md` (stack, pausing the
     API, cleanup), `../browse-it/references/operations.md` (browser steps),
     `../align-it/references/measure.md` (red lines);
   - Markdown only. Add a script only when the user asks for one.
5. **Register.** Add a row to the `pick-it` table and its place in the order. Update `AGENTS.md` if it
   pointed at what this replaces.
6. **Check.**
   - `name` matches the folder; every linked file and named skill exists.
   - `bunx oxfmt --check .agents/skills` passes; audit relative Markdown links and concrete repo paths
     against the checkout. Mark placeholders as examples. This repo has no skill-link-check command.
   - Write three prompts that should trigger it and one that belongs to a neighbor. The description
     matches the three and not the fourth.
   - Walk one prompt through the skill as a fresh agent. Every place you would guess gets a line; every
     line you never used gets cut.

**Reply:** the skill path, its description, the `pick-it` row, and the check results.
