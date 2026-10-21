# Your own Akter test surface

Never use production. This public repo contains the framework, CLI, documentation and self-host example,
not the hosted control plane, console or a seeded multi-user application. Hosted stacks belong in the
private Akter Cloud repository; do not invent local auth, seed, API or health routes.

## Start only what the claim needs

- Fresh worktree: `bun install --frozen-lockfile` first. Read the owning package's manifest and
  [testing guide](../../../../docs/guides/testing.md) before choosing a command.
- Documentation UI: choose a free port for this worktree, set `PORT` to it, then run
  `bun --cwd apps/docs dev --port "$PORT"`. Record the actual origin printed by Next and verify the
  changed page responds. Use your own isolated agent-browser session; no sign-in is needed.
- Export-specific claims: `bun --cwd apps/docs run build` produces `apps/docs/out` (generated output).
  Serve that directory with a local static file server on another free port; dev-server behavior alone
  does not prove the static export. See `apps/docs/next.config.ts` and `apps/docs/scripts/finish-export.ts`.
- Framework behavior: use the public Effect client and seeded `Simulation` in
  [testing](../../../../docs/guides/testing.md). To run a real local server, follow the
  [quickstart](../../../../docs/quickstart.md), with a fresh filesystem store and an unused port; check
  `GET /ready` and call the one RPC group at `/rpc` through `AkterClient.layer`.
- Bucket/self-host behavior: follow [self-host operations](../../../../docs/operations/self-host.md)
  and the runnable files in `apps/self-host`. Isolate ports, credentials and storage before starting;
  the recipe's default port may already be occupied. Never attach a test to another checkout's store.
  Filesystem, simulator and MinIO results are not provider certification.
- Checks: pick commands from the root and owning package manifests, such as `bun run lint:structure`,
  `bun --cwd apps/docs run test`, or the relevant focused Vitest run. `bun run check` is the full root
  check, not a quick check. Apply the machine's workload gate when required by its instructions.

## Before surface

Create a separate worktree at the base SHA, install its dependencies, and use separate free ports and
fresh stores. Run the same capture script on both actual origins. For a command or simulator-only change,
compare its output and durable state instead of starting an unrelated browser stack.

## Hold a transient state

Use browser request blocking in an isolated session when it reaches the boundary being tested. For
runtime failures use the simulator's supported faults or the bucket failure harness, not patched globals.
If pausing a local server is necessary, identify its process, print its working directory and confirm it
is inside your own worktree before sending `STOP`; always resume it with `CONT`. Never signal by port
lookup alone, by process name or with `pkill`. Never make tests signal the real process table.

## Clean up

Print and verify process working directories before stopping only processes inside your own worktrees.
Stop only the Compose project you created, preserving data unless it is explicitly disposable. Remove
only worktrees you created, delete temporary credentials and large logs from the evidence directory,
and close only your own browser tabs or isolated session. Keep secrets and auth state out of evidence.
