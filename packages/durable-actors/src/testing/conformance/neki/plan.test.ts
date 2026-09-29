import { describe, expect, it } from "vitest"
import { nekiPlanNodes, touchesOneShard } from "./plan.ts"

// Plans as PlanetScale's query-planning documentation prints them.
const equalUnique = `Route [EqualUnique]
  Query: SELECT event_id FROM public.events WHERE tenant_id = $1
  ShardGroup: tenant_data
  Values: $1`

const inList = `Collapse
└── Route [IN]
      Query: SELECT event_id FROM public.events WHERE tenant_id = ANY($1)
      ShardGroup: tenant_data
      Values: $1`

const scatterAggregate = `Aggregate [Ordered]
└── Collapse
    └── Route [Scatter]
          Query: SELECT count(*) FROM public.events
          ShardGroup: tenant_data`

const scatterLimit = `Collapse
└── Limit
    └── Route [Scatter]
          Query: SELECT id, total_cents FROM public.orders WHERE status = $1 LIMIT 100
          ShardGroup: user_data`

describe("Neki plan reading", () => {
  it("reads the router operators of a plan in print order", () => {
    expect(nekiPlanNodes(scatterAggregate)).toEqual([
      { operator: "Aggregate", kind: "Ordered" },
      { operator: "Collapse", kind: undefined },
      { operator: "Route", kind: "Scatter" },
    ])

    expect(nekiPlanNodes(inList)).toEqual([
      { operator: "Collapse", kind: undefined },
      { operator: "Route", kind: "IN" },
    ])
  })

  it("accepts a lone equality route and nothing else", () => {
    expect(touchesOneShard(equalUnique)).toBe(true)
    expect(touchesOneShard(inList)).toBe(false)
    expect(touchesOneShard(scatterAggregate)).toBe(false)
    expect(touchesOneShard(scatterLimit)).toBe(false)
  })

  it("refuses a plan it does not recognise instead of assuming one shard", () => {
    expect(touchesOneShard("")).toBe(false)
    expect(touchesOneShard("Route [Range]\n  Query: SELECT 1")).toBe(false)
    expect(touchesOneShard(`${equalUnique}\n${equalUnique}`)).toBe(false)
  })
})
