import { Resource } from "alchemy/Resource"
import type { NekiDatabase } from "./database.ts"
import type { NekiLogicalDatabase } from "./logical-database.ts"
import type { NekiRole } from "./role.ts"

/**
 * The Neki resource constructors, `Neki.Database(id, props)`, `Neki.Role(id, props)` and
 * `Neki.LogicalDatabase(id, props)`,
 * held in an object because the repository's lint rejects exporting a bare Alchemy
 * constructor, which has no pipeable overload.
 */
export const Neki = {
  Database: Resource<NekiDatabase>("Planetscale.NekiDatabase"),
  Role: Resource<NekiRole>("Planetscale.NekiRole"),
  LogicalDatabase: Resource<NekiLogicalDatabase>("Planetscale.NekiLogicalDatabase"),
}
