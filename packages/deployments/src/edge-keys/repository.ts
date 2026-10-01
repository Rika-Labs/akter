import { AssertionKeySet } from "@durable-actors/core/runtime"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

/**
 * The edge's published verification keys, as runners fetch them: every key
 * not revoked and not past its `expires_at`. Removing a key here is what
 * revokes it; runners stop accepting it once they reread the set.
 */
export const publishedKeys = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<{
    readonly kid: string
    readonly x: string
    readonly exp: number | null
  }>`
    SELECT kid, x, floor(extract(epoch FROM expires_at))::int AS exp
    FROM edge_key
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
    ORDER BY published_at, kid
  `

  return AssertionKeySet.make({
    keys: rows.map(({ kid, x, exp }) =>
      exp === null
        ? { kid, kty: "OKP", crv: "Ed25519", x }
        : { kid, kty: "OKP", crv: "Ed25519", x, exp },
    ),
  })
})
