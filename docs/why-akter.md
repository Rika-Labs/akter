# Why Akter

## The problem

A backend that holds state usually ends up as a pile of parts: a database for the data, a queue for background work, a scheduler for timers, a pub/sub channel for live updates, and a lot of code to keep them in step. Each part fails in its own way, and the bugs live in the gaps between them. The reply goes out before the write lands. A retry charges the card twice. A deploy drops the job that was halfway done.

## The model

Akter starts from the things you're modeling. A chat room, an order, a document, an agent session: each has an id, some state, and a set of things that can happen to it. In Akter, each one is an actor.

An actor's commands run one at a time. A command is a synchronous function that changes the state and decides what happens next: the reply, a message to another actor, a timer, a job, an update for connected clients. None of that happens until the change is stored. If the command fails, none of it happens at all.

Anything slow or uncertain, like an HTTP call, an email or a model completion, runs in a job. A job is an Effect, and each step's result is recorded as it finishes, so a job that crashes or retries picks up where it left off.

That gives you two kinds of code with a sharp line between them. Commands make decisions: they're fast, synchronous and can be replayed. Jobs do I/O, one recorded step at a time.

## One bucket

Akter stores everything for an environment in one S3-compatible bucket: the log of every command, checkpoints of actor state, list pages, indexes, timers and pending jobs. Object storage is cheap, durable and available almost everywhere. Akter relies on conditional writes, which let a bucket refuse a write when someone else got there first. That one feature is enough to stop two servers from both thinking they own an actor.

You don't run a database, a queue or a cache. You run Akter on Bun or Node and give it a bucket. On your laptop, a directory stands in for the bucket.

## Built on Effect

Akter is built on [Effect](https://effect.website), and doesn't hide it. State and payloads are Effect schemas, jobs are Effects, client calls return Effects, live state is a Stream, and handlers are provided as Layers. If you already use Effect, Akter should feel familiar. If you don't, expect to learn some Effect along the way.

## What it costs

Every command waits for a write to the bucket before it replies, so a command takes about as long as one write to your bucket. Akter batches commands from many actors into each write, which keeps throughput up, but a single command will never be as fast as changing a value in memory.

Commands can't do I/O. Code that would read a database or call an API in the middle of a request handler has to be split into a command that decides and a job that acts. It's more structure than a plain HTTP handler, and it's the reason crashes and retries behave predictably.

Akter is pre-1.0. The APIs still change between minor versions.

## When to use something else

- **Queries across many records.** `find` returns actor ids filtered by simple fields. For joins, aggregates or ad hoc queries, use a database.
- **Transactions that span actors.** A command changes one actor. Messages to other actors are delivered exactly once, but separately, not atomically.
- **A replayable event stream.** Broadcasts go to whoever is listening at that moment and aren't stored. Use a log like Kafka if consumers need to catch up later.
- **Exactly-once effects in other systems.** No framework can promise that for a system it doesn't control. Akter gives each job step a stable idempotency key to pass to the provider.
- **Long-running workflows.** Temporal and Restate are built around workflow runs, with cancellation and compensation. Akter's jobs borrow the recorded-step idea, but Akter is centered on actor state.

## Compared to Durable Objects

Cloudflare Durable Objects have the same core idea: an object with an id and its own storage that handles one request at a time. They run only on Cloudflare. Akter runs anywhere Bun or Node runs, with any S3-compatible bucket, and keeps handlers synchronous and replayable by design.
