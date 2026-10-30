# Commands

A command is a request to change one actor. Its handler is a synchronous function: it gets a draft of the actor's state and the payload, changes the draft, and returns a reply. Akter stores the change, then sends the reply.

## Declare commands

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()(
  "InsufficientFunds",
  { balance: Schema.Number, requested: Schema.Number },
) {}

export const Account = Actor.make("Account", {
  state: Schema.Struct({
    balance: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  commands: {
    deposit: Actor.command(Schema.Number, { success: Schema.Number }),
    withdraw: Actor.command(Schema.Number, { success: Schema.Number, fails: InsufficientFunds }),
    freeze: Actor.command(),
  },
})
```

`Actor.command(payload, options)` takes the payload's schema first. A command without a payload takes only the options, or nothing, like `freeze` here. The options are:

| Option     | Meaning                                                                             |
| ---------- | ----------------------------------------------------------------------------------- |
| `success`  | The reply's schema. Without it, the command replies with nothing.                   |
| `fails`    | A tagged error the command can return.                                              |
| `internal` | `true` hides the command from clients. See [Internal commands](#internal-commands). |
| `cron`     | Runs the command on a schedule. See [Cron](#cron).                                  |

## Reply or fail

```ts
export const AccountLive = Account.toLayer({
  deposit: (account, amount) => {
    account.balance += amount
    return account.balance
  },
  withdraw: (account, amount) => {
    account.balance -= amount
    if (account.balance < 0)
      return InsufficientFunds.make({ balance: account.balance + amount, requested: amount })
    return account.balance
  },
  freeze: () => {},
})
```

Return a value to reply. Return the declared error to fail: the caller receives `InsufficientFunds` in the Effect's error channel, typed.

When a command fails, its draft is thrown away. In `withdraw`, the balance goes down before the check, and that's fine: if the command returns the error, the subtraction never happened. The same goes for anything else the command asked for. A message, timer or job staged before the failure is dropped with it.

A handler that throws is a defect. Akter throws away the draft in the same way, records the defect, and the caller gets a `CommandDefect` error.

## Stored before the reply

Akter writes each command's result to the bucket before it sends the reply. Once a caller has seen a reply, the change survives a crash. Akter writes the results of many commands, across many actors, in one write, so a busy server doesn't do one bucket write per command.

## Retries don't run twice

Every call carries a command id. When a call times out or the connection drops, the client retries it with the same id, for up to ten minutes. Akter remembers the outcome of every id for ten minutes, so if the first attempt did run, the retry gets the stored reply and the command doesn't run again.

## Stay deterministic

Akter sometimes runs a command more than once. After a crash, it rebuilds actors by replaying recorded commands. When a command reads a [list](lists.md) page that isn't in memory, Akter loads the page and runs the command again from the start. Each run must reach the same decision, so a command can't read the clock, roll dice or touch the network.

Use the context's recorded values instead:

| Instead of                   | Use              |
| ---------------------------- | ---------------- |
| `Date.now()`                 | `ctx.now()`      |
| `Math.random()`              | `ctx.random()`   |
| `crypto.randomUUID()`        | `ctx.id()`       |
| `fetch`, a database, any I/O | a [job](jobs.md) |

`now()` is the time the command was admitted, the same on every run. `id()` and `random()` return the same sequence on every run.

A handler that returns a Promise or an Effect is a defect, so an `async` handler fails on its first call. Akter can't catch a direct `Date.now()` call, though. That one is up to you.

## The context

A command handler's third argument is its context:

| Member                             | What it does                                             |
| ---------------------------------- | -------------------------------------------------------- |
| `caller`                           | Who sent the command. See [Access](access.md).           |
| `self`                             | This actor's id                                          |
| `now()`, `id()`, `random()`        | Recorded time, ids and random numbers                    |
| `send(Actor, id).command(payload)` | Sends a command to another actor                         |
| `schedule(when).command(payload)`  | Runs one of this actor's commands later                  |
| `start.job(payload, { key })`      | Starts a [job](jobs.md)                                  |
| `broadcast.name(value)`            | Sends a [broadcast](realtime.md#broadcasts) to listeners |

Everything the context stages happens only if the command succeeds, and only after it's stored. Use the context only while the handler runs; calling it later is a defect.

## Message other actors

`send` delivers a command to another actor, of any type:

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

export const Wallet = Actor.make("Wallet", {
  state: Schema.Struct({
    balance: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  commands: {
    pay: Actor.command(Schema.Struct({ to: Schema.String, amount: Schema.Number })),
    receive: Actor.command(Schema.Number, { internal: true }),
  },
})

export const WalletLive = Wallet.toLayer({
  pay: (wallet, { to, amount }, { send }) => {
    wallet.balance -= amount
    send(Wallet, to).receive(amount)
  },
  receive: (wallet, amount) => {
    wallet.balance += amount
  },
})
```

A send is one-way. Akter delivers it after the sender's command is stored, keeps trying until the receiver has stored it, and applies it exactly once. The receiving command runs as a separate command on the other actor, not as part of the sender's change. If it fails, the failure is recorded on the receiver and the sender isn't told.

Sends from one actor to another arrive in the order they were sent.

## Timers

`schedule` runs one of the actor's own commands later. Pass a duration, or `{ at }` with a time in epoch milliseconds:

```ts
schedule("15 minutes").expire(orderId)
schedule({ at: now() + 60_000 }).remind()
```

A timer is stored with the command that set it, and fires once. If no server is running when it comes due, it fires late, as soon as one starts.

## Cron

A command with a `cron` option runs on a schedule:

```ts
commands: {
  touch: Actor.command(),
  nightly: Actor.command({ cron: "CRON_TZ=Europe/Berlin 0 3 * * *" }),
}
```

A cron command takes no payload and is internal. It runs on every actor of its type that has handled at least one command; the actor's first command schedules its first tick. The schedule is a five- or six-field cron expression in UTC, the same with a `CRON_TZ=<zone>` prefix, or an interval like `@every 90 seconds`.

If servers were down when a tick came due, the missed tick runs once when a server starts, as long as it's no more than an hour late. Older ticks are skipped rather than run in a burst.

## Naming

Name commands as instructions, with a verb: `deposit`, `rename`, `close`. Name the commands that receive a job's result as facts, in the past tense: `succeededSendWelcome`, `failedSendWelcome`. Broadcasts are facts too: `announced`, `joined`.

## Internal commands

An internal command can't be called by clients. Only Akter calls it: from a timer or cron, from another actor's `send`, from a job, or with a job's result. Use internal commands for steps a client shouldn't trigger directly, like `receive` above.

An internal command's `caller` is always a `System` caller that says where the call came from. See [Access](access.md#who-is-calling).
