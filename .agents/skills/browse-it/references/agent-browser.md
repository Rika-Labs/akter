# agent-browser

```bash
agent-browser skills get core --full   # version-matched command reference
```

## Sessions

- Local documentation, framework examples and every attack step use your own session:
  `export AGENT_BROWSER_SESSION=<unique-task-name>` (replace the placeholder). Do not pass a shared profile.
  Close only that session.
- This public repo has no seeded browser personas or hosted sign-in stack. Application authentication
  comes from the example or consumer under test; do not invent cookie or login endpoints.
- Shared signed-in browser work uses Aside's `Rika Labs` profile; see [aside.md](aside.md).

## Gotchas

- Pass absolute paths to `screenshot`, `record` and `diff --output`; relative ones land in the repo.
- `diff screenshot --baseline A --output B` compares a saved image with the live page, not two files. On a
  size mismatch it reports a path but writes nothing: check both sizes
  (`sips -g pixelWidth -g pixelHeight`) and that the output exists.
- Run multi-line JavaScript with `cat <<'EOF' | agent-browser eval --stdin`.
- Patching `window.fetch` does not slow requests; apps capture their own fetch. Pause the API process
  instead (`../../prove-it/references/stack.md`).
- A selector must match one visible, nonzero-sized element; responsive layouts hide duplicates.
