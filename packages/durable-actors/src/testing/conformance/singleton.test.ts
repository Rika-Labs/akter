import { describePostgres } from "./postgres/backend.ts"
import { shards } from "./postgres/shards.ts"

describePostgres(shards["singleton"])
