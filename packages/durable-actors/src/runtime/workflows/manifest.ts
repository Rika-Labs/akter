import { Crypto, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"

const toJson = <T extends object>(value: T) => JSON.stringify(value)

import type { AnyWorkflow } from "../../members/workflow.ts"

/** What an open execution depends on: its steps, the schemas they record, and marker ranges. */
export interface Manifest {
  readonly workflow: string
  readonly input: string
  readonly output: string
  readonly steps: ReadonlyArray<{
    readonly name: string
    readonly kind: string
    readonly fingerprint: string
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

/** Records each workflow member's manifest as accepted; an unchanged one is already there. */
export const recordManifests = Effect.fnUntraced(function* (registration: {
  readonly name: string
  readonly workflows: ReadonlyMap<string, { readonly member: AnyWorkflow }>
}) {
  if (registration.workflows.size === 0) return
  const sql = yield* SqlClient.SqlClient

  const rows = []

  for (const { member } of registration.workflows.values()) {
    const { manifest, hash } = yield* manifestOf(registration.name, member)
    rows.push({
      actor_type: registration.name,
      workflow: member.tag,
      manifest_hash: hash,
      manifest: toJson(manifest),
    })
  }

  yield* sql`INSERT INTO actor_workflow_manifests (actor_type, workflow, manifest_hash, manifest, accepted_at_ms)
    SELECT m.actor_type, m.workflow, m.manifest_hash, m.manifest::jsonb,
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
    FROM jsonb_to_recordset(${toJson(rows)}::jsonb)
      AS m (actor_type text, workflow text, manifest_hash text, manifest text)
    ON CONFLICT DO NOTHING`
})
