import { Config, Effect } from "effect"
import { createHandler } from "./server.js"

const stylesheet = await Bun.file(new URL("../dist/styles.css", import.meta.url)).text()

const config = await Effect.runPromise(
  Config.all({
    port: Config.Port("PORT").pipe(Config.withDefault(3000)),
    apiOrigin: Config.String("API_ORIGIN").pipe(Config.withDefault("http://localhost:3001")),
    appOrigin: Config.String("APP_ORIGIN").pipe(Config.withDefault("http://localhost:3000")),
  }),
)

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: config.port,
  maxRequestBodySize: 1024 * 1024,
  fetch: createHandler({
    apiOrigin: config.apiOrigin,
    appOrigin: config.appOrigin,
    stylesheet,
  }),
})

Effect.runSync(Effect.log(`Forma SSR web listening on port ${server.port}`))
