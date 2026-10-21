# Aside

```bash
export PATH="$HOME/.local/bin:$PATH"
PROFILE_FLAGS=$(.agents/skills/browse-it/scripts/profile.sh "Rika Labs")   # no argument lists profiles
aside guide repl                                                      # read once per task
aside skills list                                                     # built-in site helpers (Slack, Gmail, ...)
```

## `aside repl` (default)

Playwright-style JavaScript against Aside's tabs. 120-second limit per call. A one-shot
`aside repl "<code>"` closes its session at the end, so verify inside the same call.

```bash
aside repl $PROFILE_FLAGS "const p1 = await openTab('$URL'); const s1 = await snapshot(p1, { interactive: true }); console.log(s1.tree); await p1.screenshot({ path: '$EVIDENCE/home.png' }); await closeTab(p1)"
```

Set `URL` to the actual shared page and `EVIDENCE` to an absolute directory outside the repo first.
Local documentation and framework examples use isolated agent-browser, not Aside.

- Use `openTab` and `closeTab` only; never `page.context().newPage()` or `page.close()`.
- `snapshot(page, { interactive: true })` returns refs such as `e31`; act with `page.locator('e31')`. Every
  new snapshot invalidates old refs. Print `diff` after each action.
- Return values with `console.log`. Use fresh variable names; bindings persist within a session.
- Aside's guide documents no device pixel ratio, video or pixel diff. Use agent-browser for those steps.

## `aside exec` (delegated dashboard work)

Starts Aside's own agent. Give one concrete goal and the exact end state, then verify its claim yourself;
its report is a lead, not evidence.

```bash
aside exec $PROFILE_FLAGS --effort high "In <provider>, open <page> and list <what>, with <fields>. Change nothing."
aside session list
aside session steer <id> "..."
aside session stop <id>
```
