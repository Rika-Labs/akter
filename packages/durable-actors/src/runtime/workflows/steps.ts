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
export const exitCodec = <S extends ValueSchema, E extends ReadonlyArray<DeclaredError>>({
  success,
  errors,
}: {
  readonly success: S
  readonly errors: E
}) => {
  const value = Schema.toCodecJson(success)
  const error = Schema.toCodecJson(Schema.Union(errors))
  const isError = Schema.is(Schema.Union(errors))

  type Recorded = Exit.Exit<S["Type"], E[number]["Type"]>

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

const noErrors: readonly [] = []

const make = <
  const Tag extends string,
  const InputFields extends Fields = {},
  Output extends ValueSchema = Schema.Void,
  const Errors extends ReadonlyArray<DeclaredError> = readonly [],
>(
  tag: Tag,
  options: {
    readonly input?: InputFields
    readonly output?: Output
    readonly errors?: Errors
    readonly key?: (input: Schema.Struct<InputFields>["Type"]) => string
    readonly versions?: Readonly<Record<string, VersionRange>>
  } = {},
): Workflow<Tag, Schema.Struct<InputFields>, Output, Errors> => {
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
    I extends ValueSchema = Schema.Void,
    S extends ValueSchema = Schema.Void,
    const E extends ReadonlyArray<DeclaredError> = readonly [],
  >(
    name: Name,
    stepOptions?: { readonly input?: I; readonly success?: S; readonly errors?: E },
  ): Step<Name, I, S, E> => {
    const input = (stepOptions?.input ?? Schema.Void) as I
    const success = (stepOptions?.success ?? Schema.Void) as S
    const errors = stepOptions?.errors ?? (noErrors as never)

    register({ name, kind: "activity", schemas: [input, success, ...errors] })
    const codec = exitCodec({ success, errors })
    const decodeInput = Schema.decodeUnknownEffect(input)
    const self = identity(name, "activity")

    return {
      name,
      kind: "activity",
      run: (value, execute) =>
        Effect.gen(function* () {
          const steps = yield* engine

          const run = Effect.suspend(() => decodeInput(value).pipe(Effect.orDie)).pipe(
            Effect.flatMap((decoded) => execute(decoded)),
            Effect.exit,
            Effect.flatMap(codec.encode),
          )

          return yield* steps.activity(self, run).pipe(Effect.flatMap(codec.decode), Effect.flatten)
        }),
    }
  }

  const sleep = <const Name extends string>(name: Name): Sleep<Name> => {
    register({ name, kind: "clock", schemas: [] })
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
    register({ name, kind: "wait", schemas: [event], event: event.identifier })
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
    const E extends ReadonlyArray<DeclaredError> = readonly [],
  >(
    name: Name,
    raceOptions: { readonly success: S; readonly errors?: E },
  ): Race<Name, S, E> => {
    const errors = raceOptions.errors ?? (noErrors as never)

    register({ name, kind: "deferred", schemas: [raceOptions.success, ...errors] })
    const codec = exitCodec({ success: raceOptions.success, errors })
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
    input: Schema.Struct(options.input ?? ({} as InputFields)),
    output: (options.output ?? Schema.Void) as Output,
    errors: options.errors ?? (noErrors as never),
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
 * `key` derives the execution key from the input (the start's command id when
 * omitted), and `versions` marks code changes that old executions must not see.
 * Throws on an invalid tag or version range.
 *
 * @example
 * const Checkout = Actor.workflow("Checkout", { input: { orderId: Schema.String } })
 */
export const WorkflowMember = { make }
