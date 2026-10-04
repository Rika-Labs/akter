import {
  Forbidden,
  KnownPlan,
  NotFound,
  type NotFoundResource,
  NotImplemented,
} from "@akter/cloud-api"

/** What a mocked API answers for one path: a JSON body and its status. */
export interface MockedAnswer {
  readonly status?: number
  readonly body: unknown
}

const json = (answer: MockedAnswer): Response =>
  new Response(JSON.stringify(answer.body), {
    status: answer.status ?? 200,
    headers: { "content-type": "application/json" },
  })

/** The `NotImplemented` answer the contract gives an endpoint that has no implementation yet. */
export const notImplemented = (operation: string): MockedAnswer => ({
  status: 501,
  body: NotImplemented.make({ operation }),
})

/** The `Forbidden` answer for a caller the endpoint refuses. */
export const forbidden: MockedAnswer = {
  status: 403,
  body: Forbidden.make({ message: "denied" }),
}

/** The `NotFound` answer for a resource that does not exist. */
export const notFound = (
  target: Readonly<{ resource: NotFoundResource; id: string }>,
): MockedAnswer => ({
  status: 404,
  body: NotFound.make(target),
})

/**
 * A fetch stand-in that answers each request by its URL path, ignoring the query, and records every
 * path and query it saw. A path nothing answers throws, so a test fails on an unexpected request.
 */
export const apiResponder = (answers: Readonly<Record<string, MockedAnswer>>) => {
  const seen: Array<string> = []
  const respond = (input: Request | string | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    seen.push(`${url.pathname}${url.search}`)
    const answer = answers[url.pathname]
    if (answer === undefined) return Promise.reject(new Error(`Unexpected request ${url.pathname}`))
    return Promise.resolve(json(answer))
  }
  return { respond, seen }
}

/** The session, organization and project every live loader test signs in with. */
export const signedIn = (project: Readonly<{ status: "empty" | "live"; slug?: string }>) => ({
  "/api/me": {
    body: {
      user: null,
      identityKind: "api-key",
      activeOrganizationId: "org_1",
      organizations: [
        {
          organization: {
            id: "org_1",
            name: "Acme",
            slug: "acme",
            plan: KnownPlan.make({ id: "pro" }),
            createdAt: "2026-10-01T00:00:00.000Z",
          },
          role: "owner",
        },
      ],
    },
  },
  "/api/organizations/org_1/projects": {
    body: [
      {
        id: "prj_1",
        organizationId: "org_1",
        name: "Storefront",
        slug: project.slug ?? "storefront",
        status: project.status,
        homeRegion: "us-east-1",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
  },
})
