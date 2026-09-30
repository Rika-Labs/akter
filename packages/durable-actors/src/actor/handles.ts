import { Effect, Result, Schema, Semaphore, Stream } from "effect"
import { outsideTurn } from "../contexts/command.ts"
import { CallPhase, CurrentCallPhase } from "../contexts/workflow.ts"
import { ActorError, InvalidInput } from "../errors/actor.ts"
import { InvalidExecutionId } from "../errors/workflow.ts"
import { Actors } from "../handles/actors.ts"
import { currentStaging, stageIntent } from "../handles/intents.ts"
import { workflowRun } from "../handles/run.ts"
import {
  ExecutionIdOutput,
  ExecutionTarget,
  INTERRUPT,
  START,
  StartPayload,
} from "../handles/workflow.ts"
import { ActorRef, Caller, CurrentCaller, Tenant } from "../identity/caller.ts"
import { CurrentCommandId } from "../identity/command.ts"
import { CurrentConnectionCommands } from "../identity/connection.ts"
import { checkExecutionKey, decodeExecutionId, encodeExecutionId } from "../identity/execution.ts"
import type { AnyMember } from "../members/command.ts"
import { type AnyWorkflow, isWorkflow } from "../members/workflow.ts"
import { InternalActors } from "../runtime/actors.ts"
import type { WorkflowStatus } from "../runtime/members.ts"
import { Outcome, Request } from "../runtime/request.ts"
import type { Decoded, Failure } from "./codecs.ts"
import type { Descriptor } from "./descriptor.ts"

/** One method of a handle: a call returning an Effect, or a stream, before `Handle` types it. */
type HandleMethod = (
  payload: Decoded,
) => Effect.Effect<Decoded, Failure> | Stream.Stream<Decoded, Failure>

const decodeCaller = Schema.decodeEffect(Caller)

const encodeTarget = Schema.encodeEffect(ExecutionTarget)

const encodeStartPayload = Schema.encodeEffect(StartPayload)

const decodeExecutionIdOutput = Schema.decodeEffect(ExecutionIdOutput)

/** Workflow starts staged so far in each turn's staging, numbering keyless starts. */
const startCounts = new WeakMap<object, number>()

const isWatchable = (member: AnyMember) => "watch" in member && member.watch === true

const runOf = (
  descriptor: Descriptor,
  member: AnyWorkflow,
  ref: ActorRef,
  caller: Caller,
  executionId: string,
  execute: (request: Request) => Effect.Effect<Outcome, ActorError>,
  poll: (request: Request) => Effect.Effect<WorkflowStatus | undefined, ActorError>,
  mint: Effect.Effect<string, ActorError>,
) =>
  workflowRun({
    executionId,
    poll: poll(
      Request.make({ ref, caller, command: member.tag, commandId: "", payload: executionId }),
    ),
    interrupt: Effect.gen(function* () {
      const commandId = (yield* CurrentCommandId) ?? (yield* mint)

      const outcome = yield* execute(
        Request.make({
          ref,
          caller,
          command: INTERRUPT,
          commandId,
          payload: yield* encodeTarget({ executionId }).pipe(Effect.orDie),
        }),
      )

      if (Outcome.guards.Defect(outcome)) return yield* Effect.die(outcome.cause)
    }),
    decode: descriptor.workflowExits.get(member.tag)!.decode,
  })

/**
 * The methods of a request/reply handle to `id`, which reach `internal`
 * commands when `includeInternal` is set. Running a command method's Effect
 * mints its command id once and reuses it on every rerun, so a retry is
 * deduplicated by the receipt; a workflow step's call takes the step's id.
 * Handles never deliver subscriptions, so an acknowledged outcome is a defect.
 */
export const handleOf = Effect.fnUntraced(function* (
  descriptor: Descriptor,
  id: string,
  includeInternal: boolean,
  as?: Caller,
  tenant?: string,
): Effect.fn.Return<
  Readonly<Record<string, HandleMethod>> & { readonly ref: ActorRef },
  never,
  Actors | InternalActors
> {
  yield* outsideTurn
  const actors = yield* Actors
  const internalActors = yield* InternalActors
  const caller = yield* decodeCaller(as ?? (yield* CurrentCaller)).pipe(Effect.orDie)

  const ref = ActorRef.make({
    actor: descriptor.name,
    tenant: tenant ?? (yield* Tenant),
    id: descriptor.singleton ? "singleton" : yield* descriptor.decodeId(id).pipe(Effect.orDie),
  })

  const callable = Effect.gen(function* () {
    if (CallPhase.$is("Body")(yield* CurrentCallPhase))
      return yield* Effect.die(new Error("Actor call in a workflow body outside a step"))
  })

  const send = (request: Request) =>
    Effect.gen(function* () {
      if (CallPhase.$is("Activity")(yield* CurrentCallPhase))
        return yield* internalActors.deliver(request)

      return (yield* internalActors.execute(request)).outcome
    })

  const callId = (command: string) =>
    Effect.gen(function* () {
      const phase = yield* CurrentCallPhase

      if (CallPhase.$is("Activity")(phase)) return yield* phase.nextCommandId

      const explicit = yield* CurrentCommandId

      if (explicit !== undefined) return explicit
      const connectionCommands = yield* CurrentConnectionCommands

      return connectionCommands === undefined
        ? yield* actors.mintCommandId
        : yield* connectionCommands(`${ref.tenant}\u0000${ref.actor}\u0000${ref.id}`, command)
    })

  const callIdOnce = (command: string) => {
    const lock = Semaphore.makeUnsafe(1)
    let identity: string | undefined

    return lock.withPermit(
      Effect.gen(function* () {
        if (identity === undefined) identity = yield* callId(command)

        return identity
      }),
    )
  }

  const execute = (request: Request) =>
    Effect.map(internalActors.execute(request), (executed) => executed.outcome)

  const methods = Object.fromEntries(
    (includeInternal ? descriptor.members : Object.values(descriptor.api))
      .filter((member) => member.kind !== "connection")
      .map((member) => {
        const { encodePayload, decodeSuccess, decodeError } = descriptor.codecs.get(member.tag)!

        const decoded = <A>(
          elements: Stream.Stream<A, ActorError | { readonly failure: string }>,
          encoded: (element: A) => string,
        ) =>
          elements.pipe(
            Stream.mapEffect((element) =>
              Effect.map(decodeSuccess(encoded(element)).pipe(Effect.orDie), (out) => out.value),
            ),
            Stream.catch((error) =>
              Schema.is(ActorError)(error)
                ? Stream.fail(error)
                : Stream.fromEffect(
                    Effect.flatMap(decodeError(error.failure).pipe(Effect.orDie), Effect.fail),
                  ),
            ),
          )

        if (member.kind === "stream")
          return [
            member.tag,
            (input: Decoded) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  yield* outsideTurn
                  const payload = yield* encodePayload({ value: input }).pipe(Effect.orDie)

                  return decoded(
                    internalActors.subscribe(
                      Request.make({ ref, caller, command: member.tag, commandId: "", payload }),
                    ),
                    (value) => value,
                  )
                }),
              ),
          ]

        if (isWorkflow(member))
          return [
            member.tag,
            (input: Decoded) => {
              const identify = callIdOnce(member.tag)

              return Effect.gen(function* () {
                yield* outsideTurn
                yield* callable

                if (member.key !== undefined) yield* checkExecutionKey(member.key(input))
                const payload = yield* encodePayload({ value: input }).pipe(Effect.orDie)

                const outcome = yield* send(
                  Request.make({
                    ref,
                    caller,
                    command: member.tag,
                    commandId: yield* identify,
                    payload,
                  }),
                )

                if (!Outcome.guards.Success(outcome))
                  return yield* Effect.die(
                    Outcome.guards.Defect(outcome)
                      ? outcome.cause
                      : new Error("Workflow start failed"),
                  )

                const { value: executionId } = yield* decodeExecutionIdOutput(outcome.value).pipe(
                  Effect.orDie,
                )

                return runOf(
                  descriptor,
                  member,
                  ref,
                  caller,
                  executionId,
                  execute,
                  internalActors.pollWorkflow,
                  actors.mintCommandId,
                )
              })
            },
          ]

        const call = (input: Decoded) => {
          const identify = callIdOnce(member.tag)

          return Effect.gen(function* () {
            yield* outsideTurn

            if (member.kind !== "query") yield* callable

            const payload = yield* encodePayload({ value: input }).pipe(Effect.orDie)

            const outcome =
              member.kind === "query"
                ? yield* internalActors.query(
                    Request.make({ ref, caller, command: member.tag, commandId: "", payload }),
                    internalActors.observedVersion(),
                  )
                : yield* send(
                    Request.make({
                      ref,
                      caller,
                      command: member.tag,
                      commandId: yield* identify,
                      payload,
                    }),
                  )

            if (Outcome.guards.Defect(outcome)) return yield* Effect.die(outcome.cause)

            if (Outcome.guards.Failure(outcome))
              return yield* yield* decodeError(outcome.value).pipe(Effect.orDie)

            if (Outcome.guards.Acknowledged(outcome))
              return yield* Effect.die(new Error(`Unexpected ${outcome.reason} acknowledgement`))

            return (yield* decodeSuccess(outcome.value).pipe(Effect.orDie)).value
          })
        }

        if (!isWatchable(member)) return [member.tag, call]

        const watch = (input: Decoded) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* outsideTurn
              const payload = yield* encodePayload({ value: input }).pipe(Effect.orDie)

              const results = yield* internalActors.watch(
                Request.make({ ref, caller, command: member.tag, commandId: "", payload }),
                { minVersion: internalActors.observedVersion(), expiresAt: undefined },
              )

              return decoded(results, ({ value }) => value).pipe(
                Stream.catchIf(
                  (error) => Schema.is(ActorError)(error) && Schema.is(InvalidInput)(error.reason),
                  Stream.die,
                ),
              )
            }),
          )

        return [member.tag, Object.assign(call, { watch })]
      }),
  )

  return { ...methods, ref }
})

/**
 * Mints a new UUIDv7 id and returns its handle. Only an unkeyed actor that is
 * not parent-placed may be created by a caller; inside a turn it is a defect.
 */
export const createOf = (descriptor: Descriptor) =>
  Effect.gen(function* () {
    yield* outsideTurn

    if (!descriptor.minted)
      return yield* Effect.die(
        descriptor.parent === undefined
          ? new Error("Only minted actors use create()")
          : new Error(`${descriptor.name} is minted only by its parent ${descriptor.parent.name}`),
      )

    const internalActors = yield* InternalActors

    return yield* handleOf(descriptor, yield* internalActors.mintActorId, false)
  })

/**
 * Durable intents to actor `id`, staged in the current command turn. The
 * target shares the sending turn's tenant. A keyless workflow start is keyed
 * by the turn's command id and its order among the turn's starts, so a
 * retried turn restages the same executions. Commands that subscriptions
 * deliver to are left out.
 */
export const intentsOf = Effect.fnUntraced(function* (descriptor: Descriptor, id: string) {
  const { marker, staging } = yield* currentStaging()

  const target = ActorRef.make({
    actor: descriptor.name,
    tenant: staging.sender.tenant,
    id: descriptor.singleton ? "singleton" : yield* descriptor.decodeId(id).pipe(Effect.orDie),
  })

  const methods = Object.fromEntries(
    descriptor.commands.flatMap((member) => {
      if (descriptor.handlerTags.has(member.tag)) return []

      const { encodePayload } = descriptor.codecs.get(member.tag)!

      return [
        [
          member.tag,
          (input: Decoded) =>
            Effect.gen(function* () {
              const payload = yield* encodePayload({ value: input }).pipe(Effect.orDie)

              yield* stageIntent(marker, { target, command: member.tag, payload })
            }),
        ] as const,
      ]
    }),
  )

  const starts = Object.fromEntries(
    descriptor.workflows.map((member) => {
      const { encodePayload } = descriptor.codecs.get(member.tag)!

      return [
        member.tag,
        (input: Decoded) =>
          Effect.gen(function* () {
            const { staging: current } = yield* currentStaging(marker)
            const payload = yield* encodePayload({ value: input }).pipe(Effect.orDie)
            const ordinal = (startCounts.get(current) ?? 0) + 1

            startCounts.set(current, ordinal)

            const key =
              member.key === undefined ? `${current.commandId}:${ordinal}` : member.key(input)

            const executionId = yield* encodeExecutionId({
              tenant: target.tenant,
              actor: target.actor,
              id: target.id,
              workflow: member.tag,
              key,
            }).pipe(Effect.orDie)

            const own = current.sender.actor === target.actor && current.sender.id === target.id

            yield* stageIntent(marker, {
              target,
              command: START,
              payload: yield* encodeStartPayload({
                workflow: member.tag,
                input: payload,
                key,
                after: own ? current.head : null,
              }).pipe(Effect.orDie),
            })

            return executionId
          }),
      ]
    }),
  )

  return { ...methods, ...starts, ref: target }
})

/**
 * Reattaches to a workflow execution by id without contacting its owner. An
 * id of another tenant, actor type, or workflow fails `InvalidExecutionId`.
 */
export const runOfId = Effect.fnUntraced(function* (
  descriptor: Descriptor,
  member: AnyWorkflow,
  executionId: string,
) {
  yield* outsideTurn
  const actors = yield* Actors
  const internalActors = yield* InternalActors
  const caller = yield* decodeCaller(yield* CurrentCaller).pipe(Effect.orDie)
  const tenant = yield* Tenant
  const invalid = InvalidExecutionId.make({ executionId })
  const execution = yield* decodeExecutionId(executionId)

  if (
    execution.tenant !== tenant ||
    execution.actor !== descriptor.name ||
    execution.workflow !== member.tag ||
    !descriptor.workflows.includes(member)
  )
    return yield* invalid

  const id = descriptor.singleton ? "singleton" : execution.id

  if (!descriptor.singleton && Result.isFailure(Schema.decodeResult(descriptor.idSchema)(id)))
    return yield* invalid

  return runOf(
    descriptor,
    member,
    ActorRef.make({ actor: descriptor.name, tenant, id }),
    caller,
    executionId,
    (request) => Effect.map(internalActors.execute(request), (executed) => executed.outcome),
    internalActors.pollWorkflow,
    actors.mintCommandId,
  )
})
