# Using each surface like its caller

Use only surfaces the public repository actually contains. Setup and isolation:
[stack.md](../../prove-it/references/stack.md).

| Surface             | Use it with                                                                                                                                                                       | Look at                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation UI    | `browse-it`: changed controls, search, navigation, back/forward and reload; 1440×900 and 390×844, light/dark                                                                      | Screenshots, clipping, alignment (`align-it`), overflow, loading flashes (`ssr-it`), console/page errors; static export when relevant  |
| Framework RPC       | Public Effect client via `AkterClient.layer` against your own server's `/rpc`; HTTP NDJSON and JSON WebSocket when relevant                                                       | Typed outcomes, state streams, events and durable state; bad input, denied access and reconnect/retry behavior defined by the contract |
| CLI                 | `bun apps/cli/src/main.ts --help`, then the changed command with its documented flags and disposable target                                                                       | stdout, stderr, exit code, written files and resulting server/store state; bad flags and denied access where applicable                |
| Public packages     | Throwaway consumer importing the public entries of `packages/akter` or `packages/cloud-api`; root packaging commands `bun run pack:check` and `bun run pack:smoke` where relevant | Export boundaries, types, typed errors and runtime outcomes on the supported runtime; no private source imports                        |
| Actions and jobs    | Public API through seeded `Simulation`, then a real server/store when the claim needs it                                                                                          | Discarded drafts and staged effects, retry identity, durable step results, restart/replay state and pending obligations                |
| Store and self-host | Relevant bucket protocol suite, CLI `storage check`, or the isolated `apps/self-host` recipe                                                                                      | Create-once/CAS/listing behavior, fencing, failure/recovery and actual stored state; name the tested backend and evidence limits       |

- This repo has no desktop app, hosted console, seeded browser identities or private agent-tool stack.
  A change to a consumer needs that consumer's own setup; do not fabricate it here.
- Delete throwaway consumers and scripts when done; keep evidence outside the repo and secrets out of it.
- If a required surface cannot be reached, say which and why; never mark it passed.
