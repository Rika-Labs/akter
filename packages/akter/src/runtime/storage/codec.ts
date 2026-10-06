import type { ActorRef } from "../../identity/caller.ts"
import { parseChildId } from "../../identity/child.ts"
import { compressBytes, decompressBytes, hash64 } from "./platform.ts"

/** Increment only with a migration: every stored `routing_key` depends on this encoding. */
export const PLACEMENT_ENCODING = 1

/**
 * An actor type's placement. A parent-placed type names its parent type and
 * that type's own placement, down to an actor-placed root.
 */
export type Placement =
  | "tenant"
  | "actor"
  | "authority"
  | { readonly parent: string; readonly placement: Placement }

/**
 * The bucket every authority-placed key falls in. A topology that splits a
 * database keeps it on the authoritative shard, beside the tables it does not
 * route, so a turn of an authority-placed actor reads and writes the real
 * control tables in a transaction that reaches one shard.
 */
export const AUTHORITY_BUCKET = -128

const LOW_56 = (1n << 56n) - 1n

/** `key` moved into `AUTHORITY_BUCKET`, keeping its low 56 bits, so distinct keys stay distinct. */
export const authorityKey = (key: bigint): bigint =>
  BigInt.asIntN(64, (key & LOW_56) | (BigInt(AUTHORITY_BUCKET + 256) << 56n))

const isRoot = (placement: Placement): placement is "tenant" | "actor" | "authority" =>
  placement === "tenant" || placement === "actor" || placement === "authority"

/** A parent-placed type's parent and the parent's placement; `undefined` for any other. */
export const parentPlacement = (placement: Placement) => (isRoot(placement) ? undefined : placement)

/** The value `actor_placements.placement` records for `placement`. */
export const placementKind = (placement: Placement) => (isRoot(placement) ? placement : "parent")

/** The placement at the root of `placement`'s parent chain. */
export const rootPlacement = (placement: Placement): "tenant" | "actor" | "authority" =>
  isRoot(placement) ? placement : rootPlacement(placement.placement)

/**
 * The 64-bit shard key shared by every row an actor owns. Tenant
 * placement colocates a tenant's actors; actor placement spreads them;
 * authority placement colocates a tenant's authority-placed actors in
 * `AUTHORITY_BUCKET`; a parent-placed actor takes its root's key, read from
 * the parent id its own id carries, so a family shares one shard. A
 * parent-placed id without a parent id throws: ids are decoded against their
 * actor's key before any routing, so that is a defect, not an input error.
 */
export const routingKey = ({
  ref,
  placement,
}: {
  readonly ref: ActorRef
  readonly placement: Placement
}): bigint => {
  const above = parentPlacement(placement)

  if (above !== undefined) {
    const parent = parseChildId(ref.id)?.parent

    if (parent === undefined)
      throw new Error(`Actor ${ref.actor} id ${ref.id} carries no ${above.parent} parent id`)

    return routingKey({
      ref: { tenant: ref.tenant, actor: above.parent, id: parent },
      placement: above.placement,
    })
  }

  if (placement === "authority") return authorityKey(tenantRoutingKey(ref.tenant))

  return placement === "tenant"
    ? tenantRoutingKey(ref.tenant)
    : placementHash(["actor", ref.tenant, ref.actor, ref.id])
}

/** The shard key of a tenant: its tenant-placed actors and its shared content live there. */
export const tenantRoutingKey = (tenant: string): bigint => placementHash(["tenant", tenant])

const placementHash = (parts: ReadonlyArray<string>) =>
  BigInt.asIntN(64, hash64(JSON.stringify([PLACEMENT_ENCODING, ...parts])))

/**
 * Stored state values are opaque zstd-compressed JSON: SQL never reads state,
 * and anything worth querying belongs in an actor table.
 */
export const compress = (json: string): Uint8Array => compressBytes(new TextEncoder().encode(json))

/** Inverse of `compress`; throws on bytes that are not zstd-compressed UTF-8. */
export const decompress = (bytes: Uint8Array): string =>
  new TextDecoder().decode(decompressBytes(bytes))
