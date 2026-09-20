# CLI design

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

The CLI is a client of the same authorized actor protocol. It must not import repositories or connect directly to actor databases by default.

## Commands

```
durable-actors inspect <type> <id>
durable-actors submit <type> <id> <command> --json input.json
durable-actors submission <id>
durable-actors events <type> <id> --after <cursor>
durable-actors doctor
```

Domain applications can build friendlier commands such as `todos complete 123`. Effect CLI is the preferred parser/completion/help system; the actual CLI package/API is verified against the pinned v4 version during implementation.

## Output contracts

Human mode prints a concise summary and recovery guidance. `--json` prints one documented schema to stdout; logs go to stderr. Exit codes distinguish application rejection, authentication, unavailable service and local argument errors. Streaming can use NDJSON with event IDs for resumable automation.

## Safety

Destructive commands require an explicit target environment and confirmation policy. Defaulting to production because a config lookup failed is forbidden. Read-only inspect commands are separate from administrative replay/delete commands. A `replay` action must not blindly rerun external side effects; it operates only on a documented failed delivery/receipt state.

## Packaging

Keep the protocol client portable. A Bun-compiled executable is an optional distribution artifact, not the only CLI. Provide an ordinary ESM entry with a supported runtime requirement. Test packaged exports and signal handling on Node and Bun. Do not make users install a running local cluster merely to inspect a remote actor.

## This skeleton

There is no functioning CLI yet. The workspace boundary and commands are documented; the CLI source contains no fake operational responses. Its first implementation milestone is `doctor` plus one typed command and receipt retrieval against the reference runtime.

## Sources and evidence

- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
- [B06: Bun bundler](https://bun.com/docs/bundler) — Build targets and executable compilation; does not replace declaration generation/type checking.
- [B01: Bun Node compatibility](https://bun.com/docs/runtime/nodejs-compat) — Bun tracks Node compatibility; compatibility is not completeness and requires our own production path tests.
