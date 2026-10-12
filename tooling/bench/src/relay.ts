import { connect, createServer } from "node:net"

/** The kernel fixture adds delay; this relay only isolates the runner's network path. */
createServer((source) => {
  source.setNoDelay(true)
  const destination = connect({ host: "postgres", port: 5432 })
  destination.setNoDelay(true)
  source.pipe(destination)
  destination.pipe(source)
  source.on("error", () => destination.destroy())
  destination.on("error", () => source.destroy())
  source.on("close", () => destination.destroy())
  destination.on("close", () => source.destroy())
}).listen(5432, "0.0.0.0")
