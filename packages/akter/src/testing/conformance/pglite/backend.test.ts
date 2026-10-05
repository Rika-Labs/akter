import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { describeConformance } from "../../conformance.ts"
import { groupsOf } from "../postgres/shards.ts"
import { disposePgliteBackend, pgliteBackend } from "./backend.ts"

afterAll(disposePgliteBackend)

describeConformance({
  name: "PGlite durable turns",
  backend: pgliteBackend,
  groups: groupsOf(inject("conformanceShard")),
  registrar: {
    describe,
    it,
    beforeAll,
    afterAll,
    expect,
    skip: (name) => it.skip(name),
  },
})
