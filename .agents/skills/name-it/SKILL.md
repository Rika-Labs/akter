---
name: name-it
description: Picks the shortest plain name that says what a thing is, for packages, apps, skills, folders, files, functions, types and variables. Use for "name it", "what should we call this", renames, or any new package, file, function or skill.
---

# Name it

Done: a newcomer guesses what it is from the name alone, and no word in it can be removed.
Rick Rubin naming: say the thing, then stop. Follow the
[repository structure](../../../docs/internals/architecture/repository-structure.md); `bun run lint:structure`
checks its boundaries. This skill is about choosing the word.

1. **Say it in one sentence.** "This ___ does ___ for ___." The noun or verb you reach for first is
   usually the name.
2. **Use Akter's word.** Take it from [README.md](../../../README.md) and the owning
   [runtime contract](../../../docs/internals/contracts/README.md); never a synonym for an established concept.
3. **One word, then two.** Prefer one plain word; add a second only to tell two real things apart. Cut
   every word the location already says (example: `thread/commands/cancel.ts`, not `thread-cancel-command.ts`).
4. **Match the kind.**
   - **Folders and packages:** the subject they own (`calendar`, `code-storage`, `tool-sdk`).
   - **Files:** the role or operation inside that subject (`view.ts`, `update.ts`, `cancel.ts`).
   - **Functions:** a verb for what they do (`cancelRun`, `resolveRelease`); a noun for what they return
     when they do nothing else (`threadTitle`).
   - **Types and classes:** the noun the domain uses (`Thread`, `Receipt`), never `Manager`, `Helper`,
     `Data`, `Info` or `Impl`.
   - **Booleans:** a fact that reads true or false (`archived`, `canEdit`).
   - **Skills:** `<verb>-it`.
5. **Plain over clever.** No puns, abbreviations the reader must decode, version numbers (`v2`, `new`,
   `old`) or names of how it works when what it does will do.
6. **Check it.** Search the repo: a name that already means something else gets a different word. Read
   it at a call site; if it needs a comment to explain it, rename it.

**Reply:** the chosen name, the sentence it came from, and the two runner-up names with why they lost.
