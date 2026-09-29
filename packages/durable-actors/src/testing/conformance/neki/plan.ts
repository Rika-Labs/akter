/** One node of a Neki plan printed with `FORMAT TEXT`. */
export interface NekiPlanNode {
  /** `Route`, `Collapse`, `Aggregate`, `Limit`, and any other router operator. */
  readonly operator: string
  /** The bracketed routing choice, e.g. `EqualUnique`, `IN` or `Scatter`. */
  readonly kind: string | undefined
}

// A node line is an operator name with an optional bracketed kind. Attribute
// lines such as `Query:` and `ShardGroup:` carry a colon and are not nodes.
const NODE = /^([A-Za-z][A-Za-z ]*?)(?: \[([^\]]+)\])?$/

/**
 * The router operators of a plan printed by `EXPLAIN (NEKI_PLAN, FORMAT TEXT)`,
 * in print order. Tree glyphs and indentation are dropped.
 */
export const nekiPlanNodes = (plan: string): ReadonlyArray<NekiPlanNode> =>
  plan
    .split("\n")
    .map((line) => line.replace(/^[│├└─\s]+/u, "").trim())
    .flatMap((line) => {
      const match = NODE.exec(line)

      return match === null || line.includes(":") ? [] : [{ operator: match[1]!, kind: match[2] }]
    })

/** The routing choices that Neki documents as reaching exactly one shard. */
const SINGLE_SHARD_ROUTES: ReadonlySet<string> = new Set(["EqualUnique"])

/**
 * Whether a plan is one route to one shard and nothing else. A router
 * operator above the route, a second route, a scatter, an `IN` list, and a
 * routing choice not known to be single-shard all fail: an unfamiliar plan is
 * reported, never assumed safe.
 */
export const touchesOneShard = (plan: string): boolean => {
  const nodes = nekiPlanNodes(plan)

  return (
    nodes.length === 1 &&
    nodes[0]!.operator === "Route" &&
    SINGLE_SHARD_ROUTES.has(nodes[0]!.kind ?? "")
  )
}
