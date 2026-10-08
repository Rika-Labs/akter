import { describe, expect, it } from "vitest"
import { scopeOf, wireStatements } from "./statements.ts"

describe("wire statement recorder", () => {
  it("counts fragmented Sync and Query messages without counting startup, Parse or Bind", () => {
    const startup = Buffer.alloc(8)
    startup.writeInt32BE(8, 0)
    startup.writeInt32BE(196608, 4)
    const message = (type: string, payload = "") => {
      const body = Buffer.from(payload)
      const header = Buffer.alloc(5)
      header.write(type, 0)
      header.writeInt32BE(body.length + 4, 1)

      return Buffer.concat([header, body])
    }

    const bytes = Buffer.concat([
      startup,
      message("P", "SELECT 1"),
      message("B"),
      message("S"),
      message("P", "SELECT 2"),
      message("B"),
      message("S"),
      message("Q", "ROLLBACK\0"),
    ])
    const count = wireStatements()
    const observations = Array.from(bytes, (byte) => count(Buffer.of(byte)))

    expect(observations.reduce((total, statements) => total + statements, 0)).toBe(3)
    expect(count(message("S"))).toBe(1)
  })
})

describe("statement scope", () => {
  it("calls a statement keyed when it filters or inserts by routing_key", () => {
    expect(
      scopeOf(
        "SELECT key, value FROM actor_state WHERE routing_key = $1 AND tenant_id = $2 AND actor_id = $3",
      ),
    ).toBe("keyed")

    expect(
      scopeOf(
        'INSERT INTO actor_receipts ("routing_key","tenant_id","command_id") VALUES ($1,$2,$3)',
      ),
    ).toBe("keyed")

    expect(
      scopeOf(
        "INSERT INTO actor_generations (routing_key, tenant_id) SELECT $1, $2 FROM (SELECT set_config('a', $3, true)) AS t",
      ),
    ).toBe("keyed")

    expect(
      scopeOf(
        'select "id" from "orders" where (("orders"."routing_key" = $1) and ("orders"."tenant_id" = $2))',
      ),
    ).toBe("keyed")
  })

  it("calls a bucket probe a scan even though it joins on routing_key", () => {
    expect(
      scopeOf(
        `WITH due AS (SELECT o.routing_key, o.intent_id FROM generate_series($1::int, $2::int) AS b(bucket)
          CROSS JOIN LATERAL (SELECT routing_key, intent_id FROM actor_outbox
            WHERE actor_outbox.bucket = b.bucket AND due_at_ms <= $3) o)
        UPDATE actor_outbox o SET attempts = o.attempts + 1 FROM due c WHERE o.routing_key = c.routing_key`,
      ),
    ).toBe("scan")
  })

  it("calls a statement that reads no table table-free, and a per-deployment table registry", () => {
    expect(scopeOf("SELECT set_config('lock_timeout', $1, true)")).toBe("table-free")

    expect(scopeOf("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now")).toBe(
      "table-free",
    )

    expect(scopeOf("SELECT placement FROM actor_placements WHERE actor_type = $1")).toBe("registry")

    expect(
      scopeOf('SELECT runner, healthy FROM "cluster_runners" WHERE last_heartbeat > NOW()'),
    ).toBe("registry")
  })

  it("flags a per-actor table read that names no routing key", () => {
    expect(scopeOf("SELECT caller FROM actor_outbox WHERE intent_id = $1 AND tenant_id = $2")).toBe(
      "unkeyed",
    )

    expect(scopeOf("DELETE FROM actor_receipts WHERE expires_at_ms < $1")).toBe("unkeyed")
  })
})
