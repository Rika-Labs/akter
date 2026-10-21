# Brief for the tester

Fill in the brackets and send it to a fresh-context agent. Do not include the diff, the plan or your
reasoning.

```text
Write unit and integration tests for this requirement: <what the user or caller must be able to do,
including error cases, in plain words>.
Entry points: <public Effect client, actor actions, CLI commands, routes or docs pages; no internals>.
Run them with: <the owner's test commands from its package.json>.
You did not write this code and must not read its implementation before your tests exist. Read the
requirement, the entry points' types and the existing tests nearby, then write tests per
.agents/skills/test-it/references/rules.md. Run them. For each test, break the behavior it covers
(revert or change the line), confirm it fails, and restore it.
Reply with: each test and the behavior it pins, the run output, the break each test failed on, and any
requirement you found ambiguous.
```
