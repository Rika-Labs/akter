import { describePostgres, unshardedGroups } from "./conformance/postgres/backend.ts"

describePostgres(unshardedGroups)
