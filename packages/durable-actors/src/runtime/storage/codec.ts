import type { ActorRef } from "../../identity/caller.ts"
import { parseChildId } from "../../identity/child.ts"

/** Increment only with a migration: every stored `routing_key` depends on this encoding. */
export const PLACEMENT_ENCODING = 1

/**
 * An actor type's placement. A parent-placed type names its parent type and
 * that type's own placement, down to an actor-placed root.
 */
export type Placement =
  | "tenant"
  | "actor"
  | { readonly parent: string; readonly placement: Placement }

/** A parent-placed type's parent and the parent's placement; `undefined` for any other. */
export const parentPlacement = (placement: Placement) =>
  placement === "tenant" || placement === "actor" ? undefined : placement

/** The value `actor_placements.placement` records for `placement`. */
export const placementKind = (placement: Placement) =>
  placement === "tenant" || placement === "actor" ? placement : "parent"

/**
 * The 64-bit shard key shared by every row an actor owns. Tenant
 * placement colocates a tenant's actors; actor placement spreads them; a
 * parent-placed actor takes its root's key, read from the parent id its own
 * id carries, so a family shares one shard. A parent-placed id without a
 * parent id throws: ids are decoded against their actor's key before any
 * routing, so that is a defect, not an input error.
 */
export const routingKey = ({
  ref,
  placement,
}: {
  readonly ref: ActorRef
  readonly placement: Placement
}): bigint => {
  if (placement !== "tenant" && placement !== "actor") {
    const parent = parseChildId(ref.id)?.parent

    if (parent === undefined)
      throw new Error(`Actor ${ref.actor} id ${ref.id} carries no ${placement.parent} parent id`)

    return routingKey({
      ref: { tenant: ref.tenant, actor: placement.parent, id: parent },
      placement: placement.placement,
    })
  }

  if (placement === "tenant") return tenantRoutingKey(ref.tenant)

  const value = JSON.stringify([PLACEMENT_ENCODING, "actor", ref.tenant, ref.actor, ref.id])

  return BigInt.asIntN(64, Bun.hash.xxHash3(value))
}

/** The shard key of a tenant: its tenant-placed actors and its shared content live there. */
export const tenantRoutingKey = (tenant: string): bigint =>
  BigInt.asIntN(64, Bun.hash.xxHash3(JSON.stringify([PLACEMENT_ENCODING, "tenant", tenant])))

/**
 * Stored state values are opaque zstd-compressed JSON: SQL never reads state,
 * and anything worth querying belongs in an actor table.
 */
export const compress = (json: string): Uint8Array =>
  Bun.zstdCompressSync(new TextEncoder().encode(json))

/** Inverse of `compress`; throws on bytes that are not zstd-compressed UTF-8. */
export const decompress = (bytes: Uint8Array): string =>
  new TextDecoder().decode(Bun.zstdDecompressSync(bytes))
