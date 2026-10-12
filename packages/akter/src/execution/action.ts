import { Duration, Effect, Predicate, Schema } from "effect"
import type { Caller } from "../contract/caller.ts"
import type { When } from "../contract/context.ts"
import { ActionDefect } from "../contract/errors.ts"
import type { DefectKind } from "../contract/errors.ts"
import type { AnyActor } from "../contract/make.ts"
import type { Action, Event, Job } from "../contract/members.ts"
import { Draft } from "../handlers/draft.ts"
import { Lists } from "../handlers/lists.ts"
import type { Items } from "../handlers/lists.ts"
import type { AnyHandler } from "../handlers/registry.ts"
import { CommandIds } from "./command-ids.ts"
import { Digest } from "./digest.ts"
import { Outcome } from "./entries.ts"
import type { Effects, Emit, ListWrite, Send, Start, Timer } from "./entries.ts"
import { Layouts } from "./layout.ts"
import type { Decoded, Image } from "./layout.ts"

/** State without lists is capped at this many encoded bytes. */
export const maxStateBytes = 256 * 1024

/** One run of one action: everything the handler needs, all of it recorded in the entry. */
export interface Invocation {
  readonly actor: AnyActor
  readonly handler: AnyHandler
  readonly declaration: Action | undefined
  readonly image: Image
  readonly commandId: string
  readonly member: string
  readonly payload: Decoded
  readonly caller: Caller
  readonly at: number
  readonly key: Decoded
  readonly address: string
  readonly connection: string | undefined
}

/** The result of one run: the recorded effects and the image after them. */
export interface Ran {
  readonly effects: Effects
  readonly image: Image
}


const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0

/** A xoshiro128** stream seeded from the command id, so a replay draws the same values. */
const generator = (commandId: string): (() => number) => {
  const seed = new DataView(Digest.sha256(`${commandId}\u0000random`).buffer)
  let s0 = seed.getUint32(0, true)
  let s1 = seed.getUint32(4, true)
  let s2 = seed.getUint32(8, true)
  let s3 = seed.getUint32(12, true)
  const next = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0
    const t = (s1 << 9) >>> 0
    s2 = (s2 ^ s0) >>> 0
    s3 = (s3 ^ s1) >>> 0
    s1 = (s1 ^ s2) >>> 0
    s0 = (s0 ^ s3) >>> 0
    s2 = (s2 ^ t) >>> 0
    s3 = rotl(s3, 11)
    return result
  }
  return () => (next() * 2 ** 21 + (next() >>> 11)) / 2 ** 53
}

const describe = (thrown: Decoded): string =>
  thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)

const isThenable = (value: Decoded): boolean =>
  Effect.isEffect(value) ||
  (Predicate.hasProperty(value, "then") && Predicate.isFunction(value.then))

const isInstant = (when: When): when is { readonly at: number } => Predicate.hasProperty(when, "at")

const dueAt = (when: When, at: number): number =>
  isInstant(when) ? when.at : at + Duration.toMillis(Duration.fromInputUnsafe(when))

/**
 * Runs one action synchronously over a copy-on-write draft of `image` and records everything it
 * did. A declared failure, a thrown value, a thenable result, an encode failure or an oversized
 * state discards the draft and all staged work as one unit and leaves `image` as it was; the
 * outcome is the only trace. Nothing here reads a clock, a random source or the environment:
 * `now`, `id` and `random` derive from the command id and admission time alone.
 */
const run = (invocation: Invocation): Ran => {
  const { actor, image, commandId, at } = invocation
  const layout = Layouts.of(actor)
  let ids = 0
  let randoms = 0
  let staged = 0
  let open = true
  const random = generator(commandId)
  const sends: Array<Send> = []
  const timers: Array<Timer> = []
  const starts: Array<Start> = []
  const events: Array<Emit> = []
  const defect = (kind: DefectKind, detail: string): ActionDefect =>
    ActionDefect.make({ kind, actor: actor.name, member: invocation.member, detail })
  const guard = (): void => {
    if (!open) throw defect("SynchronousActionViolation", "the action context was used after the action returned")
  }
  const sender = (target: AnyActor, stage: (member: string, payload: Schema.Json) => void) => {
    const methods: Record<string, (payload?: Decoded) => void> = {}
    const actions: Record<string, Action> = target.actions
    for (const [member, declaration] of Object.entries(actions))
      methods[member] = (payload?: Decoded) => {
        guard()
        stage(member, Layouts.codec(declaration.payload).encode(payload))
      }
    return methods
  }
  const lists = new Map<string, ReturnType<typeof Lists.draft>>()
  for (const [name, list] of layout.lists)
    lists.set(name, Lists.draft(image.lists.get(name) ?? Lists.empty, list.ordering))
  const session = Draft.begin<Decoded>({ ...image.state, ...Object.fromEntries(lists) })
  const ctx = {
    caller: invocation.caller,
    self: invocation.key,
    connection: invocation.connection,
    id: () => {
      guard()
      return CommandIds.derive(commandId, "id", ids++)
    },
    now: () => {
      guard()
      return at
    },
    random: () => {
      guard()
      randoms++
      return random()
    },
    send: (target: AnyActor, id: Decoded) => {
      guard()
      const key = Layouts.of(target).key.encode(id)
      return sender(target, (member, payload) => {
        sends.push({ commandId: CommandIds.derive(commandId, "send", staged++), actor: target.name, key, member, payload })
      })
    },
    schedule: (when: When) => {
      guard()
      const due = dueAt(when, at)
      return sender(actor, (member, payload) => {
        timers.push({ commandId: CommandIds.derive(commandId, "timer", staged++), at: due, member, payload, cron: false })
      })
    },
    start: Object.fromEntries(
      Object.entries<Job>(actor.jobs).map(([job, declaration]) => [
        job,
        (payload?: Decoded, options?: { readonly key?: string }) => {
          guard()
          const ordinal = staged++
          const encoded = Layouts.codec(declaration.payload).encode(payload)
          const key = options?.key
          starts.push(
            key === undefined
              ? { jobId: CommandIds.derive(commandId, "job", ordinal), job, payload: encoded }
              : { jobId: CommandIds.derive(invocation.address, "job", job, key), job, payload: encoded, key },
          )
        },
      ]),
    ),
    emit: Object.fromEntries(
      Object.entries<Event>(actor.events).map(([event, declaration]) => [
        event,
        (value: Decoded) => {
          guard()
          events.push({ event, value: Layouts.codec(declaration.schema).encode(value) })
        },
      ]),
    ),
  }
  const discarded = (outcome: Outcome): Ran => ({
    effects: { outcome, set: {}, unset: [], lists: [], sends: [], timers: [], starts: [], events: [], ids, randoms },
    image,
  })
  let result: Decoded
  try {
    result = invocation.handler(session.draft, invocation.payload, ctx)
  } catch (thrown) {
    open = false
    if (Schema.is(ActionDefect)(thrown)) return discarded(Outcome.cases.Defect.make({ kind: thrown.kind, detail: thrown.detail }))
    return discarded(Outcome.cases.Defect.make({ kind: "Thrown", detail: describe(thrown) }))
  }
  open = false
  const declaration = invocation.declaration
  const fails = declaration?.fails
  if (fails !== undefined && Schema.is(fails)(result)) {
    try {
      return discarded(Outcome.cases.Failure.make({ error: Layouts.codec(fails).encode(result) }))
    } catch (thrown) {
      return discarded(Outcome.cases.Defect.make({ kind: "DecodeFailure", detail: describe(thrown) }))
    }
  }
  if (isThenable(result))
    return discarded(
      Outcome.cases.Defect.make({
        kind: "SynchronousActionViolation",
        detail: `${actor.name}.${invocation.member} returned a promise or an Effect; actions are synchronous`,
      }),
    )
  try {
    const value = declaration?.success === undefined ? null : Layouts.codec(declaration.success).encode(result)
    const finished = session.finish()
    const set: Record<string, Schema.Json> = {}
    const unset: Array<string> = []
    const state: Decoded = { ...image.state }
    const encoded = { ...image.encoded }
    for (const name of finished.changed) {
      const field = layout.fields.get(name)
      if (field === undefined) {
        if (layout.lists.has(name)) throw defect("Thrown", `list field '${name}' was replaced; use its methods`)
        throw defect("Thrown", `'${name}' is not a state field of ${actor.name}`)
      }
      const next = finished.value[name]
      if (next === undefined) {
        if (!field.optional) throw defect("DecodeFailure", `state field '${name}' was removed but is not optional`)
        delete state[name]
        delete encoded[name]
        unset.push(name)
        continue
      }
      state[name] = next
      encoded[name] = field.encode(next)
      set[name] = encoded[name]
    }
    if (finished.changed.length > 0) {
      const size = new TextEncoder().encode(JSON.stringify(encoded)).length
      if (size > maxStateBytes)
        throw defect("StateTooLarge", `${actor.name} state is ${size} bytes encoded; the limit is ${maxStateBytes}`)
    }
    const writes: Array<ListWrite> = []
    const nextLists = new Map<string, Items>(image.lists)
    for (const [name, list] of lists) {
      const done = list.finish()
      if (done.writes === undefined) continue
      const item = layout.lists.get(name)?.item
      if (item === undefined) continue
      nextLists.set(name, done.items)
      writes.push({ field: name, put: done.writes.put.map(item.encode), delete: done.writes.delete })
    }
    const changed = finished.changed.length > 0 || writes.length > 0
    return {
      effects: { outcome: Outcome.cases.Success.make({ value }), set, unset, lists: writes, sends, timers, starts, events, ids, randoms },
      image: changed ? { state, encoded, lists: nextLists } : image,
    }
  } catch (thrown) {
    if (Schema.is(ActionDefect)(thrown)) return discarded(Outcome.cases.Defect.make({ kind: thrown.kind, detail: thrown.detail }))
    return discarded(Outcome.cases.Defect.make({ kind: "DecodeFailure", detail: describe(thrown) }))
  }
}

/**
 * Applies recorded effects to an image without running a handler: how a seed entry, and an
 * action whose replayed outcome already matched, reach the state.
 */
const apply = (actor: AnyActor, image: Image, set: Readonly<Record<string, Schema.Json>>, unset: ReadonlyArray<string>, writes: ReadonlyArray<ListWrite>): Image => {
  if (Object.keys(set).length === 0 && unset.length === 0 && writes.length === 0) return image
  const layout = Layouts.of(actor)
  const state: Decoded = { ...image.state }
  const encoded = { ...image.encoded }
  for (const [name, value] of Object.entries(set)) {
    const field = layout.fields.get(name)
    if (field === undefined) continue
    state[name] = field.decode(value)
    encoded[name] = value
  }
  for (const name of unset) {
    delete state[name]
    delete encoded[name]
  }
  const lists = new Map(image.lists)
  for (const write of writes) {
    const list = layout.lists.get(write.field)
    if (list === undefined) continue
    lists.set(
      write.field,
      Lists.apply(lists.get(write.field) ?? Lists.empty, list.ordering, {
        put: write.put.map(list.item.decode),
        delete: write.delete,
      }),
    )
  }
  return { state, encoded, lists }
}

/** Running actions and applying their recorded effects. */
export const Actions = { run, apply }
