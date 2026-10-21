---
name: browse-it
description: Drives the browser through the Aside CLI when installed, otherwise agent-browser. Use for any browser step, "test it in the browser", or a provider dashboard with no CLI.
---

# Browse it

Done: the step happened in the right profile, a fresh snapshot or read-back confirms it, and the evidence
is saved.

1. **Driver.** Local work and attacks: read [references/agent-browser.md](references/agent-browser.md).
   Shared browser work: `export PATH="$HOME/.local/bin:$PATH"; command -v aside`. Found: read
   [references/aside.md](references/aside.md). Not found: read
   [references/agent-browser.md](references/agent-browser.md). Say which you used.
2. **Profile.** Shared browser work uses Aside's `Rika Labs` profile, as [AGENTS.md](../../../AGENTS.md)
   requires. Missing: list profiles and ask the user to select or sign in. Local work and attacks use an
   isolated agent-browser session with no shared profile; do not invent a seeded login for this repo.
3. **Operations.** Other skills name steps (screenshot at a size, run JS, pixel diff);
   [references/operations.md](references/operations.md) maps each to both drivers.

## Rules

- Cookie clearing or tampering, offline, request blocking and sign-out run only in an isolated agent-browser
  session with no profile.
- Open and close only your own tabs and sessions. Never `close --all`.
- Never put a secret in argv, a file, a log or a shared screenshot. Pipe revealed keys straight to their
  destination.
- Dashboards: the provider's CLI, MCP or API first; the browser only for what they lack. Read the current
  state, make the change, then read it back from a source other than the page.
- Snapshot after every action; an action is unconfirmed until a fresh snapshot shows it. Console and page
  errors must be empty.
- View every image before you cite it.

**Reply:** the driver and profile used, what you did, and the evidence paths.
