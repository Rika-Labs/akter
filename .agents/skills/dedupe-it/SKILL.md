---
name: dedupe-it
description: Finds duplicated code, config, workflow steps, types and docs, keeps one owner, points everything else at it and deletes the copies, without changing behavior. Use for "dedupe it", "remove duplication", "this is copied", or near-identical files.
---

# Dedupe it

Done: each piece of knowledge has one owner, every former copy imports, calls or links that owner, and
everything behaves exactly as before.

1. **Find copies.** Search for repeated logic, constants, schemas and types, copied config and workflow
   steps, near-identical files, and docs or comments that restate code or checks. Diff the candidates.
2. **Same reason to change?** Merge only copies that must always change together. Code that merely looks
   alike but serves different owners stays separate; merging it creates coupling.
3. **Pick the owner.** The module that owns the concept today. A shared package only when two apps
   genuinely share it; never a generic `shared`, `utils` or `common` home. For docs, the owner is the
   owning contract or guide; link to it instead of restating it. Never delete a target contract because
   the current code disagrees with it.
4. **Converge.** Move any real differences into explicit parameters, point every caller at the owner,
   then delete the copies in the same change.
5. **Prove it's the same.** The same tests pass before and after (`test-it`), outputs match for each
   former copy, and the owning package's checks plus `bun run lint:structure` pass. Any behavior difference you find is listed for the user,
   not quietly picked.

**Reply:** each duplicate found, the owner chosen and why, what was kept separate and why, the size change
(`git diff --stat`), and the before and after test results.
