import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import {
  Actor,
  Actors,
  CurrentCaller,
  Intent,
  NotCreated,
  System,
  Unauthorized,
} from "../../index.ts"
import type { Mintable } from "../../contexts/command.ts"
import type { ActorRef, Caller } from "../../identity/caller.ts"
import { deriveMintId } from "../../identity/mint.ts"
import { InternalActors } from "../../runtime/actors.ts"
import { Outcome, type Request } from "../../runtime/request.ts"
import { routingKey } from "../../runtime/storage/codec.ts"
import type { TurnPoint } from "../../runtime/turn/hooks.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"
import { enqueue, holding, transactions } from "./batches.ts"
import { CLAIM_LEASE } from "./outbox.ts"

/** Captures real relay requests and brackets their child-side statements. */
export interface MintFixture {
  readonly deliveries: Map<string, Request>
  onTurn: ((point: TurnPoint, request: Request) => void) | undefined
}

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const Open = Actor.command("Open", { payload: Schema.String, error: Refused })

const Title = Actor.command("Title", { success: Schema.String })

const childState = Actor.state({
  title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
})

const Task = Actor.make("MintTask", {
  state: childState,
  api: { Open, Title },

  createdBy: Open,
})

const Note = Actor.make("MintNote", {
  placement: "actor",
  state: Actor.state({
    title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    opens: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  api: { Open, Title },

  createdBy: Open,
})

const Ids = Schema.Array(Schema.String)

const Plan = Actor.command("Plan", { payload: Schema.Int, success: Ids })

const PlanMixed = Actor.command("PlanMixed", { success: Ids })

const PlanLater = Actor.command("PlanLater", { success: Schema.String })

const PlanAcross = Actor.command("PlanAcross", { success: Schema.String })

const PlanThenRefuse = Actor.command("PlanThenRefuse", { error: Refused })

const PlanDelayed = Actor.command("PlanDelayed", { success: Ids })

const PlanDelayedThenRefuse = Actor.command("PlanDelayedThenRefuse", { error: Refused })

const PlanThenDie = Actor.command("PlanThenDie")

const PlanRefusedChild = Actor.command("PlanRefusedChild", { success: Schema.String })

const MintOnly = Actor.command("MintOnly")

const MintUnmintable = Actor.command("MintUnmintable")

const Escape = Actor.command("Escape")

const Steal = Actor.command("Steal")

const PlanKeyed = Actor.command("PlanKeyed")

const PlanStagedFirst = Actor.command("PlanStagedFirst", {
  payload: Schema.String,
  success: Schema.String,
})

const Planner = Actor.make("MintPlanner", {
  key: Schema.String,
  api: {
    Plan,
    PlanMixed,
    PlanLater,
    PlanAcross,
    PlanThenRefuse,
    PlanDelayed,
    PlanDelayedThenRefuse,
    PlanThenDie,
    PlanRefusedChild,
    MintOnly,
    MintUnmintable,
    Escape,
    Steal,
    PlanStagedFirst,
    PlanKeyed,
  },
})

const SoloPlan = Actor.command("SoloPlan", { success: Schema.String })

const SoloPlanner = Actor.make("MintSoloPlanner", { key: Actor.singleton, api: { SoloPlan } })

const Former = Actor.make("MintFormerChild", { state: childState, api: { Open, Title } })

const Job = Actor.make("MintNamedJob", {
  key: Schema.String,
  state: childState,
  api: { Open, Title },

  createdBy: Open,
})

const runs: Array<ReadonlyArray<string>> = []

let escaped: Effect.Effect<string> = Effect.succeed("")

const openTask = Effect.fnUntraced(function* (title: string) {
  const id = yield* (yield* Planner.Turn).mint(Task)
  yield* (yield* Task.intents(id)).Open(title)

  return id
})

const openNote = Effect.fnUntraced(function* (title: string) {
  const id = yield* (yield* Planner.Turn).mint(Note)
  yield* (yield* Note.intents(id)).Open(title)

  return id
})

export const mintLayer = Layer.mergeAll(
  Task.toLayer(
    Effect.succeed({
      Open: Effect.fnUntraced(function* (title: string) {
        yield* (yield* Task.Turn).state.set({ title })

        if (title === "refuse") return yield* Refused.make({})
      }),
      Title: Effect.fnUntraced(function* () {
        return (yield* Task.Turn).state.title
      }),
    }),
  ),
  Note.toLayer(
    Effect.succeed({
      Open: Effect.fnUntraced(function* (title: string) {
        const turn = yield* Note.Turn
        yield* turn.state.set({ title, opens: turn.state.opens + 1 })
      }),
      Title: Effect.fnUntraced(function* () {
        return (yield* Note.Turn).state.title
      }),
    }),
  ),
  Planner.toLayer(
    Effect.succeed({
      Plan: Effect.fnUntraced(function* (count: number) {
        const ids: Array<string> = []

        for (let index = 0; index < count; index++) ids.push(yield* openTask(`task ${index}`))
        runs.push(ids)

        return ids
      }),
      PlanMixed: Effect.fnUntraced(function* () {
        const ids: ReadonlyArray<string> = [yield* openTask("task"), yield* openNote("note")]

        return ids
      }),
      PlanLater: Effect.fnUntraced(function* () {
        const id = yield* (yield* Planner.Turn).mint(Task)
        yield* (yield* Task.intents(id)).Open("later").pipe(Intent.after("1 hour"))

        return id
      }),
      PlanAcross: Effect.fnUntraced(function* () {
        const id = yield* (yield* Planner.Turn).mint(Note)
        yield* (yield* Note.intents(id)).Open("across").pipe(Intent.after("1 minute"))

        return id
      }),
      PlanThenRefuse: Effect.fnUntraced(function* () {
        runs.push([yield* openTask("refused")])

        return yield* Refused.make({})
      }),
      PlanDelayed: Effect.fnUntraced(function* () {
        const id = yield* (yield* Planner.Turn).mint(Task)
        yield* (yield* Task.intents(id)).Open("delayed").pipe(Intent.after("1 hour"))
        runs.push([id])

        return [id]
      }),
      PlanDelayedThenRefuse: Effect.fnUntraced(function* () {
        const id = yield* (yield* Planner.Turn).mint(Task)
        yield* (yield* Task.intents(id)).Open("delayed").pipe(Intent.after("1 hour"))
        runs.push([id])

        return yield* Refused.make({})
      }),
      PlanThenDie: Effect.fnUntraced(function* () {
        runs.push([yield* openTask("died")])

        return yield* Effect.die(new Error("Planner defect after minting"))
      }),
      PlanRefusedChild: () => openTask("refuse"),
      MintOnly: Effect.fnUntraced(function* () {
        yield* (yield* Planner.Turn).mint(Task)
      }),
      MintUnmintable: Effect.fnUntraced(function* () {
        const unmintable: object = Planner
        yield* (yield* Planner.Turn).mint(unmintable as Mintable)
      }),
      Escape: Effect.fnUntraced(function* () {
        escaped = (yield* Planner.Turn).mint(Task)
      }),
      Steal: () => Effect.asVoid(Effect.suspend(() => escaped)),
      PlanKeyed: Effect.fnUntraced(function* () {
        const id = yield* (yield* Planner.Turn).mint(Task)
        runs.push([id])
        yield* (yield* Task.intents(id)).Open("keyed").pipe(Intent.key("slot"))
      }),
      PlanStagedFirst: Effect.fnUntraced(function* (known: string) {
        yield* (yield* Task.intents(known as Parameters<typeof Task.intents>[0])).Open(
          "staged first",
        )

        return yield* (yield* Planner.Turn).mint(Task)
      }),
    }),
  ),
  SoloPlanner.toLayer(
    Effect.succeed({
      SoloPlan: Effect.fnUntraced(function* () {
        const id = yield* (yield* SoloPlanner.Turn).mint(Task)
        yield* (yield* Task.intents(id)).Open("solo")

        return id
      }),
    }),
  ),
  Job.toLayer(
    Effect.succeed({
      Open: Effect.fnUntraced(function* (title: string) {
        yield* (yield* Job.Turn).state.set({ title })
      }),
      Title: Effect.fnUntraced(function* () {
        return (yield* Job.Turn).state.title
      }),
    }),
  ),
  Former.toLayer(
    Effect.succeed({
      Open: Effect.fnUntraced(function* (title: string) {
        yield* (yield* Former.Turn).state.set({ title })
      }),
      Title: Effect.fnUntraced(function* () {
        return (yield* Former.Turn).state.title
      }),
    }),
  ),
)

const task = (id: string) => Task.get(id as Parameters<typeof Task.get>[0])

const note = (id: string) => Note.get(id as Parameters<typeof Note.get>[0])

const expected = (parent: ActorRef, commandId: string, ordinal: number, child = "MintTask") =>
  deriveMintId({ parent, commandId, ordinal, child })

/** The System caller a parent's creating intent carries, rebuilt outside any turn. */
const proven = (parent: ActorRef, commandId: string, ordinal = 0) =>
  System.make({ source: "actor", ref: parent, mint: { commandId, ordinal } })

/** Opens a task as `caller`, which the handle binds when it is acquired, and returns its failure. */
const openAs = (id: string, title: string, caller: Caller) =>
  task(id).pipe(
    Effect.flatMap((child) => child.Open(title)),
    Effect.provideService(CurrentCaller, caller),
    Effect.flip,
  )

const created = Effect.fnUntraced(function* (actor: string, id: string) {
  const test = yield* ActorTest

  return yield* test.receiptsFor({ tenant: test.tenant, actor, id }, "Open")
})

/**
 * Gives the last command enqueued behind a held turn time to finish its
 * `queued` hook, which the batch waits for, so every waiting command is in
 * the next batch.
 */
const settle = Effect.sleep("500 millis")

/** Plans one task whose creating intent is due in an hour, and returns the task's id. */
export const planLaterTask = (parent: string) =>
  Planner.get(parent).pipe(Effect.flatMap((planner) => planner.PlanLater()))

/** The title of a created minted task. */
export const mintedTitle = (id: string) => task(id).pipe(Effect.flatMap((child) => child.Title()))

/** Mints one child from a tenant-placed planner, for the single-shard statement check. */
export const mintWorkload: Effect.Effect<void, never, Actors> = Effect.gen(function* () {
  yield* (yield* Planner.get("p-shard")).Plan(1)
}).pipe(Effect.orDie)

/** Selects a child in the opposite routing-key half from its tenant-placed parent. */
export const planAcrossShard = Effect.fnUntraced(function* (scenario: string) {
  const planner = yield* Planner.get(scenario)
  const actors = yield* Actors
  const parentKey = routingKey({ ref: planner.ref, placement: "tenant" })

  for (let attempt = 0; attempt < 256; attempt++) {
    const commandId = yield* actors.mintCommandId
    const id = yield* expected(planner.ref, commandId, 0, "MintNote")
    const ref = { ...planner.ref, actor: "MintNote", id }
    const childKey = routingKey({ ref, placement: "actor" })

    if (parentKey < 0n === childKey < 0n) continue

    yield* planner.PlanAcross().pipe(Actor.commandId(commandId))

    return { planner, ref, parentKey, childKey, commandId }
  }

  return yield* Effect.die(new Error("No minted child in the opposite routing-key half"))
})

/** Minted-id cases: ids derive from the command id and ordinal, stay stable across a rerun after a crash, and create each child once. */
export const mintConformance: ReadonlyArray<ConformanceCase<MintFixture>> = [
  {
    name: "creates a child across routing keys only from a committed relay delivery and replays it after a crash before outbox deletion",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const internal = yield* InternalActors
          const { planner, ref, parentKey, childKey, commandId } =
            yield* planAcrossShard("cross-mint")
          const caller = proven(planner.ref, commandId)
          const forged: Request = {
            ref,
            caller,
            command: "Open",
            commandId: yield* (yield* Actors).mintCommandId,
            payload: yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.Struct({ value: Schema.String })),
            )({ value: "forged" }),
          }
          const denied = { reason: Unauthorized.make({ code: "access_denied" }) }

          expect(parentKey < 0n).toBe(childKey >= 0n)
          expect(yield* internal.deliver(forged).pipe(Effect.flip)).toMatchObject(denied)
          for (const intent of [
            { ...planner.ref, tenant: "another-tenant" },
            { ...planner.ref, actor: "MintSoloPlanner" },
            { ...planner.ref, id: "another-parent" },
          ])
            expect(yield* internal.deliver({ ...forged, intent }).pipe(Effect.flip)).toMatchObject(
              denied,
            )
          expect(
            yield* internal.execute({ ...forged, intent: planner.ref }).pipe(Effect.flip),
          ).toMatchObject(denied)
          expect(
            yield* internal
              .deliver({
                ...forged,
                intent: planner.ref,
                caller: proven(planner.ref, commandId, 1),
              })
              .pipe(Effect.flip),
          ).toMatchObject(denied)
          expect(yield* created(ref.actor, ref.id)).toBe(0)

          yield* test.crashNext("beforeOutboxDelete")
          const pause = yield* test.pauseNext("beforeOutboxDelete")
          yield* test.advance("1 minute")
          expect(yield* created(ref.actor, ref.id)).toBe(1)
          expect(yield* test.inspect(ref)).toMatchObject({
            state: { title: "across", opens: 1 },
            receipts: 1,
          })
          expect(yield* test.inspect(planner.ref)).toMatchObject({ outbox: 1 })

          const delivery = fixture.deliveries.get(ref.id)!
          expect(delivery.intent).toEqual(planner.ref)
          expect(yield* internal.execute(delivery).pipe(Effect.flip)).toMatchObject(denied)
          expect(
            yield* internal
              .execute({
                ...forged,
                commandId: yield* (yield* Actors).mintCommandId,
                caller: System.make({ source: "process" }),
                intent: planner.ref,
              })
              .pipe(Effect.flip),
          ).toMatchObject(denied)

          const draining = yield* test.advance(CLAIM_LEASE).pipe(Effect.forkChild)
          yield* pause.reached
          expect(yield* created(ref.actor, ref.id)).toBe(1)
          expect(yield* test.inspect(ref)).toMatchObject({
            state: { title: "across", opens: 1 },
            receipts: 1,
          })
          yield* pause.release
          yield* Fiber.join(draining)
          expect(yield* test.inspect(planner.ref)).toMatchObject({ outbox: 0 })

          expect(yield* internal.deliver(delivery)).toEqual(
            Outcome.cases.Success.make({ value: '{"value":null}' }),
          )
          expect(yield* created(ref.actor, ref.id)).toBe(1)
          expect(yield* test.inspect(ref)).toMatchObject({
            state: { title: "across", opens: 1 },
            receipts: 1,
          })
        }),
      ),
  },
  {
    name: "mints ids from the command id and ordinal and creates each child once from its intent",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const planner = yield* Planner.get("derive")
          const commandId = yield* (yield* Actors).mintCommandId
          const ids = yield* planner.Plan(2).pipe(Actor.commandId(commandId))

          expect(ids).toEqual([
            yield* expected(planner.ref, commandId, 0),
            yield* expected(planner.ref, commandId, 1),
          ])
          expect(new Set(ids).size).toBe(2)
          expect(yield* test.inspect(planner.ref)).toMatchObject({
            receipts: 1,
            outbox: 2,
          })
          yield* test.advance(0)

          for (const [index, id] of ids.entries()) {
            expect(yield* (yield* task(id)).Title()).toBe(`task ${index}`)
            expect(yield* created("MintTask", id)).toBe(1)
          }

          expect(yield* test.inspect(planner.ref)).toMatchObject({ outbox: 0 })
          expect(yield* planner.Plan(2).pipe(Actor.commandId(commandId))).toEqual(ids)
        }),
      ),
  },
  {
    name: "mints distinct ids per parent, per ordinal, and per child type from one command id",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const commandId = yield* (yield* Actors).mintCommandId
          const first = yield* Planner.get("distinct-a")
          const second = yield* Planner.get("distinct-b")
          const a = yield* first.PlanMixed().pipe(Actor.commandId(commandId))
          const b = yield* second.PlanMixed().pipe(Actor.commandId(commandId))

          expect(a).toEqual([
            yield* expected(first.ref, commandId, 0),
            yield* expected(first.ref, commandId, 1, "MintNote"),
          ])
          expect(new Set([...a, ...b]).size).toBe(4)
          yield* test.advance(0)
          expect(yield* (yield* task(a[0]!)).Title()).toBe("task")
          expect(yield* (yield* note(a[1]!)).Title()).toBe("note")
          expect(yield* (yield* note(b[1]!)).Title()).toBe("note")
        }),
      ),
  },
  {
    name: "mints the same ids when a beforeCommit crash reruns the command",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const planner = yield* Planner.get("crash-before")
          const before = runs.length
          yield* test.crashNext("beforeCommit")
          const ids = yield* planner.Plan(2)

          expect(runs.slice(before)).toEqual([ids, ids])
          yield* test.advance(0)

          for (const id of ids) expect(yield* created("MintTask", id)).toBe(1)
          expect(yield* test.inspect(planner.ref)).toMatchObject({
            receipts: 1,
            outbox: 0,
          })
        }),
      ),
  },
  {
    name: "replays minted ids after an afterCommit crash and creates each child once",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const planner = yield* Planner.get("crash-after")
          const commandId = yield* (yield* Actors).mintCommandId
          const before = runs.length
          yield* test.crashNext("afterCommit")
          const ids = yield* planner.Plan(2).pipe(Actor.commandId(commandId))

          expect(yield* planner.Plan(2).pipe(Actor.commandId(commandId))).toEqual(ids)
          expect(runs.slice(before)).toEqual([ids])
          yield* test.advance(0)

          for (const id of ids) expect(yield* created("MintTask", id)).toBe(1)
          expect(yield* test.inspect(planner.ref)).toMatchObject({
            receipts: 1,
            outbox: 0,
          })
        }),
      ),
  },
  {
    name: "mints per command when several commands wait at one parent",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const planner = yield* Planner.get("queued")
          const actors = yield* Actors
          const commandIds = [yield* actors.mintCommandId, yield* actors.mintCommandId]
          const pause = yield* test.pauseNext("beforeCommit")

          const first = yield* planner
            .Plan(1)
            .pipe(Actor.commandId(commandIds[0]!), Effect.forkChild)

          yield* pause.reached

          const second = yield* planner
            .Plan(1)
            .pipe(Actor.commandId(commandIds[1]!), Effect.forkChild)

          yield* pause.release

          expect(yield* Fiber.join(first)).toEqual([
            yield* expected(planner.ref, commandIds[0]!, 0),
          ])
          expect(yield* Fiber.join(second)).toEqual([
            yield* expected(planner.ref, commandIds[1]!, 0),
          ])
        }),
      ),
  },
  {
    name: "turn batch: commands that mint share one transaction, mint the ids each would mint alone, and a declared failure in the batch creates no child",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const actors = yield* Actors
          const planner = yield* Planner.get("batch-shared")

          const [lone, one, refused, two] = yield* Effect.forEach(
            Array.from({ length: 4 }),
            () => actors.mintCommandId,
          )

          const [loneChild, oneChild, rolledBack, twoChild] = yield* Effect.forEach(
            [lone!, one!, refused!, two!],
            (id) => expected(planner.ref, id, 0),
          )

          yield* test.advance(0)
          const before = runs.length
          const first = yield* holding(planner.PlanDelayed().pipe(Actor.commandId(lone!)))

          const [a, r, b] = yield* enqueue<Exit.Exit<unknown, unknown>, ActorTest | Actors>([
            planner.PlanDelayed().pipe(Actor.commandId(one!), Effect.exit),
            planner.PlanDelayedThenRefuse().pipe(Actor.commandId(refused!), Effect.exit),
            planner.PlanDelayed().pipe(Actor.commandId(two!), Effect.exit),
          ])

          yield* settle
          yield* first.release
          yield* Fiber.join(first.fiber)

          expect(yield* Fiber.join(a!)).toEqual(Exit.succeed([oneChild]))
          expect(yield* Fiber.join(r!)).toEqual(Exit.fail(Refused.make({})))
          expect(yield* Fiber.join(b!)).toEqual(Exit.succeed([twoChild]))

          const committed = yield* transactions(planner.ref)
          expect(new Set([one, refused, two].map((id) => committed.get(id!))).size).toBe(1)
          expect(committed.get(one!)).not.toBe(committed.get(lone!))

          expect(new Set([loneChild, oneChild, twoChild, rolledBack]).size).toBe(4)
          expect(new Set(runs.slice(before).flat())).toEqual(
            new Set([loneChild, oneChild, twoChild, rolledBack]),
          )
          expect(yield* test.inspect(planner.ref)).toMatchObject({ receipts: 4, outbox: 3 })

          const settled = runs.length
          expect(yield* planner.PlanDelayed().pipe(Actor.commandId(two!))).toEqual([twoChild])
          expect(runs.length).toBe(settled)

          yield* test.advance("1 hour")

          for (const id of [loneChild, oneChild, twoChild])
            expect(yield* created("MintTask", id!)).toBe(1)

          expect(yield* created("MintTask", rolledBack!)).toBe(0)
          expect(
            yield* openAs(rolledBack!, "rolled back", proven(planner.ref, refused!)),
          ).toMatchObject({ reason: Unauthorized.make({ code: "access_denied" }) })
          expect(yield* test.inspect(planner.ref)).toMatchObject({ outbox: 0 })
        }),
      ),
  },
  {
    name: "turn batch: a crash before the shared commit reruns each minting command alone with the same ids, and a crash after it replays them, each child created once",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const actors = yield* Actors
          const planner = yield* Planner.get("batch-crash")

          const [lone, between, ...ids] = yield* Effect.forEach(
            Array.from({ length: 8 }),
            () => actors.mintCommandId,
          )

          const derived = yield* Effect.forEach([lone!, between!, ...ids], (id) =>
            expected(planner.ref, id, 0),
          )

          const [loneChild, betweenChild] = derived
          const early = derived.slice(2, 5)
          const late = derived.slice(5)

          yield* test.advance(0)
          const before = runs.length
          const first = yield* holding(planner.PlanDelayed().pipe(Actor.commandId(lone!)))

          const beforeCrash = yield* enqueue(
            ids
              .slice(0, 3)
              .map((id) => planner.PlanDelayed().pipe(Actor.commandId(id), Effect.orDie)),
          )

          yield* settle
          yield* test.crashNext("beforeCommit")
          yield* first.release
          yield* Fiber.join(first.fiber)

          expect(yield* Effect.forEach(beforeCrash, Fiber.join)).toEqual(early.map((id) => [id]))

          const executions = (id: string) =>
            runs.slice(before).filter(([only]) => only === id).length

          expect(early.map(executions).some((count) => count > 1)).toBe(true)

          let committed = yield* transactions(planner.ref)
          expect(new Set(ids.slice(0, 3).map((id) => committed.get(id))).size).toBe(3)

          const second = yield* holding(planner.PlanDelayed().pipe(Actor.commandId(between!)))

          const afterCrash = yield* enqueue(
            ids.slice(3).map((id) => planner.PlanDelayed().pipe(Actor.commandId(id), Effect.orDie)),
          )

          yield* settle
          const shared = yield* test.pauseNext("beforeCommit")
          yield* second.release
          yield* Fiber.join(second.fiber)
          yield* shared.reached
          yield* test.crashNext("afterCommit")
          yield* shared.release

          expect(yield* Effect.forEach(afterCrash, Fiber.join)).toEqual(late.map((id) => [id]))
          expect(late.map(executions)).toEqual([1, 1, 1])

          committed = yield* transactions(planner.ref)
          expect(new Set(ids.slice(3).map((id) => committed.get(id))).size).toBe(1)

          const children = new Set([loneChild!, betweenChild!, ...early, ...late])
          expect(children.size).toBe(8)
          expect(new Set(runs.slice(before).flat())).toEqual(children)

          yield* test.advance("1 hour")

          for (const id of children) expect(yield* created("MintTask", id)).toBe(1)
          expect(yield* test.inspect(planner.ref)).toMatchObject({ receipts: 8, outbox: 0 })
        }),
      ),
  },
  {
    name: "creates no child from a declared failure, a defect, or a mint without a creating intent",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const planner = yield* Planner.get("rollback")
          const before = runs.length

          const refusedId = yield* (yield* Actors).mintCommandId

          expect(
            yield* planner.PlanThenRefuse().pipe(Actor.commandId(refusedId), Effect.flip),
          ).toBeInstanceOf(Refused)

          const rolledBack = yield* expected(planner.ref, refusedId, 0)

          expect(
            yield* openAs(rolledBack, "rolled back", proven(planner.ref, refusedId)),
          ).toMatchObject({ reason: Unauthorized.make({ code: "access_denied" }) })

          const died = yield* planner.PlanThenDie().pipe(Effect.exit)
          expect(Exit.isFailure(died) && Cause.pretty(died.cause)).toContain("Planner defect")

          const commandId = yield* (yield* Actors).mintCommandId
          const unstaged = yield* planner.MintOnly().pipe(Actor.commandId(commandId), Effect.exit)
          const orphan = yield* expected(planner.ref, commandId, 0)

          expect(Exit.isFailure(unstaged) && Cause.pretty(unstaged.cause)).toContain(
            `Minted actor MintTask/${orphan} has no creating intent`,
          )

          yield* test.advance(0)
          expect(yield* test.inspect(planner.ref)).toMatchObject({
            receipts: 1,
            outbox: 0,
          })

          for (const [id] of runs.slice(before)) expect(yield* created("MintTask", id!)).toBe(0)
        }),
      ),
  },
  {
    name: "refuses a proven creating call while its parent's turn has not committed",
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const planner = yield* Planner.get("uncommitted")
          const commandId = yield* (yield* Actors).mintCommandId
          const id = yield* expected(planner.ref, commandId, 0)
          const pause = yield* test.pauseNext("beforeCommit")
          const parent = yield* planner.Plan(1).pipe(Actor.commandId(commandId), Effect.forkChild)

          yield* pause.reached

          expect(yield* openAs(id, "early", proven(planner.ref, commandId))).toMatchObject({
            reason: Unauthorized.make({ code: "access_denied" }),
          })
          expect(yield* created("MintTask", id)).toBe(0)

          yield* pause.release
          expect(yield* Fiber.join(parent)).toEqual([id])
          yield* test.advance(0)

          expect(yield* created("MintTask", id)).toBe(1)
          expect(yield* (yield* task(id)).Title()).toBe("task 0")
          expect(yield* test.inspect(planner.ref)).toMatchObject({ outbox: 0 })
        }),
      ),
  },
  {
    name: "keeps a minted child uncreated when its creating turn fails with a declared error",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const planner = yield* Planner.get("child-refuses")
          const id = yield* planner.PlanRefusedChild()
          yield* test.advance(0)

          expect(yield* created("MintTask", id)).toBe(1)
          expect(yield* test.inspect(planner.ref)).toMatchObject({ receipts: 1, outbox: 0 })
          expect(yield* (yield* task(id)).Title().pipe(Effect.flip)).toMatchObject({
            reason: NotCreated.make({}),
          })
        }),
      ),
  },
  {
    name: "refuses a minted child's creating command without its parent's mint proof",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const planner = yield* Planner.get("forged")
          const other = yield* Planner.get("forged-other")
          const commandId = yield* (yield* Actors).mintCommandId
          const id = yield* planner.PlanLater().pipe(Actor.commandId(commandId))
          const child = yield* task(id)

          const denied = {
            reason: Unauthorized.make({ code: "access_denied" }),
          }

          expect(yield* child.Open("client").pipe(Effect.flip)).toMatchObject(denied)

          const forged = System.make({
            source: "actor",
            ref: other.ref,
            onBehalfOf: { subject: "alice" },
            mint: { commandId, ordinal: 0 },
          })

          const impostor = yield* task(id).pipe(Effect.provideService(CurrentCaller, forged))
          expect(yield* impostor.Open("impostor").pipe(Effect.flip)).toMatchObject(denied)

          const uncommitted = yield* (yield* Actors).mintCommandId

          expect(
            yield* openAs(
              yield* expected(planner.ref, uncommitted, 0),
              "never planned",
              proven(planner.ref, uncommitted),
            ),
          ).toMatchObject(denied)

          expect(yield* openAs(id, "proven early", proven(planner.ref, commandId))).toMatchObject(
            denied,
          )

          const sql = yield* SqlClient.SqlClient

          const [row] = yield* sql<{ intent_id: string; scheduled: string }>`
            SELECT intent_id, scheduled_at_ms::text AS scheduled FROM actor_outbox
            WHERE target_type = 'MintTask' AND target_id = ${id}`.pipe(Effect.orDie)

          const presented = yield* (yield* Actors).mintCommandId

          const move = (from: string, to: string, scheduled: string) =>
            sql`UPDATE actor_outbox SET intent_id = ${to}, scheduled_at_ms = ${scheduled}::bigint
              WHERE intent_id = ${from}`.pipe(Effect.orDie)

          yield* move(row!.intent_id, presented, "0")

          for (const title of ["later", "hijacked"])
            expect(
              yield* task(id).pipe(
                Actor.as(proven(planner.ref, commandId)),
                Effect.flatMap((forger) => forger.Open(title).pipe(Actor.commandId(presented))),
                Effect.flip,
              ),
            ).toMatchObject(denied)

          yield* move(presented, row!.intent_id, row!.scheduled)

          expect(yield* created("MintTask", id)).toBe(0)
          yield* test.advance("1 hour")
          expect(yield* child.Title()).toBe("later")
          expect(yield* created("MintTask", id)).toBe(1)
          yield* child.Open("reopened")
          expect(yield* child.Title()).toBe("reopened")
        }),
      ),
  },
  {
    name: "gives the proof to a creating intent staged before its child was minted",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const planner = yield* Planner.get("staged-first")
          const commandId = yield* (yield* Actors).mintCommandId
          const known = yield* expected(planner.ref, commandId, 0)

          expect(yield* planner.PlanStagedFirst(known).pipe(Actor.commandId(commandId))).toBe(known)
          yield* (yield* ActorTest).advance(0)
          expect(yield* (yield* task(known)).Title()).toBe("staged first")
          expect(yield* created("MintTask", known)).toBe(1)
        }),
      ),
  },
  {
    name: "mints from a singleton parent with an empty parent id",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const solo = yield* SoloPlanner.get()
          const commandId = yield* (yield* Actors).mintCommandId
          const id = yield* solo.SoloPlan().pipe(Actor.commandId(commandId))

          expect(id).toBe(yield* expected({ ...solo.ref, id: "" }, commandId, 0))
          yield* (yield* ActorTest).advance(0)
          expect(yield* (yield* task(id)).Title()).toBe("solo")
        }),
      ),
  },
  {
    name: "creates a named actor whose declared key is a UUIDv8 without a mint proof",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const planner = yield* Planner.get("named")
          const id = yield* expected(planner.ref, "named", 0)
          const job = yield* Job.get(id)
          yield* job.Open("named")
          expect(yield* job.Title()).toBe("named")
        }),
      ),
  },
  {
    name: "reaches a minted id on an unkeyed actor that no longer declares policy.createdBy",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const planner = yield* Planner.get("former")
          const id = yield* expected(planner.ref, "former", 0, "MintFormerChild")
          const child = yield* Former.get(id as Parameters<typeof Former.get>[0])
          yield* child.Open("kept")
          expect(yield* child.Title()).toBe("kept")
        }),
      ),
  },
  {
    name: "keeps create() children open to any authorized caller of the creating command",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const child = yield* Task.create()
          yield* child.Open("direct")
          expect(yield* child.Title()).toBe("direct")
        }),
      ),
  },
  {
    name: "rejects a mint capability that escaped its turn, a keyed creating intent, and an actor that cannot be minted",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const planner = yield* Planner.get("escape")
          yield* planner.Escape()

          const stolen = yield* planner.Steal().pipe(Effect.exit)
          expect(Exit.isFailure(stolen) && Cause.pretty(stolen.cause)).toContain(
            "Mint capability escaped its turn",
          )

          const keyed = yield* planner.PlanKeyed().pipe(Effect.exit)
          expect(Exit.isFailure(keyed) && Cause.pretty(keyed.cause)).toContain(
            `Minted actor MintTask/${runs.at(-1)![0]} has a keyed creating intent`,
          )
          expect(yield* (yield* ActorTest).inspect(planner.ref)).toMatchObject({ outbox: 0 })

          const unmintable = yield* planner.MintUnmintable().pipe(Effect.exit)
          expect(Exit.isFailure(unmintable) && Cause.pretty(unmintable.cause)).toContain(
            "turn.mint needs an unkeyed actor that declares createdBy",
          )
        }),
      ),
  },
]

/** Minted-id actors. */
export const mintSuite: ConformanceSuite<MintFixture> = {
  fixture: () => ({ deliveries: new Map(), onTurn: undefined }),
  layer: () => mintLayer,
  turn: (fixture) => (point, request) =>
    Effect.sync(() => {
      if (point === "afterClaim") fixture.deliveries.set(request.ref.id, request)
      fixture.onTurn?.(point, request)
    }),
}
