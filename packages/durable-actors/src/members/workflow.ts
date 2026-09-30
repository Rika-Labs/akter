import type { Duration, Effect, Option, Schema } from "effect"
import type { StepIdentity } from "../contexts/workflow.ts"
import type { DeclaredError, Member, ValueSchema } from "./command.ts"
import type { EventClass } from "./event.ts"

/** A version marker's supported range: new executions record `current`, and executions that recorded `min` or later still replay; `ctx.version(name)` reads the recorded value. */
export interface VersionRange {
  readonly current: number
  readonly min: number
}

/** One constructor as the manifest records it. */
export interface StepEntry {
  readonly name: string
  readonly kind: StepIdentity["kind"]
  readonly schemas: ReadonlyArray<ValueSchema>
  /** The event tag a wait observes. */
  readonly event?: string
}

/** A workflow's module-level constructors, registered in declaration order. */
export interface StepRegistry {
  readonly steps: Map<string, StepEntry>
}

/** A method signature, so a workflow with a specific payload is still an `AnyWorkflow`. */
interface KeyFunction<Payload extends ValueSchema> {
  key(payload: Payload["Type"]): string
}

type KeyOf<Payload extends ValueSchema> = KeyFunction<Payload>["key"]

/**
 * A durable workflow member: a body the runtime replays from recorded steps.
 * Its constructors (`step`, `sleep`, `wait`, `race`) are created at module
 * level, and each records its result once per execution.
 */
export interface Workflow<
  Tag extends string,
  Payload extends ValueSchema,
  Success extends ValueSchema,
  Error extends DeclaredError,
> extends Member<"workflow", Tag, Payload, Success, Error> {
  /** The execution key; the start's command id when omitted. */
  readonly key: KeyOf<Payload> | undefined
  /** Version markers by name, for branching the body on how an old execution started. */
  readonly versions: Readonly<Record<string, VersionRange>>
  /** The constructors created on this workflow, so the layer can check that a body uses only declared steps. */
  readonly registry: StepRegistry
  /** An activity: `run(payload, execute)` records `execute`'s exit once per execution. */
  readonly step: <
    const Name extends string,
    P extends ValueSchema = Schema.Void,
    S extends ValueSchema = Schema.Void,
    E extends DeclaredError = Schema.Never,
  >(
    name: Name,
    options?: { readonly payload?: P; readonly success?: S; readonly error?: E },
  ) => Step<Name, P, S, E>
  /** A durable clock: calling it with a duration sleeps across restarts. */
  readonly sleep: <const Name extends string>(name: Name) => Sleep<Name>
  /** An owner-event wait: the first matching event after the execution's cursor. */
  readonly wait: <const Name extends string, Ev extends EventClass>(
    name: Name,
    event: Ev,
  ) => Wait<Name, Ev>
  /** The first of several effects to succeed, recorded so a replay returns the same winner. */
  readonly race: <
    const Name extends string,
    S extends ValueSchema,
    E extends DeclaredError = Schema.Never,
  >(
    name: Name,
    options: { readonly success: S; readonly error?: E },
  ) => Race<Name, S, E>
}

/** Any workflow, whatever its schemas. */
export type AnyWorkflow = Workflow<string, ValueSchema, ValueSchema, DeclaredError>

/** An activity constructor: `run` executes once per execution and replays its recorded exit afterwards. */
export interface Step<
  Name extends string,
  P extends ValueSchema,
  S extends ValueSchema,
  E extends DeclaredError,
> {
  readonly name: Name
  readonly kind: "activity"
  readonly run: <R>(
    payload: P["Type"],
    execute: (payload: P["Type"]) => Effect.Effect<S["Type"], E["Type"], R>,
  ) => Effect.Effect<S["Type"], E["Type"], R>
}

/** A durable clock: calling it with a duration sleeps across restarts. */
export interface Sleep<Name extends string> {
  (duration: Duration.Input): Effect.Effect<void>
  readonly stepName: Name
  readonly kind: "clock"
}

/**
 * An owner-event wait: resolves with the first matching event after the
 * execution's cursor, or none on timeout. A matched event is recorded as the
 * event class's current version encodes it.
 */
export interface Wait<Name extends string, Ev extends EventClass> {
  (options?: {
    readonly where?: (event: Ev["Type"]) => boolean
    readonly timeout?: Duration.Input
  }): Effect.Effect<Option.Option<Ev["Type"]>>
  readonly stepName: Name
  readonly kind: "wait"
}

/**
 * A recorded race of effects: the first to succeed wins, and a replay returns
 * the same winner. Only a winner or a declared failure is recorded; a
 * suspension, defect, or interruption leaves the race to run again on replay.
 */
export interface Race<Name extends string, S extends ValueSchema, E extends DeclaredError> {
  readonly name: Name
  readonly kind: "deferred"
  readonly run: <R>(
    effects: ReadonlyArray<Effect.Effect<S["Type"], E["Type"], R>>,
  ) => Effect.Effect<S["Type"], E["Type"], R>
}

/** Whether a member is a workflow. */
export const isWorkflow = (member: { readonly kind: string }): member is AnyWorkflow =>
  member.kind === "workflow"
