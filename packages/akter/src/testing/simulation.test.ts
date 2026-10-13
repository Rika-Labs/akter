import { describe, expect, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Fiber, Layer, Random, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Actor, ActorError, JobFailure, Unauthorized, anonymous, isUser, user } from "../index.ts"
import { InvariantViolation, SIMULATION_SEED_BASE, Simulation, SimulationService } from "./index.ts"

class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {
  balance: Schema.Finite,
  requested: Schema.Finite,
}) {}

class Frozen extends Schema.TaggedError<Frozen>()("Frozen", {}) {}

const Account = Actor.make("Account", {
  state: Schema.Struct({
    balance: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    frozen: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    held: Schema.Record(Schema.String, Schema.Finite).pipe(
      Schema.withDecodingDefault(Effect.succeed({})),
    ),
    settled: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    refunded: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: {
    deposit: Actor.action(Schema.Finite),
    freeze: Actor.action(),
    transfer: Actor.action(Schema.Struct({ to: Schema.String, amount: Schema.Finite }), {
      success: Schema.String,
      fails: InsufficientFunds,
    }),
    credit: Actor.action(
      Schema.Struct({ transferId: Schema.String, from: Schema.String, amount: Schema.Finite }),
      {
        fails: Frozen,
        internal: true,
      },
    ),
    settle: Actor.action(Schema.String, { internal: true }),
    expire: Actor.action(Schema.String, { internal: true }),
  },
})

const AccountLive = Account.toLayer({
  deposit: (account, amount) => {
    account.balance += amount
  },
  freeze: (account) => {
    account.frozen = true
  },
  transfer: (account, { to, amount }, { self, id, send, schedule }) => {
    if (account.balance < amount)
      return InsufficientFunds.make({ balance: account.balance, requested: amount })
    const transferId = id()
    account.balance -= amount
    account.held[transferId] = amount
    send(Account, to).credit({ transferId, from: self, amount })
    schedule("150 millis").expire(transferId)
    return transferId
  },
  credit: (account, { transferId, from, amount }, { send }) => {
    if (account.frozen) return Frozen.make({})
    account.balance += amount
    send(Account, from).settle(transferId)
  },
  settle: (account, transferId) => {
    if (account.held[transferId] === undefined) return
    delete account.held[transferId]
    account.settled += 1
  },
  expire: (account, transferId) => {
    const amount = account.held[transferId]
    if (amount === undefined) return
    delete account.held[transferId]
    account.balance += amount
    account.refunded += 1
  },
})

class Envelope extends Schema.Class<Envelope>("Envelope")({
  id: Schema.String,
  to: Schema.String,
  body: Schema.String,
  at: Schema.Finite,
}) {}

const Outbox = Actor.make("Outbox", {
  state: Schema.Struct({
    sent: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    dead: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    pending: Actor.list(Envelope, { key: "id", by: "at" }),
  }),
  actions: {
    enqueue: Actor.action(Schema.Struct({ to: Schema.String, body: Schema.String }), {
      success: Schema.String,
    }),
    delivered: Actor.action(Schema.String, { internal: true }),
    deadLetter: Actor.action(JobFailure, { internal: true }),
  },
  jobs: {
    deliver: Actor.job({
      payload: Envelope,
      retry: { attempts: 4, backoff: "10 millis" },
      timeout: "1 second",
      concurrency: 3,
      onFailure: "deadLetter",
    }),
  },
})

class WebhookError extends Schema.TaggedError<WebhookError>()("WebhookError", {
  status: Schema.Finite,
}) {}

interface WebhookApi {
  readonly reserve: (envelope: Envelope) => Effect.Effect<string>
  readonly post: (envelope: Envelope, reservation: string) => Effect.Effect<number, WebhookError>
}

class Webhook extends Context.Service<Webhook, WebhookApi>()(
  "@rikalabs/akter/testing/simulation.test/Webhook",
) {}

const OutboxLive = Outbox.toLayer({
  enqueue: (outbox, { to, body }, { id, now, start }) => {
    const envelope = Envelope.make({ id: id(), to, body, at: now() })
    outbox.pending.put(envelope)
    start.deliver(envelope, { key: envelope.id })
    return envelope.id
  },
  delivered: (outbox, id) => {
    if (outbox.pending.delete(id)) outbox.sent += 1
  },
  deadLetter: (outbox, failure) => {
    const id = failure.key ?? failure.job
    outbox.pending.delete(id)
    outbox.dead.push(id)
  },
  deliver: (envelope, { self, step }) =>
    Effect.gen(function* () {
      const webhook = yield* Webhook
      const reservation = yield* step("reserve", webhook.reserve(envelope))
      yield* step("post", Schema.Finite, webhook.post(envelope, reservation))
      yield* self.delivered(envelope.id)
    }),
})

interface WebhookStats {
  reserves: number
  posts: number
  inFlight: number
  maxInFlight: number
}

/** Counts calls and concurrency; `flaky:` targets fail twice, `down:` targets always fail. */
const webhookStub = () => {
  const stats: WebhookStats = { reserves: 0, posts: 0, inFlight: 0, maxInFlight: 0 }
  const seen = new Map<string, number>()
  const layer = Layer.succeed(
    Webhook,
    Webhook.of({
      reserve: (envelope) =>
        Effect.sync(() => {
          stats.reserves++
          return `r-${envelope.id}`
        }),
      post: (envelope) =>
        Effect.gen(function* () {
          stats.posts++
          stats.inFlight++
          stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
          yield* Effect.sleep("15 millis")
          stats.inFlight--
          const failures = seen.get(envelope.id) ?? 0
          seen.set(envelope.id, failures + 1)
          if (envelope.to.startsWith("down:")) return yield* WebhookError.make({ status: 503 })
          if (envelope.to.startsWith("flaky:") && failures < 2)
            return yield* WebhookError.make({ status: 502 })
          return 200
        }),
    }),
  )
  return { stats, layer }
}

class Turn extends Schema.Class<Turn>("Turn")({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  at: Schema.Finite,
}) {}

class Busy extends Schema.TaggedError<Busy>()("Busy", {}) {}

const Agent = Actor.make("Agent", {
  state: Schema.Struct({
    status: Schema.Literals(["idle", "thinking", "failed"]).pipe(
      Schema.withDecodingDefault(Effect.succeed<"idle" | "thinking" | "failed">("idle")),
    ),
    turns: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    transcript: Actor.list(Turn, { key: "id", by: "at" }),
  }),
  actions: {
    ask: Actor.action(Schema.String, { fails: Busy, success: Schema.String }),
    answer: Actor.action(Schema.Struct({ askId: Schema.String, text: Schema.String }), {
      internal: true,
    }),
    failed: Actor.action(JobFailure, { internal: true }),
  },
  events: { token: Actor.event(Schema.String) },
  jobs: {
    generate: Actor.job({
      payload: Schema.Struct({ askId: Schema.String, prompt: Schema.String }),
      retry: { attempts: 3, backoff: "50 millis" },
      timeout: "30 seconds",
      onFailure: "failed",
    }),
  },
})

class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  message: Schema.String,
}) {}

interface ModelApi {
  readonly stream: (prompt: string) => Stream.Stream<string, ModelError>
}

class Model extends Context.Service<Model, ModelApi>()(
  "@rikalabs/akter/testing/simulation.test/Model",
) {}

const AgentLive = Agent.toLayer({
  ask: (agent, prompt, { id, now, start }) => {
    if (agent.status === "thinking") return Busy.make({})
    const askId = id()
    agent.status = "thinking"
    agent.transcript.put(Turn.make({ id: askId, role: "user", text: prompt, at: now() }))
    start.generate({ askId, prompt })
    return askId
  },
  answer: (agent, { askId, text }, { now }) => {
    agent.transcript.put(Turn.make({ id: `${askId}.answer`, role: "assistant", text, at: now() }))
    agent.turns += 1
    agent.status = "idle"
  },
  failed: (agent) => {
    agent.status = "failed"
  },
  generate: ({ askId, prompt }, { self, step, emit }) =>
    Effect.gen(function* () {
      const model = yield* Model
      const text = yield* step(
        "complete",
        model.stream(prompt).pipe(
          Stream.tap((token) => emit.token(token)),
          Stream.runFold(
            () => "",
            (text, token) => text + token,
          ),
        ),
      )
      yield* self.answer({ askId, text })
    }),
})

/** Streams the reply word by word; fails the first attempt of "flaky" prompts mid-stream and every "broken" one. */
const ModelStub = Layer.sync(Model, () => {
  const seen = new Set<string>()
  return Model.of({
    stream: (prompt) =>
      Stream.suspend(() => {
        if (prompt.includes("flaky") && !seen.has(prompt)) {
          seen.add(prompt)
          return Stream.concat(
            Stream.make("par", "tial "),
            Stream.fail(ModelError.make({ message: "connection reset" })),
          )
        }
        if (prompt.includes("broken"))
          return Stream.fail(ModelError.make({ message: "model unavailable" }))
        const words = `You asked: ${prompt}`
          .split(" ")
          .map((word, index) => (index === 0 ? word : ` ${word}`))
        return Stream.fromIterable(words).pipe(Stream.tap(() => Effect.sleep("2 millis")))
      }),
  })
})

const RoomId = Schema.String.pipe(Schema.brand("RoomId"))

class Message extends Schema.Class<Message>("Message")({
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
  at: Schema.Finite,
}) {}

class Summary extends Schema.Class<Summary>("Summary")({
  title: Schema.String,
  online: Schema.Finite,
}) {}

class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { reason: Schema.String }) {}

class Email extends Schema.Class<Email>("Email")({ to: Schema.String, subject: Schema.String }) {}

const Room = Actor.make("Room", {
  key: RoomId,
  state: Schema.Struct({
    title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    admins: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    online: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed({})),
    ),
    posts: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    topic: Schema.optional(Schema.String),
    messages: Actor.list(Message, { key: "id", by: "at" }),
  }),
  actions: {
    claim: Actor.action(),
    post: Actor.action(Schema.String),
    rename: Actor.action(Schema.String, { fails: Forbidden }),
    setTopic: Actor.action(Schema.optional(Schema.String)),
    count: Actor.action({ success: Schema.Finite }),
    startTyping: Actor.action(),
    prune: Actor.action({ cron: "0 3 * * *" }),
    notifyFailed: Actor.action(JobFailure, { internal: true }),
  },
  views: { summary: Actor.view(Summary) },
  events: { typing: Actor.event(Schema.String) },
  jobs: {
    notify: Actor.job({
      payload: Email,
      retry: { attempts: 5, backoff: "2 seconds" },
      timeout: "1 minute",
      concurrency: 10,
      onFailure: "notifyFailed",
    }),
  },
  presence: Schema.Struct({ name: Schema.String }),
  access: isUser,
})

interface MailerApi {
  readonly send: (email: Email) => Effect.Effect<void>
}

class Mailer extends Context.Service<Mailer, MailerApi>()(
  "@rikalabs/akter/testing/simulation.test/Mailer",
) {}

const RoomLive = Room.toLayer({
  claim: (room, _, { caller }) => {
    if (isUser(caller) && room.admins.length === 0) room.admins.push(caller.subject)
  },
  post: (room, body, { caller, id, now, start }) => {
    const messageId = id()
    room.messages.put(Message.make({ id: messageId, author: caller.subject, body, at: now() }))
    room.posts += 1
    const mention = /^@(\S+)/.exec(body)?.[1]
    if (mention !== undefined)
      start.notify(Email.make({ to: mention, subject: room.title }), { key: messageId })
  },
  rename: (room, title, { caller }) => {
    if (!room.admins.includes(caller.subject)) return Forbidden.make({ reason: "admins only" })
    room.title = title
  },
  setTopic: (room, topic) => {
    if (topic === undefined) delete room.topic
    else room.topic = topic
  },
  count: (room) => Object.keys(room.online).length,
  startTyping: (_, __, { caller, emit }) => {
    emit.typing(caller.subject)
  },
  prune: (room, _, { now }) => {
    room.messages.deleteBefore(now() - 30 * 86_400_000)
  },
  notifyFailed: (room, failure) => {
    room.messages.put(
      Message.make({
        id: failure.job,
        author: "system",
        body: `notify failed: ${failure.cause}`,
        at: 0,
      }),
    )
  },
  summary: (room) => Summary.make({ title: room.title, online: Object.keys(room.online).length }),
  connect: (room, { name }, { connection }) => {
    room.online[connection] = name
  },
  disconnect: (room, _, { connection }) => {
    delete room.online[connection]
  },
  notify: (email, { self, step }) =>
    step(
      "send",
      Mailer.use((mailer) => mailer.send(email)),
    ).pipe(Effect.andThen(self.post(`sent mail to ${email.to}`))),
})

const ana = user("ana")
const bob = user("bob")

describe("Simulation examples", () => {
  it("transfer: a send credits and settles back, a refused credit expires and refunds, a declared failure discards its draft", () =>
    Simulation.run(
      { actors: [Account], seed: 1 },
      Effect.gen(function* () {
        const alice = yield* Account.client("alice")
        const carol = yield* Account.client("carol")
        yield* alice.deposit(100)
        yield* carol.freeze()
        const transferId = yield* alice.transfer({ to: "bob", amount: 30 })
        const tooMuch = yield* Effect.flip(alice.transfer({ to: "bob", amount: 500 }))
        yield* alice.transfer({ to: "carol", amount: 20 })
        yield* Simulation.settle
        const [after, bobAfter, carolAfter] = yield* Effect.all([
          Simulation.state(Account, "alice"),
          Simulation.state(Account, "bob"),
          Simulation.state(Account, "carol"),
        ])
        expect(transferId).toMatch(/^[0-9a-f-]{36}$/)
        expect(tooMuch).toEqual(InsufficientFunds.make({ balance: 70, requested: 500 }))
        expect([after.balance, after.settled, after.refunded, Object.keys(after.held)]).toEqual([
          70,
          1,
          1,
          [],
        ])
        expect([bobAfter.balance, carolAfter.balance]).toEqual([30, 0])
      }).pipe(Effect.scoped),
      AccountLive,
    ))

  it("outbox: jobs run with bounded concurrency, finished steps never repeat, spent retries reach onFailure once", () => {
    const webhook = webhookStub()
    return Simulation.run(
      { actors: [Outbox], seed: 2 },
      Effect.gen(function* () {
        const box = yield* Outbox.client("tenant-1")
        for (const to of ["a@x", "b@x", "c@x", "flaky:d@x", "flaky:e@x", "down:f@x"])
          yield* box.enqueue({ to, body: "hi" })
        yield* Simulation.settle
        const state = yield* Simulation.state(Outbox, "tenant-1")
        expect([state.sent, state.dead.length, state.pending.length]).toEqual([5, 1, 0])
        expect(webhook.stats.maxInFlight).toBeLessThanOrEqual(3)
        expect(webhook.stats.maxInFlight).toBeGreaterThanOrEqual(2)
        expect([webhook.stats.reserves, webhook.stats.posts]).toEqual([6, 3 + 3 + 3 + 4])
      }).pipe(Effect.scoped),
      OutboxLive.pipe(Layer.provide(webhook.layer)),
    )
  })

  it("agent: a streaming job emits tokens, retries a mid-stream failure, and reports spent attempts", () =>
    Simulation.run(
      { actors: [Agent], seed: 3 },
      Effect.gen(function* () {
        const bot = yield* Agent.client("assistant-1")
        const tokens = yield* Effect.forkChild(bot.token.pipe(Stream.take(4), Stream.runCollect))
        yield* Effect.yieldNow
        const askId = yield* bot.ask("hello there")
        const busy = yield* Effect.flip(bot.ask("again"))
        yield* Simulation.settle
        expect(busy).toEqual(Busy.make({}))
        expect([...(yield* Fiber.join(tokens))].join("")).toBe("You asked: hello there")
        const transcript = yield* bot.transcript.range()
        expect(transcript.map((turn) => [turn.id === askId, turn.text])).toEqual([
          [true, "hello there"],
          [false, "You asked: hello there"],
        ])
        yield* bot.ask("a flaky question")
        yield* Simulation.settle
        const newest = yield* bot.transcript.range({ reverse: true, limit: 1 })
        expect(newest.map((turn) => turn.text)).toEqual(["You asked: a flaky question"])
        yield* bot.ask("a broken question")
        yield* Simulation.settle
        const state = yield* Simulation.state(Agent, "assistant-1")
        expect([state.status, state.turns]).toEqual(["failed", 2])
      }).pipe(Effect.scoped),
      AgentLive.pipe(Layer.provide(ModelStub)),
    ))

  it("chat and a client session: presence, state frames then patches, views, events, access, jobs and cron", () => {
    const mailed: Array<string> = []
    const MailerStub = Layer.succeed(
      Mailer,
      Mailer.of({
        send: (email) =>
          Effect.sync(() => {
            mailed.push(email.to)
          }),
      }),
    )
    const lobbyId = RoomId.make("lobby")
    const visit = Effect.gen(function* () {
      const lobby = yield* Room.client(lobbyId)
      const watcher = yield* lobby.state.pipe(
        Stream.takeUntil(
          (state) => state.title === "Lobby" && state.posts >= 2 && state.topic === undefined,
        ),
        Stream.runCollect,
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      yield* lobby.join({ name: "Ana" })
      yield* lobby.claim()
      yield* lobby.rename("Lobby")
      yield* lobby.setTopic("introductions")
      yield* lobby.post("hello, room")
      yield* TestClock.adjust("1 second")
      yield* lobby.post("second message")
      yield* lobby.setTopic(undefined)
      const frames = [...(yield* Fiber.join(watcher))]
      const online = yield* lobby.count()
      const newest = yield* lobby.messages.range({ limit: 1, reverse: true })
      const lobbies = yield* Room.find({
        where: { title: "Lobby", posts: { gte: 1 } },
        orderBy: { field: "posts", direction: "desc" },
        limit: 10,
      })
      const withTopic = yield* Room.find({ where: { topic: "introductions" } })
      return { frames, online, newest: newest.map((message) => message.body), lobbies, withTopic }
    }).pipe(Effect.scoped, Simulation.as(ana))
    return Simulation.run(
      { actors: [Room], seed: 4 },
      Effect.gen(function* () {
        const watchers = yield* Effect.gen(function* () {
          const lobby = yield* Room.client(lobbyId)
          const typing = yield* Effect.forkChild(
            lobby.typing.pipe(Stream.take(1), Stream.runCollect),
          )
          const summaries = yield* Effect.forkChild(
            lobby.summary().pipe(
              Stream.takeUntil((summary) => summary.title === "Lobby"),
              Stream.runCollect,
            ),
          )
          return { typing, summaries }
        }).pipe(Simulation.as(bob))
        yield* Effect.yieldNow
        const seen = yield* visit
        expect([seen.frames[0]?.title, seen.frames.at(-1)?.title]).toEqual(["", "Lobby"])
        expect(seen.frames.some((frame) => Object.values(frame.online).includes("Ana"))).toBe(true)
        expect(seen.frames.some((frame) => frame.topic === "introductions")).toBe(true)
        expect(seen.frames.at(-1)?.topic).toBeUndefined()
        expect([seen.online, seen.newest, seen.lobbies, seen.withTopic]).toEqual([
          1,
          ["second message"],
          [lobbyId],
          [],
        ])
        yield* Simulation.settle
        expect(Object.keys((yield* Simulation.state(Room, lobbyId)).online)).toEqual([])

        const refused = yield* Effect.gen(function* () {
          const lobby = yield* Room.client(lobbyId)
          yield* lobby.startTyping()
          return yield* Effect.flip(lobby.rename("Bob's room"))
        }).pipe(Effect.scoped, Simulation.as(bob))
        expect(refused).toEqual(Forbidden.make({ reason: "admins only" }))
        expect([...(yield* Fiber.join(watchers.typing))]).toEqual(["bob"])
        expect([...(yield* Fiber.join(watchers.summaries))].at(-1)).toEqual(
          Summary.make({ title: "Lobby", online: 1 }),
        )

        const denied = yield* Effect.flatMap(Room.client(lobbyId), (lobby) =>
          Effect.flip(lobby.post("hi")),
        ).pipe(Effect.scoped, Simulation.as(anonymous))
        expect(denied).toEqual(
          ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) }),
        )

        yield* Effect.flatMap(Room.client(lobbyId), (lobby) =>
          lobby.post("@carol see the new title"),
        ).pipe(Effect.scoped, Simulation.as(ana))
        yield* Simulation.settle
        const beforePrune = yield* Simulation.state(Room, lobbyId)
        expect(mailed).toEqual(["carol"])
        expect(beforePrune.messages.map((message) => message.body)).toContain("sent mail to carol")
        expect(
          beforePrune.messages.find((message) => message.body === "sent mail to carol")?.author,
        ).toMatch(/^job:/)
        yield* Simulation.advance("31 days")
        expect((yield* Simulation.state(Room, lobbyId)).messages).toEqual([])
      }).pipe(Effect.scoped),
      RoomLive.pipe(Layer.provide(MailerStub)),
    )
  })
})

const Counter = Actor.make("Counter", {
  state: Schema.Struct({ n: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  actions: { bump: Actor.action() },
})

const bumpOnce = (seed: number, handlers: Parameters<typeof Counter.toLayer>[0]) =>
  Simulation.run(
    { actors: [Counter], seed },
    Effect.gen(function* () {
      const counter = yield* Counter.client("c")
      yield* counter.bump()
      return yield* Effect.flip(Simulation.settle)
    }).pipe(Effect.scoped),
    Counter.toLayer(handlers),
  )

describe("Simulation determinism", () => {
  it("runs every action twice on cloned state and names the seed when a closure counter makes them differ", () => {
    let calls = 0
    return bumpOnce(11, {
      bump: (state) => {
        calls++
        state.n = calls
      },
    }).then((violation) => {
      expect(violation).toBeInstanceOf(InvariantViolation)
      expect(violation.message).toContain("Simulation seed 11")
      expect(violation.violations.join("\n")).toMatch(/I9: Counter\.bump .* is not deterministic/)
    })
  })

  it("catches Math.random, which the run replaces with a seeded generator that advances per call", () =>
    bumpOnce(12, {
      bump: (state) => {
        state.n = Math.random()
      },
    }).then((violation) => {
      expect(violation.violations.join("\n")).toMatch(/I9: Counter\.bump/)
    }))

  it("accepts the action context's random, which is seeded by the command id", () =>
    Simulation.run(
      { actors: [Counter], seed: 13 },
      Effect.gen(function* () {
        const counter = yield* Counter.client("c")
        yield* counter.bump()
        yield* Simulation.settle
        return (yield* Simulation.state(Counter, "c")).n
      }).pipe(Effect.scoped),
      Counter.toLayer({
        bump: (state, _, { random }) => {
          state.n = random()
        },
      }),
    ).then((outcome) => {
      expect(outcome).toBeGreaterThan(0)
      expect(outcome).toBeLessThan(1)
    }))
})

const Ledger = Actor.make("Ledger", {
  state: Schema.Struct({
    balance: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    sent: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    received: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    audits: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: {
    transfer: Actor.action(Schema.Struct({ to: Schema.String, amount: Schema.Finite }), {
      fails: InsufficientFunds,
    }),
    credit: Actor.action(Schema.Finite, { internal: true }),
    audit: Actor.action({ internal: true }),
  },
})

const LedgerLive = Ledger.toLayer({
  transfer: (ledger, { to, amount }, { send, schedule }) => {
    if (ledger.balance < amount)
      return InsufficientFunds.make({ balance: ledger.balance, requested: amount })
    ledger.balance -= amount
    ledger.sent += 1
    send(Ledger, to).credit(amount)
    schedule("100 millis").audit()
  },
  credit: (ledger, amount) => {
    ledger.balance += amount
    ledger.received += 1
  },
  audit: (ledger) => {
    ledger.audits += 1
  },
})

const holders = ["a", "b", "c", "d", "e"]

interface LedgerRun {
  readonly money: number
  readonly sent: number
  readonly received: number
  readonly audits: number
  readonly succeeded: number
  readonly refused: number
  readonly unknown: number
  readonly crashes: number
  readonly lostResponses: number
  readonly outages: number
  readonly partitioned: number
  readonly paused: number
  readonly log: ReadonlyArray<string>
}

const text = new TextDecoder()

/**
 * The runner layer moving a two-runner store under load, at seeded points: it assigns every shard
 * to the other runner (fencing the one that held them), drains the owner and assigns the store to
 * the other, or pauses or cuts off the owner's bucket calls for a while.
 */
const moves = Effect.gen(function* () {
  const simulator = yield* SimulationService
  for (let step = 0; step < 4; step++) {
    yield* Effect.repeat(Effect.yieldNow, { times: yield* Random.nextIntBetween(0, 40) })
    const owner = simulator.owner ?? 0
    const other = 1 - owner
    const seconds = `${yield* Random.nextIntBetween(1, 20)} seconds` as const
    const move = yield* Random.nextIntBetween(0, 4)
    if (move === 0) yield* Simulation.assign(other)
    else if (move === 1) yield* Effect.andThen(Simulation.drain(), Simulation.assign(other))
    else if (move === 2) yield* Simulation.pause(owner, seconds)
    else yield* Simulation.partition(owner, seconds)
  }
})

/**
 * Twelve concurrent transfers among five accounts under crashes, lost responses, a slow log and an
 * operator crash of every shard partway through; with `moving`, over two runners while the runner
 * layer moves the store between them. A moved run reads every account once `validFor` after it
 * settles, as the next request would: an idle owner whose shard a late open fenced learns of it only
 * then, and the runner layer opens the shard again with the timers and sends the log owes. Some transfers ask for more than the balance and are refused,
 * discarding their draft. Money moves only by exactly-once sends and every committed transfer arms
 * one timer, so a lost, duplicated or replayed effect shows in the totals, and `settle` checks
 * I1–I9 on top.
 */
const ledgerRun = (run: number, moving = false): Promise<LedgerRun> =>
  Simulation.run(
    {
      actors: [Ledger],
      seed: SIMULATION_SEED_BASE + run,
      faults: ["crash", "lostResponse", "unavailable", "slowLog"],
      runners: moving ? [{}, {}] : [{}],
    },
    Effect.gen(function* () {
      yield* Effect.forEach(holders, (id) => Simulation.seed(Ledger, id, { balance: 100 }))
      const moved = moving ? yield* Effect.forkChild(moves) : undefined
      const crashed = yield* Effect.forkChild(Effect.andThen(Effect.yieldNow, Simulation.crash()))
      const outcomes = yield* Effect.forEach(
        Array.from({ length: 12 }, (_, index) => index),
        (index) =>
          Effect.flatMap(Ledger.client(holders[index % 5] ?? "a"), (ledger) =>
            Effect.exit(
              ledger.transfer({ to: holders[(index * 3 + 1) % 5] ?? "b", amount: 15 + index * 6 }),
            ),
          ),
        { concurrency: "unbounded" },
      )
      yield* Fiber.join(crashed)
      if (moved !== undefined) yield* Fiber.join(moved)
      yield* Simulation.settle
      if (moving) {
        yield* Simulation.advance("11 seconds")
        yield* Effect.forEach(holders, (id) => Simulation.state(Ledger, id))
        yield* Simulation.settle
      }
      const states = yield* Effect.forEach(holders, (id) => Simulation.state(Ledger, id))
      const failures = outcomes.flatMap((outcome) =>
        Exit.isFailure(outcome) ? [Cause.pretty(outcome.cause)] : [],
      )
      const simulator = yield* SimulationService
      const { crashes, lostResponses, outages, partitioned, paused } = simulator.bucket.counts()
      const logs = yield* simulator.logs
      return {
        log: logs.flatMap((log) => [
          ...log.segments.map(
            (segment) =>
              `${log.shard} log ${segment.offset} open ${segment.open}: ${segment.entries.map((entry) => text.decode(entry)).join(" | ")}`,
          ),
          ...log.checkpoints.map(
            (checkpoint) =>
              `${log.shard} checkpoint ${checkpoint.offset}: ${text.decode(checkpoint.bytes)}`,
          ),
        ]),
        crashes,
        lostResponses,
        outages,
        partitioned,
        paused,
        money: states.reduce((sum, state) => sum + state.balance, 0),
        sent: states.reduce((sum, state) => sum + state.sent, 0),
        received: states.reduce((sum, state) => sum + state.received, 0),
        audits: states.reduce((sum, state) => sum + state.audits, 0),
        succeeded: outcomes.length - failures.length,
        refused: failures.filter((failure) => failure.includes("InsufficientFunds")).length,
        unknown: failures.filter((failure) => !failure.includes("InsufficientFunds")).length,
      }
    }).pipe(Effect.scoped),
    LedgerLive,
  )

const seedRuns = 1_000

const movingRuns = 200

interface FaultsSeen {
  readonly refused: number
  readonly crashes: number
  readonly lostResponses: number
  readonly outages: number
  readonly partitioned: number
  readonly paused: number
}

/** Runs `runs` seeds in order, checks each one's totals, and sums the faults they saw. */
const matrix = (runs: number, moving: boolean): Promise<FaultsSeen> =>
  Array.from({ length: runs }, (_, run) => run).reduce<Promise<FaultsSeen>>(
    (previous, run) =>
      previous.then((seen) =>
        ledgerRun(run, moving).then((totals) => {
          const seed = `Simulation seed ${SIMULATION_SEED_BASE + run} (run ${run})`
          expect(totals.money, seed).toBe(500)
          expect(totals.received, seed).toBe(totals.sent)
          expect(totals.audits, seed).toBe(totals.sent)
          expect(totals.sent, seed).toBeGreaterThanOrEqual(totals.succeeded)
          expect(totals.sent, seed).toBeLessThanOrEqual(totals.succeeded + totals.unknown)
          return {
            refused: seen.refused + totals.refused,
            crashes: seen.crashes + totals.crashes,
            lostResponses: seen.lostResponses + totals.lostResponses,
            outages: seen.outages + totals.outages,
            partitioned: seen.partitioned + totals.partitioned,
            paused: seen.paused + totals.paused,
          }
        }),
      ),
    Promise.resolve({
      refused: 0,
      crashes: 0,
      lostResponses: 0,
      outages: 0,
      partitioned: 0,
      paused: 0,
    }),
  )

describe("seed matrix", () => {
  it(
    `conserves money and delivers every send and timer exactly once across ${seedRuns} faulted seeds`,
    () =>
      matrix(seedRuns, false).then((seen) => {
        expect(seen.refused).toBeGreaterThan(0)
        expect(seen.crashes).toBeGreaterThan(0)
        expect(seen.lostResponses).toBeGreaterThan(0)
        expect(seen.outages).toBeGreaterThan(0)
      }),
    300_000,
  )

  it(
    `keeps the same totals across ${movingRuns} faulted seeds while the runner layer moves, drains, pauses and cuts off the owner`,
    () =>
      matrix(movingRuns, true).then((seen) => {
        expect(seen.crashes).toBeGreaterThan(0)
        expect(seen.partitioned).toBeGreaterThan(0)
        expect(seen.paused).toBeGreaterThan(0)
      }),
    300_000,
  )

  it(
    "replays a seed exactly: two runs of the same seed write the same log and checkpoints",
    () =>
      Array.from({ length: 50 }, (_, run) => run).reduce<Promise<void>>(
        (previous, run) =>
          previous.then(() =>
            ledgerRun(run).then((first) =>
              ledgerRun(run).then((second) => {
                expect(
                  second,
                  `Simulation seed ${SIMULATION_SEED_BASE + run} (run ${run})`,
                ).toEqual(first)
              }),
            ),
          ),
        Promise.resolve(),
      ),
    120_000,
  )

  it(
    "replays a moving seed exactly: two runs over two runners write the same log and checkpoints",
    () =>
      Array.from({ length: 20 }, (_, run) => run).reduce<Promise<void>>(
        (previous, run) =>
          previous.then(() =>
            ledgerRun(run, true).then((first) =>
              ledgerRun(run, true).then((second) => {
                expect(
                  second,
                  `Simulation seed ${SIMULATION_SEED_BASE + run} (run ${run})`,
                ).toEqual(first)
              }),
            ),
          ),
        Promise.resolve(),
      ),
    120_000,
  )
})
