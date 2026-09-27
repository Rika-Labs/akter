import { Crypto, Effect, Schema } from "effect"

import type { AnyWorkflow } from "../../members/workflow.ts"

export const toJson = <T extends object>(value: T) => JSON.stringify(value)

/** What an open execution depends on: its steps, the schemas they record, and marker ranges. */
export interface Manifest {
  readonly workflow: string
  readonly input: string
  readonly output: string
  readonly steps: ReadonlyArray<{
    readonly name: string
    readonly kind: string
    readonly fingerprint: string
    /** The schemas of the value the step records: an activity's success and errors, a wait's event. */
    readonly result: string
    readonly event: string | null
  }>
  readonly versions: Readonly<Record<string, { readonly current: number; readonly min: number }>>
}

const utf8 = new TextEncoder()

const fingerprintOf = (schemas: ReadonlyArray<Schema.Top>) =>
  toJson(schemas.map((schema) => Schema.toJsonSchemaDocument(schema)))

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const cache = new WeakMap<AnyWorkflow, { readonly manifest: Manifest; readonly hash: string }>()

/**
 * The member's manifest and its SHA-256. Constructors register at module
 * load, so the manifest is fixed once a layer is built.
 */
export const manifestOf = Effect.fnUntraced(function* (actorType: string, member: AnyWorkflow) {
  const cached = cache.get(member)

  if (cached !== undefined) return cached

  const manifest: Manifest = {
    workflow: member.tag,
    input: fingerprintOf([member.input]),
    output: fingerprintOf([member.output, ...member.errors]),
    steps: [...member.registry.steps.values()].map((step) => ({
      name: step.name,
      kind: step.kind,
      fingerprint: fingerprintOf(step.schemas),
      result: fingerprintOf(step.kind === "activity" ? step.schemas.slice(1) : step.schemas),
      event: step.event ?? null,
    })),
    versions: member.versions,
  }

  const digest = yield* (yield* Crypto.Crypto)
    .digest("SHA-256", utf8.encode(toJson([actorType, manifest])))
    .pipe(Effect.orDie)

  const entry = { manifest, hash: hex(digest) }
  cache.set(member, entry)

  return entry
})
