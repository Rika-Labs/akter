import { Context, Duration, Effect, Layer, Predicate, Schema } from "effect"
import { System } from "../contract/caller.ts"
import type { Args, CallerFor, FullState, When } from "../contract/context.ts"
import type { DefectKind } from "../contract/errors.ts"
import type { AnyActor, Def, DefOf } from "../contract/make.ts"
import type { Command, Job, View } from "../contract/members.ts"
import { Lists } from "../handlers/lists.ts"
import type { AnyHandler, ImplementationOf } from "../handlers/registry.ts"
import { Actions } from "../execution/action.ts"
import { Durable } from "../execution/durable.ts"
import { Outcome } from "../execution/entries.ts"
import type { Emit, ListWrite, Send, Start, Timer } from "../execution/entries.ts"
import { Layouts } from "../execution/layout.ts"
import type { Codec, Decoded, Image, Layout } from "../execution/layout.ts"

/** A story's expectation was not met; the message names the actor, the step and what differed. */
export class StoryFailure extends Schema.TaggedError<StoryFailure>()("StoryFailure", {
  actor: Schema.String,
  step: Schema.Int,
  label: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Story ${this.actor}, step ${this.step} (${this.label}): ${this.detail}`
  }
}

type CommandsOf<X extends AnyActor> = DefOf<X>["commands"]
type ViewsOf<X extends AnyActor> = DefOf<X>["views"]
type JobsOf<X extends AnyActor> = DefOf<X>["jobs"]
type BroadcastsOf<X extends AnyActor> = DefOf<X>["broadcasts"]
type FieldsOf<X extends AnyActor> = DefOf<X>["state"]["fields"]
type KeyOf<X extends AnyActor> = DefOf<X>["key"]["Type"]
type Reply<C extends Command> = C["success"] extends Schema.Top ? C["success"]["Type"] : undefined
type Failure<C extends Command> = C["fails"] extends Schema.Top ? C["fails"]["Type"] : never

/** Every reply a command of `X` can return. */
export type ReplyOf<X extends AnyActor> = {
  [M in keyof CommandsOf<X>]: Reply<CommandsOf<X>[M]>
}[keyof CommandsOf<X>]

/** Every declared failure a command of `X` can return. */
export type FailureOf<X extends AnyActor> = {
  [M in keyof CommandsOf<X>]: Failure<CommandsOf<X>[M]>
}[keyof CommandsOf<X>]

/** State a story starts from: any scalar fields, and each list as its items. */
export type Given<X extends AnyActor> = Partial<FullState<FieldsOf<X>>>

/**
 * How one command runs. `caller` defaults to `System({ source: "process", subject: "process" })`,
 * the caller `Simulation` uses; `now` defaults to `0`. `id` and `random` are the values `ctx.id()`
 * and `ctx.random()` return, in order, and drawing more than supplied fails the story; without
 * them a handler draws the engine's values derived from the story's command id `story/<n>`, where
 * `n` counts the story's commands from 0.
 */
export interface CommandOptions<C> {
  readonly caller?: C
  readonly now?: number
  readonly id?: ReadonlyArray<string>
  readonly random?: ReadonlyArray<number>
}

/** The arguments of `Story.command` for command `C`: its payload, when it has one, then options. */
export type CommandArgs<D extends Def, C extends Command> = [
  ...Args<C["payload"]>,
  options?: CommandOptions<CallerFor<D, C>>,
]

/** The last command a story ran: its outcome and the staged work no expectation has matched yet. */
interface Last {
  readonly member: string
  readonly declaration: Command
  readonly at: number
  readonly outcome: Outcome
  readonly sends: Array<Send>
  readonly timers: Array<Timer>
  readonly starts: Array<Start>
  readonly events: Array<Emit>
  settled: boolean
}

/** One running story: the actor, its handlers, the instance it plays and its image so far. */
interface Running {
  readonly actor: AnyActor
  readonly layout: Layout
  readonly handlers: ReadonlyMap<string, AnyHandler>
  self: Decoded
  image: Image
  commands: number
  last: Last | undefined
}

/**
 * One step of a story over actor `X`. The phantom `~actor` keeps steps of one actor out of
 * another actor's story.
 */
export interface Step<X extends AnyActor> {
  readonly label: string
  readonly "~actor"?: (actor: X) => X
  readonly apply: (story: Running) => void
}

/** An unmet expectation inside a step; `run` adds the actor, step number and label. */
class Problem {
  readonly detail: string
  constructor(detail: string) {
    this.detail = detail
  }
}

/** Thrown inside a handler that drew more ids or randoms than its command supplied. */
class Exhausted {}

const fail = (detail: string): never => {
  throw new Problem(detail)
}

const describe = (thrown: Decoded): string =>
  thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)

/** JSON with object keys sorted, so two encodings compare equal whatever order built them. */
const canonical = (value: Schema.Json | undefined): string =>
  JSON.stringify(value, (_, nested: Decoded) =>
    Predicate.isObject(nested) && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : nested,
  )

const encode = (codec: Codec, value: Decoded, what: string): Schema.Json => {
  try {
    return codec.encode(value)
  } catch (thrown) {
    return fail(`${what} does not match its schema: ${describe(thrown)}`)
  }
}

const step = <X extends AnyActor>(label: string, apply: (story: Running) => void): Step<X> => ({
  label,
  apply,
})

const outcomeText = (outcome: Outcome): string =>
  Outcome.match(outcome, {
    Success: ({ value }) => `reply ${canonical(value)}`,
    Failure: ({ error }) => `failure ${canonical(error)}`,
    Defect: ({ kind, detail }) => `defect ${kind}: ${detail}`,
  })

const stagedText = (last: Last): string => {
  const staged = [
    ...last.sends.map(
      (send) =>
        `send ${send.actor}(${canonical(send.key)}).${send.member}(${canonical(send.payload)})`,
    ),
    ...last.timers.map(
      (timer) => `timer ${timer.member}(${canonical(timer.payload)}) at ${timer.at}`,
    ),
    ...last.starts.map(
      (start) =>
        `start ${start.job}(${canonical(start.payload)})${start.key === undefined ? "" : ` key ${start.key}`}`,
    ),
    ...last.events.map((event) => `broadcast ${event.event} ${canonical(event.value)}`),
  ]
  if (staged.length > 0) return `unmatched staged work: ${staged.join("; ")}`
  return Outcome.guards.Success(last.outcome)
    ? "no unmatched staged work remains"
    : `nothing was staged: \`${last.member}\` ended in ${outcomeText(last.outcome)}, which discards staged work`
}

const lastOf = (story: Running): Last =>
  story.last ?? fail("no command has run yet; add a Story.command step first")

/** A failure or defect no step expected fails the story before the next command and at the end. */
const settle = (story: Running): void => {
  const last = story.last
  if (last === undefined || last.settled) return
  fail(
    `\`${last.member}\` ended in ${outcomeText(last.outcome)}; expect it with ${Outcome.guards.Failure(last.outcome) ? "Story.expectFailure" : "Story.expectDefect"}`,
  )
}

/** Takes the first staged item `matches` accepts, so a repeated item needs a repeated expectation. */
const take = <A>(
  last: Last,
  items: Array<A>,
  matches: (item: A) => boolean,
  wanted: string,
): void => {
  const index = items.findIndex(matches)
  if (index === -1) fail(`expected ${wanted}; ${stagedText(last)}`)
  items.splice(index, 1)
}

const isInstant = (when: When): when is { readonly at: number } => Predicate.hasProperty(when, "at")

const addressOf = (story: Running): string =>
  Durable.addressOf(story.actor.name, encode(story.layout.key, story.self, "the story's self id"))

const fullState = (story: Running): Decoded => {
  const full = { ...story.image.state }
  for (const [name, list] of story.layout.lists)
    full[name] = Lists.all(story.image.lists.get(name) ?? Lists.empty, list.ordering)
  return full
}

/**
 * Sets the state the next steps start from, as an operator's seed would: each named scalar field
 * is replaced, an `undefined` optional field is removed and each named list holds exactly the
 * given items. `self` is the instance id handlers see as `ctx.self`; it defaults to `"story"`.
 */
const given = <X extends AnyActor>(
  state: Given<X>,
  options?: { readonly self?: KeyOf<X> },
): Step<X> =>
  step("given", (story) => {
    if (options?.self !== undefined) story.self = options.self
    const set: Record<string, Schema.Json> = {}
    const unset: Array<string> = []
    const writes: Array<ListWrite> = []
    for (const [name, value] of Object.entries<Decoded>(state)) {
      const field = story.layout.fields.get(name)
      if (field !== undefined) {
        if (value === undefined) unset.push(name)
        else set[name] = encode(field, value, `state field '${name}'`)
        continue
      }
      const list = story.layout.lists.get(name)
      if (list === undefined) return fail(`'${name}' is not a state field of ${story.actor.name}`)
      const items: ReadonlyArray<Decoded> = value
      const keys = new Set(items.map((item) => canonical(item[list.ordering.key])))
      writes.push({
        field: name,
        put: items.map((item) => encode(list.item, item, `an item of list '${name}'`)),
        delete: Lists.all(story.image.lists.get(name) ?? Lists.empty, list.ordering)
          .map((item) => item[list.ordering.key])
          .filter((key) => !keys.has(canonical(key))),
      })
    }
    story.image = Actions.apply(story.actor, story.image, set, unset, writes)
  })

/**
 * Runs one command handler, public or internal, through the engine's own action runner: a
 * declared failure, a throw or a thenable result discards the draft and every staged effect, and
 * later steps see the state after the command. A job's result reaches its actor this way, by
 * running the internal command the job's result is delivered to.
 */
const command = <X extends AnyActor, const M extends keyof CommandsOf<X> & string>(
  member: M,
  ...args: CommandArgs<DefOf<X>, CommandsOf<X>[M]>
): Step<X> =>
  step(`command ${member}`, (story) => {
    settle(story)
    const { actor } = story
    const declaration: Command | undefined = actor.commands[member]
    const handler = story.handlers.get(member)
    if (declaration === undefined || handler === undefined)
      return fail(`'${member}' is not a command of ${actor.name}`)
    const [payload, options]: [Decoded, CommandOptions<Decoded> | undefined] =
      declaration.payload === undefined ? [undefined, args[0]] : [args[0], args[1]]
    const codec = Layouts.codec(declaration.payload)
    const decoded = codec.decode(encode(codec, payload, `the payload of '${member}'`))
    for (const value of options?.random ?? [])
      if (!(value >= 0 && value < 1)) fail(`random value ${value} is outside [0, 1)`)
    const ids = options?.id
    const randoms = options?.random
    let drawnIds = 0
    let drawnRandoms = 0
    let exhausted: string | undefined
    const draw = <A>(values: ReadonlyArray<A>, drawn: number, kind: string): A => {
      const value = values[drawn]
      if (value !== undefined) return value
      exhausted = `\`${member}\` drew more than the ${values.length} ${kind} the story supplied`
      throw new Exhausted()
    }
    const wrapped: AnyHandler = (draft, input, ctx) =>
      handler(draft, input, {
        ...ctx,
        id: () => {
          const derived: string = ctx.id()
          return ids === undefined ? derived : draw(ids, drawnIds++, "ids")
        },
        random: () => {
          const derived: number = ctx.random()
          return randoms === undefined ? derived : draw(randoms, drawnRandoms++, "random values")
        },
      })
    const at = options?.now ?? 0
    const ran = Actions.run({
      actor,
      handler: wrapped,
      declaration,
      image: story.image,
      commandId: `story/${story.commands++}`,
      member,
      payload: decoded,
      caller: options?.caller ?? System.make({ source: "process", subject: "process" }),
      at,
      key: story.self,
      address: addressOf(story),
      connection: undefined,
    })
    if (exhausted !== undefined) fail(exhausted)
    const { effects } = ran
    story.image = ran.image
    story.last = {
      member,
      declaration,
      at,
      outcome: effects.outcome,
      sends: [...effects.sends],
      timers: [...effects.timers],
      starts: [...effects.starts],
      events: [...effects.events],
      settled: Outcome.guards.Success(effects.outcome),
    }
  })

/** Checks the last command's reply, compared in its encoded form. */
const expectReply = <X extends AnyActor>(value: ReplyOf<X>): Step<X> =>
  step("expectReply", (story) => {
    const last = lastOf(story)
    const expected = encode(Layouts.codec(last.declaration.success), value, "the expected reply")
    if (
      !Outcome.guards.Success(last.outcome) ||
      canonical(last.outcome.value) !== canonical(expected)
    )
      fail(
        `expected \`${last.member}\` to reply ${canonical(expected)}, but it ended in ${outcomeText(last.outcome)}`,
      )
  })

/**
 * Checks that the last command returned a declared failure: an instance of a failure class, or a
 * failure value compared in its encoded form.
 */
const expectFailure = <X extends AnyActor>(
  expected: FailureOf<X> | (Schema.Top & { readonly Type: FailureOf<X> }),
): Step<X> =>
  step("expectFailure", (story) => {
    const last = lastOf(story)
    const fails = last.declaration.fails
    if (!Outcome.guards.Failure(last.outcome) || fails === undefined)
      return fail(
        `expected \`${last.member}\` to fail, but it ended in ${outcomeText(last.outcome)}`,
      )
    const codec = Layouts.codec(fails)
    if (Schema.isSchema(expected)) {
      const is = Schema.is(expected as Schema.Codec<unknown, unknown, never, never>)
      if (!is(codec.decode(last.outcome.error)))
        fail(
          `expected \`${last.member}\` to fail with ${String(expected)}, but it ended in ${outcomeText(last.outcome)}`,
        )
    } else {
      const wanted = canonical(encode(codec, expected, "the expected failure"))
      if (canonical(last.outcome.error) !== wanted)
        fail(
          `expected \`${last.member}\` to fail with ${wanted}, but it ended in ${outcomeText(last.outcome)}`,
        )
    }
    last.settled = true
  })

/**
 * Checks that the last command ended in a defect: one the handler threw, a thenable it returned,
 * an encode failure or an oversized state. `detail` is a substring or a pattern of its detail.
 */
const expectDefect = <X extends AnyActor>(expected?: {
  readonly kind?: DefectKind
  readonly detail?: string | RegExp
}): Step<X> =>
  step("expectDefect", (story) => {
    const last = lastOf(story)
    const { outcome } = last
    const detail = expected?.detail
    if (
      !Outcome.guards.Defect(outcome) ||
      (expected?.kind !== undefined && outcome.kind !== expected.kind) ||
      (Predicate.isString(detail) && !outcome.detail.includes(detail)) ||
      (detail instanceof RegExp && !detail.test(outcome.detail))
    )
      fail(
        `expected \`${last.member}\` to end in a defect${expected?.kind === undefined ? "" : ` ${expected.kind}`}${detail === undefined ? "" : ` matching ${String(detail)}`}, but it ended in ${outcomeText(outcome)}`,
      )
    last.settled = true
  })

/** Hands the state after the steps so far to `check`: scalar fields and each list in `by` order. */
const state = <X extends AnyActor>(check: (state: FullState<FieldsOf<X>>) => void): Step<X> =>
  step("state", (story) => check(fullState(story)))

/**
 * Reads a view over the state so far, as a client would receive it: the handler's value is encoded
 * and decoded with the view's schema before `check` sees it. The caller is the default command
 * caller.
 */
const view = <X extends AnyActor, const V extends keyof ViewsOf<X> & string>(
  member: V,
  ...args: [
    ...Args<ViewsOf<X>[V]["params"]>,
    check: (value: ViewsOf<X>[V]["success"]["Type"]) => void,
  ]
): Step<X> =>
  step(`view ${member}`, (story) => {
    const { actor, layout } = story
    const declaration: View | undefined = actor.views[member]
    const handler = story.handlers.get(member)
    if (declaration === undefined || handler === undefined)
      return fail(`'${member}' is not a view of ${actor.name}`)
    const check: (value: Decoded) => void = args[args.length - 1]
    const params = Layouts.codec(declaration.params)
    const decoded = params.decode(
      encode(params, args.length > 1 ? args[0] : undefined, `the params of '${member}'`),
    )
    const read = { ...story.image.state }
    for (const [name, list] of layout.lists)
      read[name] = Lists.reader(story.image.lists.get(name) ?? Lists.empty, list.ordering)
    let value: Decoded
    try {
      value = handler(read, decoded, {
        caller: System.make({ source: "process", subject: "process" }),
        self: story.self,
      })
    } catch (thrown) {
      return fail(`view '${member}' threw ${describe(thrown)}`)
    }
    const success = Layouts.codec(declaration.success)
    check(success.decode(encode(success, value, `the value of view '${member}'`)))
  })

/** Checks that the last command staged a send of `member` to the instance `id` of `target`. */
const expectSent = <
  X extends AnyActor,
  T extends AnyActor,
  const M extends keyof CommandsOf<T> & string,
>(
  target: T,
  id: KeyOf<T>,
  member: M,
  ...payload: Args<CommandsOf<T>[M]["payload"]>
): Step<X> =>
  step(`expectSent ${target.name}.${member}`, (story) => {
    const last = lastOf(story)
    const declaration: Command | undefined = target.commands[member]
    if (declaration === undefined) return fail(`'${member}' is not a command of ${target.name}`)
    const key = canonical(encode(Layouts.of(target).key, id, `the id of ${target.name}`))
    const body = canonical(
      encode(Layouts.codec(declaration.payload), payload[0], `the payload of '${member}'`),
    )
    take(
      last,
      last.sends,
      (send) =>
        send.actor === target.name &&
        send.member === member &&
        canonical(send.key) === key &&
        canonical(send.payload) === body,
      `send ${target.name}(${key}).${member}(${body})`,
    )
  })

/**
 * Checks that the last command scheduled `member` on its own actor: after a delay from the
 * command's `now`, or at an epoch-millisecond instant.
 */
const expectScheduled = <X extends AnyActor, const M extends keyof CommandsOf<X> & string>(
  when: When,
  member: M,
  ...payload: Args<CommandsOf<X>[M]["payload"]>
): Step<X> =>
  step(`expectScheduled ${member}`, (story) => {
    const last = lastOf(story)
    const declaration: Command | undefined = story.actor.commands[member]
    if (declaration === undefined)
      return fail(`'${member}' is not a command of ${story.actor.name}`)
    const due = isInstant(when)
      ? when.at
      : last.at + Duration.toMillis(Duration.fromInputUnsafe(when))
    const body = canonical(
      encode(Layouts.codec(declaration.payload), payload[0], `the payload of '${member}'`),
    )
    take(
      last,
      last.timers,
      (timer) =>
        !timer.cron &&
        timer.member === member &&
        timer.at === due &&
        canonical(timer.payload) === body,
      `timer ${member}(${body}) at ${due}`,
    )
  })

/**
 * Checks that the last command staged a start of `job` with `payload`, and with `key` when given;
 * a start with a key matches only an expectation naming the same key.
 */
const expectStarted = <X extends AnyActor, const J extends keyof JobsOf<X> & string>(
  job: J,
  ...args: [...Args<JobsOf<X>[J]["payload"]>, options?: { readonly key?: string }]
): Step<X> =>
  step(`expectStarted ${job}`, (story) => {
    const last = lastOf(story)
    const declaration: Job | undefined = story.actor.jobs[job]
    if (declaration === undefined) return fail(`'${job}' is not a job of ${story.actor.name}`)
    const [payload, options]: [Decoded, { readonly key?: string } | undefined] =
      declaration.payload === undefined ? [undefined, args[0]] : [args[0], args[1]]
    const body = canonical(
      encode(Layouts.codec(declaration.payload), payload, `the payload of job '${job}'`),
    )
    const key = options?.key
    take(
      last,
      last.starts,
      (start) => start.job === job && start.key === key && canonical(start.payload) === body,
      `start ${job}(${body})${key === undefined ? "" : ` key ${key}`}`,
    )
  })

/** Checks that the last command staged broadcast `name` with `value`. */
const expectBroadcast = <X extends AnyActor, const B extends keyof BroadcastsOf<X> & string>(
  name: B,
  value: BroadcastsOf<X>[B]["schema"]["Type"],
): Step<X> =>
  step(`expectBroadcast ${name}`, (story) => {
    const last = lastOf(story)
    const declaration = story.actor.broadcasts[name]
    if (declaration === undefined)
      return fail(`'${name}' is not a broadcast of ${story.actor.name}`)
    const body = canonical(
      encode(Layouts.codec(declaration.schema), value, `the value of broadcast '${name}'`),
    )
    take(
      last,
      last.events,
      (event) => event.event === name && canonical(event.value) === body,
      `broadcast ${name} ${body}`,
    )
  })

/**
 * Checks that the last command staged nothing beyond what earlier expectations after it matched:
 * no send, timer, job start or broadcast.
 */
const expectNothingStaged = <X extends AnyActor>(): Step<X> =>
  step("expectNothingStaged", (story) => {
    const last = lastOf(story)
    if (last.sends.length + last.timers.length + last.starts.length + last.events.length > 0)
      fail(`expected \`${last.member}\` to stage nothing more; ${stagedText(last)}`)
  })

/**
 * Builds the actor's layer once to read its bound handlers. The layer must be complete, as for
 * `Simulation.run`: services its jobs require may be stubs, since a story never runs a job.
 */
const handlersOf = (actor: AnyActor, layer: Layer.Layer<never>): ReadonlyMap<string, AnyHandler> =>
  Effect.runSync(
    Effect.scoped(
      Effect.map(
        Layer.build(layer),
        (context) => Context.getUnsafe(context, actor.implementation).handlers,
      ),
    ),
  )

/**
 * Runs a story synchronously: no engine, no store and no Effect runtime around it, so it works in
 * any test runner. An unmet expectation throws {@link StoryFailure}; so does a declared failure or
 * defect that no `expectFailure` or `expectDefect` step acknowledges before the next command or
 * the end. Errors thrown by `state` and `view` checks pass through unchanged.
 */
const run = <X extends AnyActor>(
  actor: X,
  layer: Layer.Layer<ImplementationOf<X>>,
  ...steps: ReadonlyArray<Step<NoInfer<X>>>
): void => {
  const layout = Layouts.of(actor)
  const story: Running = {
    actor,
    layout,
    handlers: handlersOf(actor, layer),
    self: "story",
    image: layout.initial,
    commands: 0,
    last: undefined,
  }
  const attempt = (index: number, label: string, apply: () => void): void => {
    try {
      apply()
    } catch (thrown) {
      if (thrown instanceof Problem)
        throw StoryFailure.make({ actor: actor.name, step: index, label, detail: thrown.detail })
      throw thrown
    }
  }
  steps.forEach((each, index) => attempt(index + 1, each.label, () => each.apply(story)))
  attempt(steps.length + 1, "end", () => settle(story))
}

/** {@link run} as an Effect that fails with {@link StoryFailure}. */
const effect = <X extends AnyActor>(
  actor: X,
  layer: Layer.Layer<ImplementationOf<X>>,
  ...steps: ReadonlyArray<Step<NoInfer<X>>>
): Effect.Effect<void, StoryFailure> =>
  Effect.suspend(() => {
    try {
      run(actor, layer, ...steps)
      return Effect.void
    } catch (thrown) {
      if (Schema.is(StoryFailure)(thrown)) return Effect.fail(thrown)
      throw thrown
    }
  })

/**
 * Handler stories: one actor's command and view handlers run as pure functions over a given
 * state, with every reply, failure, defect and staged effect checked against the contract.
 */
export const Story = {
  run,
  effect,
  given,
  command,
  state,
  view,
  expectReply,
  expectFailure,
  expectDefect,
  expectSent,
  expectScheduled,
  expectStarted,
  expectBroadcast,
  expectNothingStaged,
}
