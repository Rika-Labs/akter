# Operating

This page covers what you need once Akter is running: metrics and traces, looking inside the store, history and garbage collection, backups, and what to do when something goes wrong.

## Metrics and traces

`Akter.serve({ prometheus: true })` serves Prometheus metrics at `/metrics`. For OpenTelemetry, provide `Telemetry.layer` alongside the server:

```ts
import { Telemetry } from "@rikalabs/akter/server"

const telemetry = Telemetry.layer({
  otlp: { baseUrl: "https://otel.example.com", headers: { authorization: "Bearer ..." } },
})
```

It exports traces and metrics over OTLP. Logs aren't exported over OTLP. Pass `devtools: { url }` to send traces to Effect DevTools while you develop; `akter dev --devtools` does that for you.

Spans are named after what they measure: `akter.<Actor>/<command>` for a command, `akter.job/<Actor>/<job>` for a job, plus spans for admission, commits and deliveries. Metrics cover commands and their duration, batch sizes, log write time, ambiguous writes, shard opens, replays, page misses, active actors, jobs and job time, refused requests and garbage collection. No metric is labeled with an actor id or a payload.

`Telemetry.usage` returns running totals of successful commands and job seconds for the current server, by actor type, for usage reporting.

## Operator access

Operator requests read and repair the store's contents. They use their own endpoint, `POST /operator`, and their own credentials, which are never the same as your users'. Turn the endpoint on with `operatorAuth`:

```ts
import { Redacted } from "effect"
import { OperatorAuth } from "@rikalabs/akter/server"

const operatorAuth = OperatorAuth.tokens([
  {
    token: Redacted.make(process.env.OPERATOR_TOKEN ?? ""),
    grant: {
      operator: "on-call",
      capabilities: [
        { action: "inspect", tenant: "default" },
        { action: "log.read", tenant: "default" },
      ],
    },
  },
])
```

Each grant lists exactly what an operator may do:

| Capability      | Allows                                                        |
| --------------- | ------------------------------------------------------------- |
| `inspect`       | An actor's state, lists and pending work, or a shard's status |
| `outcomes.read` | The stored replies and errors of commands                     |
| `log.read`      | Reading the command log                                       |
| `snapshot.read` | Reading checkpoints and pages                                 |
| `replay`        | Replaying a shard that refused to open                        |
| `retention.set` | Changing how long history is kept                             |
| `fork`          | Copying an actor's history into a new actor                   |

Every operator request writes an audit record to the store: who, what, why and the outcome, without credentials or payloads. A refused request is audited too.

## Looking inside

The `akter` CLI sends operator requests to a running server. It reads the token from `AKTER_OPERATOR_TOKEN`:

```sh
akter inspect actor Room lobby --url https://ops.example.com --reason "ticket 1234"
akter inspect shard 3
akter log tail 3 --follow
akter snapshot 3
```

`inspect actor` shows what's stored for one actor: its state, its lists and its pending timers, sends and jobs. `log tail` prints the commands recorded in one shard. The [CLI reference](../reference/cli.md#operator-commands) lists every command and flag.

## History

The log keeps every command for at least seven days. Past that, Akter trims the log back to a checkpoint and garbage-collects the list pages nothing refers to anymore. Change how long history is kept with an operator who holds `retention.set`:

```sh
akter retention "30 days" --url https://ops.example.com --reason "longer audit window"
```

Retention can be 1 to 365 days. Widening it keeps history that hasn't been trimmed yet; it can't bring back what's already gone. Don't use your bucket's lifecycle rules to expire Akter's objects. Garbage collection decides what's safe to delete.

## Forks

A fork copies one actor as it was at a point in its history into a new actor, so you can look at the past, or branch from it, without touching the original:

```sh
akter fork Room lobby --before 2026-10-12T18:00:00Z --to lobby-before-incident --directory .akter/store
```

Forks need the `fork` capability and work on the store directly, not through a server. The [CLI reference](../reference/cli.md#akter-fork) covers the options.

## Backups

A backup has to be the whole store. Copying actor state alone loses pending timers, sends and jobs, and the record of which commands already ran.

1. Drain or stop every server that writes to the store.
2. Copy the whole bucket or prefix.
3. Keep the release that wrote it, in case its log needs replaying.

Restore into an empty bucket, and make sure the old store's servers can't write anymore before you start servers on the restored one. Two copies of a store that both run will both perform the same pending work.

## When something goes wrong

The rule behind all of these is the same: the log in the bucket decides what happened. Never patch around it by deleting objects or writing default state.

**The bucket is unreachable.** Callers get a retryable `ActorUnavailable`, and clients keep retrying with the same command ids. Restore access, and each shard recovers from its log.

**A shard won't open after a deploy.** It has commands that weren't checkpointed, written by a different build. Run the release that wrote them so it can recover the shard, then deploy again. As a last resort, an operator with `replay` can replay with the current build (`akter replay <shard> --current`). If the new code decides differently, the shard stops with `ReplayMismatch` instead of continuing on wrong state.

**A drain timed out.** Nothing acknowledged is lost, but the next owner replays more of the log. Raise the `deadline` passed to `RuntimeControl.waitForSignal`, and your platform's shutdown grace period with it.

**A job failed.** Its `onFailure` command received the cause and whether the last step may have reached the provider. Check with the provider before retrying by hand, and never replay completed steps to repair state.

**A sent command failed.** The failure is recorded on the receiving actor. The sender isn't told, and there's no dead-letter queue, so put anything the sender needs to react to in a reply path of your own.
