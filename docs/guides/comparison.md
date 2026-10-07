---
title: "Comparison"
description: "How Akter compares with Durable Objects, Rivet, Restate, and Temporal."
---

# Comparison

**Responsibility:** compare Akter with systems developers often consider alongside it, citing each system's own documentation.  
**Authority:** product messaging.  
**Owner role:** product.  
**Change policy:** a change requires product sign-off and must follow the guardrails in [competitive positioning](../product/competitive-positioning.md): every statement about another system cites its documentation, and nothing here claims scale, availability, or speed.

This page compares programming models: where an actor's data lives, what makes a handler's writes durable, and how work outside the handler is recorded. It makes no claims about scale, availability, latency, or throughput, for Akter or for anyone else. Each statement about another system cites that system's documentation, read on 2026-09-28; if the documentation has changed since, it is right and this page is out of date.

Akter is published on npm as `@rikalabs/akter` on the `alpha` dist-tag. Its launch claim is multi-runner on one host: `Runner.socket` with `Runner.mtls`, verified as three Bun processes sharing a Postgres database. Separate hosts and hosting providers need their own evidence; the [support matrix](../operations/support-matrix.md) states each feature's scope. Each system below is a reasonable choice for its own problems; each section ends with when to prefer it.

## At a glance

|                           | Akter                                                              | Cloudflare Durable Objects                                          | Rivet Actors                                                                           | Restate                                                      | Temporal                                                    |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Unit                      | Actor with a typed key                                             | Object with a globally unique name                                  | Actor addressed by key                                                                 | Virtual object addressed by key; also services and workflows | Workflow execution                                          |
| Where its data lives      | Your Postgres database: keyed state plus owned Drizzle tables      | Storage attached to each object; SQLite-backed for new classes      | In memory, persisted automatically; embedded SQLite or an external database            | K/V state stored in the Restate server                       | Event history kept by the Temporal service                  |
| What makes writes durable | One Postgres transaction per command, committed with its receipt   | Storage calls are transactional; writes without an `await` coalesce | Throttled state saves, not tied to action boundaries; `saveState` forces one           | State committed atomically with the handler's execution      | Replay of the recorded event history                        |
| Work outside the handler  | Intents and jobs written in the same transaction, run after commit | Alarms                                                              | Scheduling, queues, and workflows                                                      | Journaled steps: run blocks, calls, and timers               | Activities, whose results are recorded in the history       |
| SDKs and platform         | TypeScript on Effect, in your own process                          | Cloudflare Workers                                                  | Node.js, Bun, React, Next.js; Rust and Effect SDKs in beta; Rivet Cloud or self-hosted | SDKs in several languages, with the Restate server           | Official SDKs in eight languages, with the Temporal service |

## Cloudflare Durable Objects

A Durable Object is a Cloudflare Worker that combines compute with storage; each has a globally unique name and durable storage attached, and it is provisioned close to where it is first requested ([overview](https://developers.cloudflare.com/durable-objects/)). With the SQLite-backed storage API, each storage method is implicitly wrapped in a transaction; a series of writes with no intervening `await` is submitted atomically; and `ctx.storage.transactionSync()` runs a synchronous callback in one transaction that rolls back if it throws ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)). Alarms trigger an object at a future time, and the WebSocket Hibernation API manages the connections of many clients ([overview](https://developers.cloudflare.com/durable-objects/)); new classes are configured for SQLite storage (same page).

**How Akter differs.** An actor's data is ordinary Postgres database: keyed state and Drizzle tables with the actor's ownership columns, readable by your other tools. The transaction boundary is the command: the whole handler runs inside one transaction that also writes its receipt, events, and outgoing intents and jobs, whatever it awaits along the way. It runs in your own process on your own database.

**Prefer Durable Objects when** you deploy on Cloudflare Workers, want placement near users managed for you, or want per-object SQLite storage alongside Cloudflare's other products.

## Rivet Actors

Rivet Actors are long-lived processes with durable state, realtime events, and hibernation, with SDKs for Node.js and Bun, React, Next.js, and beta SDKs for Rust and Effect ([actors](https://rivet.dev/docs/actors)). `c.state` lives in memory and is persisted automatically; saves are throttled (`stateSaveInterval`, default one second) and are not tied to action boundaries, and `c.saveState({ immediate: true })` forces a write, for example before a side effect ([state](https://rivet.dev/docs/actors/state)). Actors can persist to embedded per-actor SQLite or an external database such as PostgreSQL ([persistence](https://rivet.dev/docs/actors/persistence)). Rivet is Apache-licensed and runs on Rivet Cloud or self-hosted, with WebSockets, workflows, queues, and scheduling ([Rivet Actors](https://rivet.dev/actors/)).

**How Akter differs.** Durability is per command, not per save interval: a command's reply is sent only after its turn commits, and its receipt makes a retry return the same result without running the handler again. State that must be written before a side effect needs no explicit save, because side effects are jobs, which run only after the turn that enqueued them commits.

**Prefer Rivet when** in-memory reads and writes inside the actor matter more than per-command commits, or when you want its client libraries, Rust support, or its hosting and self-hosting options.

## Restate

Restate offers services, virtual objects, and workflows. A virtual object is identified by its key and has isolated K/V state stored in Restate, delivered with each request; at most one handler with write access runs at a time per object, shared handlers can read concurrently, and state is atomically committed with the handler's execution ([services](https://docs.restate.dev/concepts/services)). Restate records each step of a handler in a journal and replays it after a failure, skipping completed steps; duplicate requests with the same idempotency key return the original result ([durable execution](https://docs.restate.dev/concepts/durable_execution)).

**How Akter differs.** State lives in your Postgres database next to relational tables the actor owns, rather than in a separate server's K/V store. A handler is a short transaction, not a journaled function: it does not call other actors or external services and wait, but stages intents and jobs that run after it commits. Long multi-step processes are workflow members of the actor.

**Prefer Restate when** handlers orchestrate calls across many services and should resume mid-function after a crash, or when you need SDKs in languages other than TypeScript.

## Temporal

A Temporal workflow is code whose execution is recorded as an event history; to resume, Temporal re-runs the workflow code against that history, so workflow code must make the same decisions given the same history, and activities handle everything that touches the outside world, with their results recorded and reused on replay ([workflows](https://docs.temporal.io/workflows)). Temporal has official SDKs for .NET, Go, Java, PHP, Python, Ruby, Rust, and TypeScript ([SDKs](https://docs.temporal.io/encyclopedia/temporal-sdks)).

**How Akter differs.** It starts from a long-lived actor identity with state and relational data. Workflows, timers, schedules, and jobs are members or policies of that actor, not the unit of the system. A command handler is not replayed from a history: a retried command finds its committed receipt and returns the recorded result.

**Prefer Temporal when** the central problem is orchestrating a business process rather than owning a stateful domain object, or when you need workflows in several languages.

## What Akter does not do

- It has no managed hosting and no edge placement yet.
- It does not make external calls exactly once. A job's executor can run more than once and must pass its `jobId` to the provider as an idempotency key.
- Broadcasts to connected clients are not durable.

See [concepts](concepts.md) for the model and the [support matrix](../operations/support-matrix.md) for what is verified today.
