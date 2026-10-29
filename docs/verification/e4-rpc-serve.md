# E4 RPC, sessions and serving evidence

**Responsibility:** bind the 0.2 wire (one RPC group at `/rpc`), sessions, live reads, the Effect client and `Akter.serve` to executed scenarios.  
**Authority:** verification evidence.  
**Owner role:** protocol and SDK.  
**Change policy:** a change to the wire, the client's retry or resubscription, session binding or a refusal mapping needs a scenario here that names the wrong implementation it rejects, green on Bun and Node over both transports.

The code is `packages/akter/src/rpc/group.ts` (the group derived from the actor contracts), `src/serve/` (`Akter.serve`, the HTTP gate, sessions and the `Authorization` middleware, the handlers) and `src/client/transport.ts` (`AkterClient.layer`, exported from `@rikalabs/akter/client`). The normative targets are the [protocol](../contracts/protocol.md), [realtime](../contracts/07-realtime.md), [security](../contracts/10-security.md) and [error model](../contracts/error-model.md) contracts and [ADR 0130](../decisions/0130-views-sessions-events-and-rpc.md). Everything here is one runner process over `Store.memory()`, except the self-host recipe, which runs on MinIO and on a directory; none of it is a provider result.

## Commands

From the repository root:

```sh
bun --bun node_modules/vitest/vitest.mjs run tooling/conformance/src/conformance/client.test.ts
node node_modules/vitest/vitest.mjs run tooling/conformance/src/conformance/client.test.ts
bun --bun node_modules/vitest/vitest.mjs run packages/akter/src/serve .github/src/pack.test.ts
bun run check:pack
SMOKE_RUNTIME=node bun run pack:smoke
SELFHOST_RUNTIME=bun bash apps/self-host/verify.sh
SELFHOST_RUNTIME=node bash apps/self-host/verify.sh
```

`bun run test:node:units` includes the client suite, so CI runs it on Node as well as through `tooling/conformance`'s `test` on Bun.

On 2026-10-12, with Bun 1.4.2 and Node 26.7.0 on macOS arm64, the client suite passed 25 of 25 tests on each runtime (11 scenarios over WebSocket, the same 11 over HTTP, one renewal scenario and two refusal scenarios). The serve unit tests and the pack tests passed. `check:pack` and `pack:smoke` on Node installed the packed tarball into a clean project, served a counter with `Akter.serve` and called it through `AkterClient` over HTTP and WebSocket. Both self-host images (Bun 1.4.2, Node 24.18.0; Linux arm64 containers on Docker 29.8.2) passed `verify.sh`.

## Wrong implementations rejected

A row with a wrong implementation names a mutation that was applied to the code, and the last column says how the scenario failed under it; every scenario passes on the unmutated code. A row marked _(assertions)_ lists what the scenario checks, without a mutation run.

| Scenario                                                                                    | Wrong implementation                                                                                     | Observed under the mutation                                               |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The wire marks a same-id retry `replayed`, runs it once, and refuses a reused id            | `replayed` always `false`, or looked up separately from admission                                        | fails on both transports                                                  |
| A call whose reply was lost is retried with the same command id and runs once               | the client mints a fresh command id per attempt                                                          | fails on both transports                                                  |
| Calls reply as the caller, and a declared failure arrives as itself                         | _(assertions)_ `whoami` from the session's caller; `Over` decoded to its class, not an `ActorError`      | n/a; asserts the caller per client and the declared class                 |
| Calls run as the authenticated caller, whatever headers a frame carries                     | a frame's repeated `x-akter-session` replaces the transport's                                            | fails on both transports                                                  |
| A revoked caller's session ends with `access_denied` and its streams stop                   | streams are not ended when their session ends                                                            | the stream never ends; times out on both transports                       |
| A session whose checks never succeed ends at its bound, and the client resumes on a new one | the client resubscribes on the lapsed WebSocket session instead of reconnecting                          | WebSocket times out; HTTP, where every request is its own session, passes |
| `$reauthenticate` moves a session to a fresh credential and refuses another caller          | the server ignores `$reauthenticate`                                                                     | fails                                                                     |
| Streams resume after the connection drops, from a full value, without repeating one         | the client delivers a resubscription's full frame even when it equals the last value                     | fails on both transports                                                  |
| Refusals before the RPC handler reach an HTTP client as the envelope's `ActorError`         | a `401`/`403`/`429`/`503` envelope surfaces as a transport failure                                       | fails                                                                     |
| State and views stream a full value first, then patches in log order                        | _(assertions)_ first frame `Frame`, then `Patch`; versions strictly increase; values monotonic           | n/a                                                                       |
| Join runs `connect` as the session's caller, and leaving runs `disconnect`                  | _(assertions)_ presence holds the caller's entry while joined and none after                             | n/a                                                                       |
| A dropped connection runs `disconnect` for the join it carried                              | _(assertions)_ the dropped connection's entry leaves `online`                                            | n/a                                                                       |
| Broadcasts reach a subscriber after the command; lists read and watch their items           | _(assertions)_ broadcasts `[4, 6]`; the watch starts at `[]` and ends at `[4, 6]`; `find` sees the actor | n/a                                                                       |
| Refusals answer `401` without credentials and `403` for a foreign origin                    | _(assertions)_ on `POST` and on the upgrade; `/ready` answers `200 { ready: true }`                      | n/a                                                                       |

A mutation that made calls run as a different session's caller was also tried, but it failed by throwing rather than by the wrong caller, so it is not listed as evidence.

[`pack.test.ts`](../../.github/src/pack.test.ts) bundles a consumer of `@rikalabs/akter/client` for Bun and Node and finds no module from `serve/`, `store/`, `snapshots/`, `testing/` or `runtime/`, no `server.ts`, no `@effect/platform-*` and no AWS/Smithy module; the only `execution/` modules are `command-ids.ts` and `digest.ts`.

## Self-host recipe

`apps/self-host/verify.sh` builds the Bun or Node image, starts MinIO and one runner with `Store.s3`, and checks over `/rpc`: a first `add` answers `replayed: false`, its retry with the same id answers `replayed: true`, a wrong and a missing bearer answer `invalid_credentials` and `missing_credentials`, and after a runner restart the stored outcome still replays and the next `add` sees the earlier state. It then runs the same image with `Store.fileSystem` and checks that state and outcomes survive a container restart. See [self-host operations](../operations/self-host.md).

## Engine seams

E4 added one seam to the engine: `Engine.admitted(command)` returns `{ outcome, replayed }`, where `replayed` is true when admission returned a stored outcome or joined a run that was pending before it; `Transports.admitted` carries it to the handler. `execute` is unchanged in behavior and maps over it.

## Open

- **Owner moves.** [E3 cluster evidence](e3-cluster.md) adds real public HTTP/WebSocket clients through a non-owner, state resubscription after drain and a lower-version full baseline from the new owner. This does not establish slow-consumer or owner-crash presence behavior.
- **Slow consumers.** State, list and view streams keep the newest values in a sliding buffer of 64 and diff from the last value sent; broadcast streams end with `SessionEnded { cause: "SlowConsumer", resync: true }` when their dropping buffer of 64 fills. No scenario forces a consumer to lag yet.
- **Owner crash and presence.** Exactly one `disconnect` per durable `connect` after the owner crashes is the next owner's recovery and has no E4 scenario.
- **Hosted ingress end to end.** Assertion verification has unit tests (`serve/assertion/`); the gate's binding check on `/rpc` and the key refresh push are not exercised end to end until the edge (C2).
- **Admission saturation** (`503` for `admission.requests`) and trace span names have no scenario.
- **Tenants.** `Akter.serve` refuses any tenant other than `default` with `access_denied`, because actor ids are not tenant-scoped yet.
- **WebSocket after a lapse.** The server keeps refusing calls on a lapsed session and does not close its socket; the client closes it and reconnects.
