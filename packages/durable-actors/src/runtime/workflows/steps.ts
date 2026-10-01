import { Cause, Duration, Effect, Exit, Option, Schema } from "effect"
import { CurrentWorkflow, RecordedExit, type StepIdentity } from "../../contexts/workflow.ts"
import type { DeclaredError, ValueSchema } from "../../members/command.ts"
import type { EventClass } from "../../members/event.ts"
import { payloadCodec } from "../../members/payload.ts"
import type {
  Race,
  Sleep,
  Step,
  StepEntry,
  StepRegistry,
  VersionRange,
  Wait,
  Workflow,
} from "../../members/workflow.ts"

type Fields = Readonly<Record<string, ValueSchema>>

const WORKFLOW_TAG = /^[A-Za-z][A-Za-z0-9]{0,79}$/

const STEP_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const engine = Effect.gen(function* () {
  const steps = yield* CurrentWorkflow

  if (steps === undefined)
    return yield* Effect.die(new Error("Workflow step outside a workflow body"))

  return steps
})

/** Encodes a step's exit with its own schemas, and decodes a recorded one back. */
export const exitCodec = <S extends ValueSchema, E extends DeclaredError>({
  success,
  error: errorSchema,
}: {
  readonly success: S
  readonly error: E
}) => {
  const value = Schema.toCodecJson(success)
  const error = Schema.toCodecJson(errorSchema)
  const isError = Schema.is(errorSchema)

  type Recorded = Exit.Exit<S["Type"], E["Type"]>

  const encode = (exit: Exit.Exit<S["Type"], unknown>): Effect.Effect<RecordedExit> => {
    if (Exit.isSuccess(exit))
      return Schema.encodeEffect(value)(exit.value).pipe(
        Effect.map((encoded) => RecordedExit.cases.Success.make({ value: encoded })),
        Effect.orDie,
      )

    const failure = Cause.findErrorOption(exit.cause)

    if (Option.isSome(failure) && isError(failure.value))
      return Schema.encodeEffect(error)(failure.value).pipe(
        Effect.map((encoded) => RecordedExit.cases.Failure.make({ error: encoded })),
        Effect.orDie,
      )

    return Effect.succeed(RecordedExit.cases.Die.make({ message: Cause.pretty(exit.cause) }))
  }

  /** The recorded exit; a recorded defect is a defect again. */
  const decode = (recorded: RecordedExit): Effect.Effect<Recorded> =>
    RecordedExit.match(recorded, {
      Success: ({ value: encoded }) =>
        Schema.decodeEffect(value)(encoded).pipe(
          Effect.orDie,
          Effect.map((ok): Recorded => Exit.succeed(ok)),
        ),
      Failure: ({ error: encoded }) =>
        Schema.decodeEffect(error)(encoded).pipe(
          Effect.orDie,
          Effect.map((failed): Recorded => Exit.fail(failed)),
        ),
      Die: ({ message }): Effect.Effect<Recorded> => Effect.succeed(Exit.die(new Error(message))),
    })

  return { encode, decode }
}

const make = <
  const Tag extends string,
  const PayloadFields extends Fields = {},
  Success extends ValueSchema = Schema.Void,
  Error extends DeclaredError = Schema.Never,
>(
  tag: Tag,
  options: {
    readonly payload?: PayloadFields
    readonly success?: Success
    readonly error?: Error
    readonly key?: (payload: Schema.Struct<PayloadFields>["Type"]) => string
    readonly versions?: Readonly<Record<string, VersionRange>>
  } = {},
): Workflow<Tag, Schema.Struct<PayloadFields>, Success, Error> => {
  if (!WORKFLOW_TAG.test(tag)) throw new Error(`Invalid workflow name: ${tag}`)
  const versions = options.versions ?? {}

  for (const [name, range] of Object.entries(versions))
    if (
      !STEP_NAME.test(name) ||
      !Number.isInteger(range.min) ||
      !Number.isInteger(range.current) ||
      range.min < 0 ||
      range.current < 1 ||
      range.min > range.current
    )
      throw new Error(
        `Workflow ${tag} version ${name} needs integers 0 <= min <= current, current >= 1`,
      )

  const registry: StepRegistry = { steps: new Map() }

  const identity = (name: string, kind: StepIdentity["kind"]): StepIdentity => ({
    workflow: tag,
    name,
    kind,
  })

  const register = (entry: StepEntry) => {
    if (!STEP_NAME.test(entry.name)) throw new Error(`Invalid step name: ${entry.name}`)

    if (registry.steps.has(entry.name))
      throw new Error(`Workflow ${tag} already has a step named ${entry.name}`)
    registry.steps.set(entry.name, entry)
  }

  const step = <
    const Name extends string,
    P extends ValueSchema = Schema.Void,
    S extends ValueSchema = Schema.Void,
    E extends DeclaredError = Schema.Never,
  >(
    name: Name,
    stepOptions?: { readonly payload?: P; readonly success?: S; readonly error?: E },
  ): Step<Name, P, S, E> => {
    const payload = (stepOptions?.payload ?? Schema.Void) as P
    const success = (stepOptions?.success ?? Schema.Void) as S
    const error = (stepOptions?.error ?? Schema.Never) as E

    register({ name, kind: "activity", payload, result: [success, error] })
    const codec = exitCodec({ success, error })
    const decodePayload = Schema.decodeUnknownEffect(payload)
    const self = identity(name, "activity")

    return {
      name,
      kind: "activity",
      run: (value, execute) =>
        Effect.gen(function* () {
          const steps = yield* engine

          const run = Effect.suspend(() => decodePayload(value).pipe(Effect.orDie)).pipe(
            Effect.flatMap((decoded) => execute(decoded)),
            Effect.exit,
            Effect.flatMap(codec.encode),
          )

          return yield* steps.activity(self, run).pipe(Effect.flatMap(codec.decode), Effect.flatten)
        }),
    }
  }

  const sleep = <const Name extends string>(name: Name): Sleep<Name> => {
    register({ name, kind: "clock", result: [] })
    const self = identity(name, "clock")

    const call = (duration: Duration.Input) =>
      Effect.gen(function* () {
        const millis = Duration.toMillis(Duration.fromInputUnsafe(duration))

        if (!Number.isFinite(millis) || millis < 0)
          return yield* Effect.die(new Error(`Sleep ${name} needs a finite, non-negative duration`))

        return yield* (yield* engine).sleep(self, Math.ceil(millis))
      })

    return Object.assign(call, { stepName: name, kind: "clock" as const })
  }

  const wait = <const Name extends string, Ev extends EventClass>(
    name: Name,
    event: Ev,
  ): Wait<Name, Ev> => {
    register({ name, kind: "wait", result: [event], event: event.identifier })
    const self = identity(name, "wait")
    const codec = payloadCodec({ schema: event, tag: event.identifier })

    const call = (waitOptions?: {
      readonly where?: (event: Ev["Type"]) => boolean
      readonly timeout?: Duration.Input
    }) =>
      Effect.gen(function* () {
        const timeoutMs =
          waitOptions?.timeout === undefined
            ? undefined
            : Math.ceil(Duration.toMillis(Duration.fromInputUnsafe(waitOptions.timeout)))

        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0))
          return yield* Effect.die(new Error(`Wait ${name} needs a finite, non-negative timeout`))

        const where = waitOptions?.where

        const matched = yield* (yield* engine).wait(
          self,
          event.identifier,
          (value, version) =>
            codec.decode(value, version).pipe(
              Effect.flatMap((decoded) =>
                where === undefined || where(decoded as Ev["Type"])
                  ? Effect.asSome(codec.upcast(value, version))
                  : Effect.succeedNone,
              ),
              Effect.orDie,
            ),
          timeoutMs,
        )

        if (Option.isNone(matched)) return Option.none<Ev["Type"]>()

        return Option.some(
          (yield* codec
            .decode(matched.value, codec.chain.current)
            .pipe(Effect.orDie)) as Ev["Type"],
        )
      })

    return Object.assign(call, { stepName: name, kind: "wait" as const })
  }

  const race = <
    const Name extends string,
    S extends ValueSchema,
    E extends DeclaredError = Schema.Never,
  >(
    name: Name,
    raceOptions: { readonly success: S; readonly error?: E },
  ): Race<Name, S, E> => {
    const error = (raceOptions.error ?? Schema.Never) as E

    register({ name, kind: "deferred", result: [raceOptions.success, error] })
    const codec = exitCodec({ success: raceOptions.success, error })
    const self = identity(name, "deferred")

    return {
      name,
      kind: "deferred",
      run: (effects) =>
        Effect.gen(function* () {
          const steps = yield* engine

          if (effects.length === 0)
            return yield* Effect.die(new Error(`Race ${name} needs at least one effect`))

          const run = Effect.raceAll(effects).pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Exit.isFailure(exit) && (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
                ? Effect.failCause(exit.cause).pipe(Effect.orDie)
                : codec.encode(exit),
            ),
          )

          return yield* steps.race(self, run).pipe(Effect.flatMap(codec.decode), Effect.flatten)
        }),
    }
  }

  return {
    kind: "workflow",
    tag,
    payload: Schema.Struct(options.payload ?? ({} as PayloadFields)),
    success: (options.success ?? Schema.Void) as Success,
    error: (options.error ?? Schema.Never) as Error,
    key: options.key,
    versions,
    registry,
    step,
    sleep,
    wait,
    race,
  }
}

/**
 * `WorkflowMember.make` is `Actor.workflow`: declares a workflow by tag.
 * `key` derives the execution key from the payload (the start's command id when
 * omitted), and `versions` marks code changes that old executions must not see.
 * Throws on an invalid tag or version range.
 *
 * @example
 * const Checkout = Actor.workflow("Checkout", { payload: { orderId: Schema.String } })
 */
export const WorkflowMember = { make }
