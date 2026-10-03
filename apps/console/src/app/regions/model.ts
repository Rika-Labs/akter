import { Schema as S } from "effect"

/** A region the project runs in and the facts about its database. */
export const RegionFacts = S.Struct({
  id: S.String,
  place: S.String,
  primary: S.Boolean,
  healthy: S.Boolean,
  tenants: S.Finite,
  database: S.String,
  storageUsed: S.Finite,
  storageLimit: S.Finite,
  cpu: S.String,
  connections: S.String,
  runners: S.String,
  backups: S.String,
})
export type RegionFacts = typeof RegionFacts.Type

/** A table owned by an actor type, by size. */
export const OwnedTable = S.Struct({
  name: S.String,
  actorType: S.String,
  rows: S.String,
  size: S.String,
  region: S.String,
})

/** The regions and database page. */
export const RegionsPage = S.TaggedStruct("RegionsPage", {
  regions: S.Array(RegionFacts),
  tables: S.Array(OwnedTable),
})
export type RegionsPage = typeof RegionsPage.Type
