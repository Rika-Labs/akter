import { inject } from "vitest"
import { describePostgres } from "./backend.ts"
import { groupsOf } from "./shards.ts"

describePostgres(groupsOf(inject("conformanceShard")))
