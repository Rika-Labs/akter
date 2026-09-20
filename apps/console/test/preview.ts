import { Config, Effect } from "effect"
import { createHandler } from "../src/server.js"
import { dashboard } from "./fixtures.js"

// Isolated rendering fixture. Never imported by the application build.
const stylesheet = await Bun.file(
  new URL("../../../packages/ui/dist/styles.css", import.meta.url),
).text()

const appOrigin = await Effect.runPromise(
  Config.String("APP_ORIGIN").pipe(Config.withDefault("http://localhost:3002")),
)

Bun.serve({
  port: 3002,
  fetch(request) {
    const empty = new URL(request.url).searchParams.has("empty")

    return createHandler({
      apiOrigin: "http://fixture.invalid",
      appOrigin,
      stylesheet,
      fetch: (input, init) =>
        Effect.runPromise(
          Effect.sync(() => {
            if (init?.method !== "GET")
              return Response.json(
                {
                  message: "This is a read-only test fixture, not a live account service.",
                },
                {
                  status: 503,
                },
              )

            if (input.pathname === "/auth/organization/list")
              return Response.json(
                empty
                  ? []
                  : [
                      dashboard.organization,
                      {
                        id: "org-2",
                        name: "Research team (test data)",
                        slug: "research",
                      },
                    ],
              )

            return Response.json({
              ...dashboard,
              organization: empty
                ? null
                : {
                    ...dashboard.organization,
                    name: "Northstar Studio (test data)",
                  },
              members: empty ? [] : dashboard.members,
              projects: empty ? [] : dashboard.projects,
            })
          }),
        ),
    })(request)
  },
})

Effect.runSync(
  Effect.log("Read-only SSR fixture preview on 3002. All mutations fail intentionally."),
)
