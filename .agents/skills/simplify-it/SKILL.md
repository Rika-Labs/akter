---
name: simplify-it
description: States the essence and cuts code, UI, copy or plans that don't serve it, without changing behavior. Use for "simplify it", "distill it", "strip it down", "Rick Rubin", or a cluttered design.
---

# Simplify it

Done: removing anything else would break the essence, and everything still behaves exactly as before
unless the user agreed to a change. Take Rick Rubin's approach, not his voice.

1. **Essence.** One sentence under 25 words: what this is for and what the person can do because of it.
   Needs "and also"? Narrow the scope.
2. **Must exist.** One to three things. Everything else is optional until proven.
3. **Raw version** (new work only): platform elements, plain functions, the repo's components.
4. **Cut.** For every element, line, prop, option, dependency, function, section and step ask "what happens
   if this is gone?" Nothing important: delete. Repeat once. Stop when the next cut breaks the essence.
5. **Read it fresh** as a first-time user; fix or cut what makes you pause. Spacing: `align-it`.

## Same behavior

- Outputs, effects, triggers, permissions, timing and public APIs stay the same.
- The same tests pass before and after (`test-it`), and outputs are compared where practical.
- List any behavior change and get the user's agreement before making it; never fold it into the cleanup.

## What to cut

- **Code:** dead code, one-caller helpers and pass-through wrappers (inline them), extra layers,
  speculative abstraction, unasked-for options, checks for impossible states, dependencies the platform
  covers; flatten nested branches, and use a type or lookup table instead of scattered conditionals.
- **UI:** one focal point and one primary action per screen; whitespace over borders and cards; one
  typeface, at most three weights, neutrals plus one accent; motion only to explain a change; real content.
- **Copy:** the headline says what it is, the button what will happen. Cut adjectives and repeats.
- **Plans:** steps that don't serve the sentence; park "later" in a note.
- **Duplicates:** `dedupe-it`.

## Never cut

Stated requirements, accessibility (labels, focus, contrast, keyboard, phone width), real error states,
tests, or in a procedure any command, gate, order, prohibition or error string. Cut only inside this
change. If the request itself adds clutter, build it and say in one line what you would remove.

**Reply:** the essence, each cut with its reason, what you kept and why, the size change
(`git diff --stat`), and confirmation behavior is unchanged (tests before and after).
