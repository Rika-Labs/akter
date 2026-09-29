import type { ActorRef } from "../../identity/caller.ts"

/** Increment only with a migration: every stored `routing_key` depends on this encoding. */
export const PLACEMENT_ENCODING = 1

export type Placement = "tenant" | "actor"

/**
 * The 64-bit shard key shared by every row an actor owns. Tenant
 * placement colocates a tenant's actors; actor placement spreads them.
 */
export const routingKey = ({
  ref,
  placement,
}: {
  readonly ref: ActorRef
  readonly placement: Placement
}): bigint => {
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

export const decompress = (bytes: Uint8Array): string =>
  new TextDecoder().decode(Bun.zstdDecompressSync(bytes))
