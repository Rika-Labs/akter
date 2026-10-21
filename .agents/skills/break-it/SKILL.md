---
name: break-it
description: A fresh-context verifier attacks the exact SHA and returns PASS, FAIL or INCONCLUSIVE with evidence. Use before anything ships, for "break it", "verify this" or "red team it", and when you are that verifier.
---

# Break it

Done: a verdict on the exact SHA, with every attack category tried or marked n/a.

If you wrote the change, send a fresh agent [references/brief.md](references/brief.md), on the most careful
model for auth, data model, migrations or money. If you are the verifier, continue.

1. **Setup.** A clean worktree at the SHA and your own stack (`../prove-it/references/stack.md`). Every
   browser attack runs in an isolated agent-browser session (`browse-it`).
2. **Tests bite.** Run the change's tests. In your disposable worktree only, temporarily restore the
   covered source from the parent (example: `git show <sha>^:<path> > <path>`), confirm the tests fail,
   then restore the exact SHA. Never overwrite someone else's edits or weaken existing tests.
3. **Claim.** Reproduce it as a user.
4. **Attack.** Record each command and what you saw:
   - **Input:** empty, whitespace, 10k characters, 1 MB, emoji, RTL, combining marks, zero-width, NUL,
     `<script>`, `'; --`, negative, zero, max-int.
   - **Repeats:** double-click, Enter twice, the same request twice, 20 at once (`xargs -P20 curl`), back and
     forward after submit.
   - **Interrupts:** reload mid-flow, close and reopen, one session in two tabs.
   - **Session:** for authenticated consumers, missing, tampered or expired credentials; disconnect or
     revoke access mid-action. Public docs have no seeded sign-in flow.
   - **Permissions:** each caller/tenant scope the contract defines; another actor's ids; what a consumer
     UI hides but the framework still serves. Do not invent personas or private hosted routes.
   - **Network:** offline mid-action then back; abort each endpoint; read a blocked payload with
     `agent-browser --json network request <id>`. Slow link: pause the API (stack reference), since
     patching `window.fetch` does nothing.
   - **Time zones** (dates or times only): `TZ=Pacific/Kiritimati` and `TZ=Pacific/Pago_Pago`, midnight,
     daylight-saving edges.
   - **Dependencies:** bucket failures, owner loss, ambiguous append, interruption and restart through
     seeded Simulation and real protocol suites as the claim requires. External job I/O: down, slow or
     ambiguous outcome, one at a time. Assert durable state and obligations; local evidence is not provider proof.
   - **Surface:** 390×844 at ratio 2, keyboard only, dark; console and page errors after each try.
5. **Side effects** from their source, not the response.

## Verdict

- **PASS:** the claim holds and every category was tried or marked n/a with a one-line reason.
- **FAIL:** anything broke; give the smallest reproduction.
- **INCONCLUSIVE:** wrong SHA or surface, a surface you couldn't run, or an unchecked claim. Never a pass.

Each fix is a new SHA and a fresh verifier. After three rounds without PASS, stop patching and go to
`root-it`, then `rethink-it`.

**Reply:** verdict on the first line, then SHA, round, evidence, what you tried, what you could not check.
