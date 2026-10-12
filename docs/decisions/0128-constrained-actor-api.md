# ADR 0128: The constrained API: state, actions, and what appears only when used

Status: proposed, 2026-10-12 (rewrite/0.2).

**Responsibility:** fix the 0.2.0 public interface: how an actor is declared, implemented, called, served and tested, the package entries, the caller shape and the public error set.

**Owner role:** API and SDK.

## Context

The 0.1 definition has fifteen sections (`key`, `placement`, `state`, `tables`, `blobs`, `events`, `feeds`, `api`, `internal`, `createdBy`, `schedules`, `jobs`, `subscriptions`, `policy`, `access`), six member constructors for reads and writes, three layer builders, five package entries and three client styles (Effect handles, a Promise client and generated clients) ([ADR 0010](0010-one-way-effect-native-api.md), [ADR 0063](0063-framework-simplification.md)). The engine plan's first 0.2 draft still had five member kinds, an `initial` value, `collections`, `index`, `connection`, two layer builders and two client handles.

Dallen's decisions fix the result: one Effect client (D9), one RPC group over WebSocket and HTTP at `/rpc` (D14), six merges (D15: `connect` into `client` + `join`; `toJobLayer` into `toLayer`; `X.self` into `X.client`; fork on the CLI only; `schedules` into `cron`; state capped at 256 KiB), no roles on `Caller` (D16), and the D23 interface: an actor contract is `state` plus `actions`, and everything else appears only when used.

## Decision

### 1. The interface

```ts
// contract (shared with clients)
export const Room = Actor.make("Room", {
  key: RoomId, // optional; default Schema.String
  state: Schema.Struct({
    title: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
    admins: Schema.Array(UserId).pipe(Schema.withDecodingDefault(() => [])),
    online: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withDecodingDefault(() => ({})),
    ),
    messages: Actor.list(Message, { key: "id", by: "at" }),
  }),
  actions: {
    post: Actor.action(Schema.String),
    rename: Actor.action(Schema.String, { fails: Forbidden }),
    count: Actor.action({ success: Schema.Number }),
    prune: Actor.action({ cron: "0 3 * * *" }),
  },
  views: { summary: Actor.view(Summary) }, // optional
  events: { typing: Actor.event(Schema.String) }, // optional, not stored
  jobs: {
    notify: Actor.job({
      payload: Email,
      retry: { attempts: 5, backoff: "2 seconds" },
      timeout: "1 minute",
      concurrency: 10,
      onFailure: "notifyFailed",
    }),
  }, // optional
  presence: Schema.Struct({ name: Schema.String }), // optional; enables connect/disconnect and client.join
  access: (caller) => caller._tag === "User", // optional; default allows User and System
})

// implementation (server only)
export const RoomLive = Room.toLayer({
  post: (room, body, { caller, id, now }) => {
    room.messages.put(new Message({ id: id(), author: caller.subject, body, at: now() }))
  },
  rename: (room, title, { caller }) => {
    if (!room.admins.includes(caller.subject)) return new Forbidden()
    room.title = title
  },
  count: (room) => Object.keys(room.online).length,
  prune: (room, _, { now }) => {
    room.messages.deleteBefore(now() - 30 * 86_400_000)
  },
  summary: (room) => new Summary({ title: room.title, online: Object.keys(room.online).length }),
  connect: (room, { name }, { connection }) => {
    room.online[connection] = name
  },
  disconnect: (room, _, { connection }) => {
    delete room.online[connection]
  },
  notify: (email, { self, step }) =>
    step("send", Mailer.send(email)).pipe(Effect.andThen(self.post("sent"))),
})
```

### 2. Rules

1. **State** is a `Schema.Struct`. Every field has a decoding default or is an `Actor.list`; the initial state is the decode of `{}`; `Actor.make` is a type error if the encoded side is not fully optional. Adding a field is free; reshaping a field is a `Schema` transformation on that field. There is no `initial` and no `migrate` member. State without lists is capped at 256 KiB.
2. **Lists** (`Actor.list(Item, { key?, by })`) are fields of state whose items live in content-addressed pages; they are unbounded. In actions: `put`, `get`, `delete`, `range({ from?, to?, limit?, reverse? })`, `deleteBefore(by)`. Clients read them as `handle.<list>.range(...)` and watch them ([ADR 0127](0127-snapshots-pages-lists-history-gc.md)).
3. **No `index` member.** `X.find({ where, orderBy, limit })` works over top-level scalar state fields (string, number, boolean, literal, branded scalars, `DateTime`); strings are truncated to 64 bytes in the index; the index is held by the shard owner, persisted as pages at checkpoint, and queried by scatter-gather over the store's shards ([ADR 0131](0131-find-over-owner-held-index.md)).
4. **Actions are synchronous plain functions, not Effects**: `(draft, payload, ctx) => void | Fails | Success`. The draft is copy-on-write; returning an instance of the declared `fails` error discards the draft and every staged effect; returning a value is the reply (`success` schema). `ctx` holds `caller` (narrowed by `access`), `id()`, `now()`, `random()` (recorded for replay), `self` (the actor's id), `send(Target, id).<action>(payload)`, `schedule(durationOrDate).<action>(payload)`, `start.<job>(payload, { key? })`, `emit.<event>(value)` and `connection` (in presence handlers). The lint `akter/synchronous-actions` bans `Date`, `Math.random`, `crypto`, `performance`, `process`, `globalThis`, `Promise` and `await` in action and view handlers ([ADR 0125](0125-synchronous-deterministic-actions.md)).
5. **`cron`** is an action option, not a member ([ADR 0129](0129-jobs-timers-and-shard-workflow-engine.md)).
6. **Views are optional.** Any caller that passes `access` can read and watch `state` and its lists; a view exists for a derived shape or to hide fields. View handlers are synchronous `(state, params, ctx) => value`.
7. **Jobs** are the only place for I/O: `(payload, { self, step, emit, id, attempt }) => Effect`. `step(name, effect)` records the result so a finished step never repeats; every call from a job carries a command id derived from the job id and the call ordinal. Job requirements flow into the layer type. `onFailure` names an action that receives `Actor.JobFailure`.
8. **Payloads, list items, events, views, job payloads and step results are Schema.** `Actor.action(payload?, options?)`, `Actor.view(success, { params? })`, `Actor.event(schema)`, `Actor.job(options)` and `Actor.list(item, options)` are the only constructors. One argument order everywhere: schema first, options second.
9. **Client.** `X.client(id)` (scoped) exposes each action as an Effect, `state` as a `Stream` (a full frame, then patches), each list's `range` and watch, each view, each event as a `Stream`, and `join(presence)`. `X.find(...)` is static. Effect only (D9), one RPC group over WebSocket and HTTP at `/rpc` (D14) ([ADR 0130](0130-views-sessions-events-and-rpc.md)).
10. **Server.** `X.toLayer({...})` is the one layer per actor (actions, views, jobs, `connect` and `disconnect` in one object). `Akter.serve({ auth })` plus `Store.s3({ bucket })`, `Store.fileSystem(dir)` or `Store.memory()`; one `Store` service is the log, the pages, the index and the runner leases ([ADR 0136](0136-stores-the-bucket-is-the-store.md)).

### 3. Settled details

- **`access`** is `(caller, request) => boolean`, where the optional second argument is `{ kind, member, id }` and `kind` is one of `action`, `state`, `list`, `view`, `event`, `join`, `find` or `reauthorize`. When the function is a type guard it narrows `ctx.caller` in every handler. The default allows `User` and `System` callers and refuses `Anonymous` with `Unauthorized` code `access_denied`. This replaces 0.1's default, which also refused `User`.
- **`auth` runs first.** `Akter.serve({ auth })` decides who the caller is and which tenant, and makes global refusals such as revoked credentials; it runs before `access` on every request. ADR 0059's global `authorize` hook is removed.
- **System-only actions.** An action named by a job's `onFailure` or carrying a `cron` option accepts only `System` callers; any other caller is refused with `Unauthorized` code `access_denied` before the action runs. Other actions a job calls stay callable by clients unless `access` refuses them.
- **`fails`** is one `Schema.TaggedError` class or a union of them; a declared failure reaches the client as itself, never wrapped.
- **Caller (D16):** `User { subject } | Anonymous | System { source, ref?, onBehalfOf? }`, tagged on `_tag`. There are no roles; role checks run inside actions against the actor's own state and fail with a declared error.
- **Testing:** `Simulation.layer({ actors, seed, faults })`, `Simulation.seed`, `Simulation.settle`, `Simulation.state` from `@rikalabs/akter/testing`.
- **Fork** is `akter fork` on the CLI and an operator call ([ADR 0132](0132-forks-and-retained-history.md)); there is no client fork.

### 4. Package entries

| Entry                     | Contents                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@rikalabs/akter`         | `Actor`, contracts, `Caller`, errors, the Effect client; imports no store, cluster or SQL module (a structure test enforces this) |
| `@rikalabs/akter/server`  | `Akter.serve`, `Store.*` including S3, `App.make` for hosts                                                                       |
| `@rikalabs/akter/testing` | `Simulation`                                                                                                                      |

`@rikalabs/akter/client` (the Promise client), `@rikalabs/akter/runtime` and `@rikalabs/akter/cold-storage/s3` are removed. The React and Python client packages leave the 0.2.0 tree; each returns only through its own ADR (D8).

### 5. Public errors

The framework's one error is `ActorError` with `reason` one of `Unauthorized`, `InvalidInput`, `CommandExpired`, `InvalidCommandId`, `ActorUnavailable`, `ShardMoved`, `Timeout`, `MailboxFull`, `RunnerAtCapacity`, `QuotaExceeded`, `SessionEnded` and `TransportError`. `CommandConflict` and `NotCreated` are removed. The [error model](../contracts/error-model.md) defines each reason, its retry metadata and its wire form.

## Supersedes and amends

- Supersedes [ADR 0010](0010-one-way-effect-native-api.md) — scope: in full; its "one way to do everything" principle is restated here.
- Supersedes [ADR 0063](0063-framework-simplification.md) — scope: items 1–6.
- Supersedes [ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md) — scope: §2 internal commands.
- Supersedes [ADR 0025](0025-turn-mint.md) — scope: public `turn.mint`, `X.create` and `createdBy`.
- Supersedes [ADR 0026](0026-cross-actor-event-subscriptions.md) — scope: in full; a source action sends to its subscribers.
- Supersedes [ADR 0047](0047-subscriptions-example.md) — scope: in full.
- Amends [ADR 0014](0014-adoption-observation-and-client-reach.md): client reach is the Effect client only.
- Amends [ADR 0029](0029-licence-package-name-and-release-policy.md) and [ADR 0103](0103-cli-distribution.md): package entries and removed client surfaces.
- Amends [ADR 0032](0032-event-and-effect-payload-evolution.md): state evolves through decoding defaults and field transformations; stored event and effect payload versions end.
- Amends [ADR 0059](0059-caller-and-tenant-defaults.md): transport-decided caller and tenant carry; the global `authorize` hook is removed and the default `access` changes as above.
- Amends [ADR 0098](0098-proprietary-cloud-repository.md): deferred client packages leave the public 0.2.0 tree; the repository split stands.

## Alternatives

- **The engine plan's five member kinds** (action, view, event, job, collection) with `initial`, `index`, `connection` and `cron` members. Rejected by D23: more sections than examples need.
- **Effect-typed action handlers.** Rejected ([ADR 0125](0125-synchronous-deterministic-actions.md)).
- **Views as the only read path.** Rejected by D23 rule 6: state and lists are readable by default; views are for derived shapes and hiding fields.
- **A Promise facade or a derived HTTP API.** Rejected by D9 and D14 until the Python client returns.
- **Roles on `Caller`.** Rejected by D16.
- **Keep the global `authorize` hook.** Rejected: `auth` already runs on every request before `access`, which keeps global refusals unbypassable with one fewer hook.

## Consequences

- Every 0.1 example, guide and API page is rewritten in the milestone that ships its replacement (E1 contracts and handlers, E4 client and serve, E5 jobs, E6 lists, E7 `find`).
- Applications that relied on 0.1's default denial of `User` callers must declare `access`.
- Clients that need a non-Effect language wait for the Python client's ADR.

## Evidence

| Milestone | Evidence                                                                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1        | Type tests: `Actor.make` rejects a state whose encoded side is not fully optional; handler keys must match declared members; job requirements flow into the layer type and action handlers require nothing; `access` narrows `ctx.caller` |
| E1        | The four plan examples (chat room, agent, work queue, account) compile and run under `Simulation`                                                                                                                                         |
| E4        | Client conformance on both runtimes: actions, state and list streams, views, events, `join`; the root entry bundles no store, cluster or SQL module                                                                                       |

## Revisit when

- An example the product needs cannot be written with these members.
- The Python or React client returns (each needs its own ADR).
- Evidence shows the 256 KiB state cap blocks a common shape that lists do not serve.
