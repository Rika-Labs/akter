import { Effect, Exit, Schema } from "effect"
import { OpenApi } from "effect/http-api"
import { describe, expect, it } from "vitest"
import { CloudApi } from "./contract.ts"
import { DeleteAccount, OrganizationDeletion, PersonalDataExport } from "./identity.ts"

describe("account lifecycle contract", () => {
  it("requires an email confirmation and rejects an unknown deletion phase", () => {
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(DeleteAccount)))(
            '{"confirmation":""}',
          ),
        ),
      ),
    ).toBe(true)
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          Schema.decodeUnknownEffect(OrganizationDeletion)({
            organizationId: "org-a",
            phase: "accepted",
            blocked: false,
          }),
        ),
      ),
    ).toBe(true)
  })

  it("exports table-keyed JSON metadata without constraining future user-scoped tables", () => {
    const data = {
      userId: "person-a",
      exportedAt: "2026-10-06T12:00:00.000Z",
      tables: {
        session: [{ id: "session-a", userAgent: "test-browser" }],
        new_user_scoped_table: [{ preference: { enabled: true } }],
      },
    }
    const decoded = Effect.runSync(
      Schema.decodeEffect(Schema.toCodecJson(PersonalDataExport))(data),
    )
    expect(decoded.tables).toEqual(data.tables)
  })

  it("declares self-only export and deletion and organization deletion progress", () => {
    const spec = OpenApi.fromApi(CloudApi)
    expect(spec.paths["/api/me/export"]?.get?.parameters ?? []).toEqual([])
    expect(spec.paths["/api/me"]?.delete?.requestBody).toBeDefined()
    expect(spec.paths["/api/me"]?.delete?.responses["409"]).toBeDefined()
    expect(spec.paths["/api/organizations/{organizationId}/deletion"]?.get).toBeDefined()
  })
})
