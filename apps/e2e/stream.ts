export {}

const origin = `http://127.0.0.1:${process.env.E2E_LIVE_PORT ?? "3539"}`
let opened = 0
let active = 0
let closed = 0
let maximum = 0

/** A loopback-only streaming peer measures actual cancellation rather than ending a mocked body. */
Bun.serve({
  port: Number(process.env.E2E_STREAM_PORT ?? "3540"),
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch: (request) => {
    const path = new URL(request.url).pathname
    if (path === "/stats") return Response.json({ opened, active, closed, maximum })
    if (path === "/reset") {
      if (active !== 0) return new Response("A stream is still active", { status: 409 })
      opened = 0
      closed = 0
      maximum = 0
      return new Response(null, { status: 204 })
    }
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET",
          "access-control-allow-headers": "*",
        },
      })
    if (path !== "/stream") return new Response(null, { status: 404 })
    opened += 1
    active += 1
    maximum = Math.max(maximum, active)
    let released = false
    const release = () => {
      if (released) return
      released = true
      active -= 1
      closed += 1
    }
    request.signal.addEventListener("abort", release, { once: true })
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode(": connected\n\n")),
      cancel: release,
    })
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
      },
    })
  },
})
