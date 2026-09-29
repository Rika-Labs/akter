import { once } from "node:events"
import {
  type AddressInfo,
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net"

/**
 * A TCP proxy in front of the chat server that the test can cut, the way a
 * lost network would: `cut` destroys every open connection and refuses new
 * ones until `restore`. Chromium's offline mode alone leaves an open stream up.
 */
export const proxy = async () => {
  const sockets = new Set<Socket>()
  let down = false

  const server: Server = createServer((client) => {
    if (down) return client.destroy()

    const upstream = createConnection({ host: "127.0.0.1", port: 3003 })
    sockets.add(client).add(upstream)
    client.pipe(upstream)
    upstream.pipe(client)

    for (const socket of [client, upstream]) {
      socket.on("error", () => undefined)
      socket.on("close", () => {
        sockets.delete(socket)
        client.destroy()
        upstream.destroy()
      })
    }
  })

  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    cut: () => {
      down = true

      for (const socket of sockets) socket.destroy()
    },
    restore: () => {
      down = false
    },
    // The page may still hold a feed or a connection open; closing waits for none.
    close: async () => {
      server.close()

      for (const socket of sockets) socket.destroy()
      await once(server, "close")
    },
  }
}
