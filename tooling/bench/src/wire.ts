import { connect } from "node:net"
import { Duplex } from "node:stream"

/** Turn-pool diagnostic counters exclude the query, keeper and registration pools. */
export const wire = { flights: 0, statements: 0 }

/** Protocol state belongs to one session; startup and authentication are not SQL executions. */
export const frontendCounter = () => {
  let pending = Buffer.alloc(0)
  let startup = true
  return (chunk: Buffer) => {
    let statements = 0
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= (startup ? 4 : 5)) {
      const length = startup ? pending.readInt32BE(0) : pending.readInt32BE(1) + 1
      if (length < (startup ? 4 : 5)) throw new Error("Invalid Postgres frontend frame")
      if (pending.length < length) break
      if (!startup && pending[0] === 69) statements += 1
      pending = pending.subarray(length)
      startup = false
    }
    return statements
  }
}

/** Retains split protocol frames so an Execute split between writes is counted once. */
export const measuredStream = () => {
  const socket = connect({ host: "relay", port: 5432 })
  const count = frontendCounter()
  const stream = new Duplex({
    read() {
      socket.resume()
    },
    write(chunk: Buffer, _encoding, callback) {
      wire.flights += 1
      wire.statements += count(chunk)
      socket.write(chunk, callback)
    },
    destroy(error, callback) {
      socket.destroy()
      callback(error)
    },
  })
  socket.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) socket.pause()
  })
  socket.on("end", () => stream.push(null))
  socket.on("error", (error) => stream.destroy(error))
  return stream
}
