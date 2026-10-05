import { isIP } from "node:net"

/**
 * What the edge may believe about a request's origin.
 *
 * `flyProxy` is a deployment statement, not something a request can show: the
 * edge is reachable from the internet only through Fly's proxy, which sets
 * `Fly-Client-IP` to the address it accepted the connection from and replaces
 * any value the client sent. Only then is that header believed; the TCP peer
 * is then the proxy itself.
 */
export interface TrustedProxies {
  readonly flyProxy: boolean
}

interface Address {
  readonly bits: 32 | 128
  readonly value: bigint
}

/** The hextets of an IPv6 text with its `::` expanded, or none for text `isIP` accepted but cannot be split. */
const hextets = (text: string) => {
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/u.exec(text)
  let head = text

  if (embedded !== null) {
    const octets = embedded[2]!.split(".").map(Number)

    head = `${embedded[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`
  }

  const [left = "", right, extra] = head.split("::")

  if (extra !== undefined) return undefined

  const front = left === "" ? [] : left.split(":")
  const back = right === undefined || right === "" ? [] : right.split(":")
  const fill = right === undefined ? 0 : 8 - front.length - back.length

  if (fill < 0 || (right === undefined && front.length !== 8)) return undefined

  return [...front, ...Array.from({ length: fill }, () => "0"), ...back]
}

/** An IPv4-mapped IPv6 address is its IPv4 address, so one range matches either spelling. */
const parse = (text: string): Address | undefined => {
  const family = text.includes("%") ? 0 : isIP(text)

  if (family === 4) {
    const value = text.split(".").reduce((sum, octet) => (sum << 8n) + BigInt(octet), 0n)

    return { bits: 32, value }
  }

  if (family !== 6) return undefined

  const parts = hextets(text)

  if (parts === undefined) return undefined

  const value = parts.reduce((sum, part) => (sum << 16n) + BigInt(`0x${part}`), 0n)

  return value >> 32n === 0xffffn ? { bits: 32, value: value & 0xffff_ffffn } : { bits: 128, value }
}

/** The address as the edge forwards it: IPv4-mapped IPv6 collapsed, otherwise as written. */
export const normalizeIp = (text: string) => {
  const parsed = parse(text)

  if (parsed === undefined) return undefined

  if (parsed.bits === 32 && isIP(text) === 6)
    return [24n, 16n, 8n, 0n].map((shift) => String((parsed.value >> shift) & 0xffn)).join(".")

  return text.toLowerCase()
}

/**
 * Builds the client IP rule of the hosted edge.
 *
 * `Fly-Client-IP` is only a claim by whoever sent it. The edge believes it
 * when `flyProxy` is set, and only when it is exactly one address; every
 * other header, however plausible, is ignored. Without the gate the client is
 * the TCP peer, whatever headers it sent, and so it is with the gate when the
 * header is absent or not an address.
 */
export const clientIps =
  (trusted: TrustedProxies) => (peer: string | undefined, headers: Headers) => {
    const address = peer === undefined ? undefined : normalizeIp(peer)

    if (address === undefined || !trusted.flyProxy) return address

    const claimed = headers.get("fly-client-ip")?.trim()

    return (claimed === undefined ? undefined : normalizeIp(claimed)) ?? address
  }
