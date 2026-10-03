import { DateTime, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { ApiKey, CreateApiKey, CreatedApiKey, CreateInvitation, Me } from "./identity.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Effect.runSync(
    Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input)),
  )

const encode = <T, E>(schema: Schema.Codec<T, E>, value: T) =>
  Effect.runSync(Schema.encodeEffect(Schema.toCodecJson(schema))(value))

const rejects = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Exit.isFailure(
    Effect.runSyncExit(
      Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input)),
    ),
  )

const organization = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  plan: "pro",
  createdAt: "2026-10-01T12:00:00.000Z",
}

const key = {
  id: "key_1",
  organizationId: "org_1",
  name: "ci",
  prefix: "akt_live",
  lastFour: "9f2c",
  permission: "write",
  projectId: null,
  createdAt: "2026-10-02T08:30:00.000Z",
  createdBy: { kind: "user", id: "usr_1", name: "Ada" },
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
}

describe("identity models", () => {
  it("lets an API key's Me have no person but never lets the field disappear", () => {
    const base = {
      identityKind: "api-key",
      activeOrganizationId: "org_1",
      organizations: [{ organization, role: "admin" }],
    }
    expect(decode(Me, { ...base, user: null }).user).toBeNull()
    expect(rejects(Me, base)).toBe(true)

    const person = decode(Me, {
      ...base,
      identityKind: "session",
      user: {
        id: "usr_1",
        name: "Ada",
        email: "ada@acme.dev",
        emailVerified: true,
        image: null,
      },
    })
    expect(person.user?.email).toBe("ada@acme.dev")
    expect(DateTime.toEpochMillis(person.organizations[0]!.organization.createdAt)).toBe(
      Date.parse("2026-10-01T12:00:00.000Z"),
    )
  })

  it("reads an API key with no secret and re-encodes timestamps as ISO strings", () => {
    const decoded = decode(ApiKey, { ...key, secret: "akt_live_shouldNeverSurvive" })
    expect(Object.keys(decoded)).not.toContain("secret")
    expect(encode(ApiKey, decoded)).toEqual(key)
  })

  it("returns a secret only inside CreatedApiKey", () => {
    const created = decode(CreatedApiKey, { key, secret: "akt_live_abc9f2c" })
    expect(created.secret).toBe("akt_live_abc9f2c")
    expect(Object.keys(CreatedApiKey.fields)).toEqual(["key", "secret"])
    expect(Object.keys(ApiKey.fields)).not.toContain("secret")
  })

  it("rejects an API key permission outside read, write and admin", () => {
    expect(decode(CreateApiKey, { name: "ci", permission: "read" }).permission).toBe("read")
    expect(rejects(CreateApiKey, { name: "ci", permission: "owner" })).toBe(true)
    expect(rejects(CreateApiKey, { name: " ci", permission: "read" })).toBe(true)
  })

  it("never grants ownership by invitation", () => {
    expect(decode(CreateInvitation, { email: "bo@acme.dev", role: "admin" }).role).toBe("admin")
    expect(rejects(CreateInvitation, { email: "bo@acme.dev", role: "owner" })).toBe(true)
  })
})
