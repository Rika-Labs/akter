# Template

The fenced content is a template, not a list of existing files. Replace angle-bracket placeholders;
the example shared-procedure path is relative to the new skill's `SKILL.md`, not this reference file.

```markdown
---
name: <verb>-it
description: <What it does, one clause>. Use for "<phrase>", "<phrase>", or <situation>.
---

# <Verb> it

Done: <the observable end state, with its threshold>.

1. **<Step>.** <Imperative instruction with the exact path, command or number.>
2. **<Step>.** <Instruction.> Details: [references/<topic>.md](references/<topic>.md).
3. **<Step>.** <Instruction.> Shared procedure: `../prove-it/references/stack.md`.

**Reply:** <what the answer contains, in order>.
```

## Optional parts

- `## Rules` for constraints that apply across steps.
- `## Verdict` when the skill returns a fixed set of outcomes.
- An example `references/brief.md` when the skill hands work to a fresh-context agent: a fenced `text` prompt with
  bracketed blanks, ending with the reply format.

## Before and after

Before (reasons, procedure in the description, no end state):

```markdown
description: Helps make UI aligned. Measures things carefully because CSS boxes lie, then fixes them in
the right order and adds tests so it stays fixed.

A CSS box is not what the eye sees, so measuring is important...
```

After:

```markdown
description: Makes a control line up by measuring glyph and icon ink with red-line overlays. Use for
"align it", "off-center", "sits low" or "uneven padding".

Done: every named center, edge, inset and gap is within 0.5 CSS px at every checked viewport and theme.
```
