# Brief for the verifier

Fill in the brackets and send it to a fresh-context agent.

```text
Verify commit <full 40-character SHA> in a clean worktree at that SHA (git worktree add ../verify <sha>).
Claim: <what should be true now, in two sentences>.
You did not write this. Do not edit product code and do not trust the author's evidence; redo it.
Start your own stack per .agents/skills/prove-it/references/stack.md and use an isolated agent-browser
session for every attack. Never use production. When you finish, stop only processes whose working
directory is inside your worktree.
Attack it with the break-it skill. Reply with one line, PASS, FAIL or INCONCLUSIVE, then the evidence
(commands with output, screenshots), what you tried, and what you could not check.
```
