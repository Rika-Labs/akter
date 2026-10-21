---
name: explain-it
description: Explains a system, decision, finding or change so a newcomer gets it in one read, using real traced cases, diagrams and code. Use for "explain", "walk me through", "ELI5", "how or why does this work", or to make an earlier answer easier to follow.
---

# Explain it

Done: the reader understands in one read and loses nothing that would change what they do. Detail moves
lower, never out.

1. **Reader.** Who they are and what they will do with it. Unknown: a smart person new to the subject.
2. **One sentence** holding the whole answer and its key number or name. Can't? Reread the source.
3. **Stay inside the source.** Every claim, heading, diagram label and "always", "only", "needs" or
   "before" has a source line, or is marked "typically", "my inference" or "for example". No estimates the
   source lacks. Counts add up or the gap is stated. Never claim the reader's work or misattribute a claim.
4. **Terms.** Anything not an everyday word, abbreviations in paths included, gets one name and a plain
   definition in or before its first sentence, ordered so none depends on a later one. Use the source's
   word.
5. **Visuals and code** per section from [references/visuals.md](references/visuals.md), chosen before
   drafting. Use the real code or message, run if possible.
6. **Write** in this order, drafting 2–6 before 1:
   1. The answer: at most two sentences under 30 words, with the verdict or count, each named case, and the
      biggest blocker or first action. Nothing before it.
   2. One real case, traced step by step with real names and numbers (swimlane for several actors).
   3. A second case that goes differently, drawn as a fork where they diverge.
   4. The pattern the two cases show; a table only for choosing among options.
   5. What follows, in order; "A needs B" for dependencies, with running totals.
   6. Where this is wrong or unchecked.
7. **Style** per [references/style.md](references/style.md).
8. **Audit** per [references/audit.md](references/audit.md), including the fresh-reader check.

To simplify an earlier answer, treat it as the source and start at step 2.

**Reply:** the explanation itself, nothing about the process.
