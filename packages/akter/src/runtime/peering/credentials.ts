import type { Redacted } from "effect"

/**
 * PEM material one runner presents to and trusts from its peers.
 *
 * `ca` holds every certificate authority a peer may chain to; during a CA
 * rotation it holds both the outgoing and the incoming authority.
 * `certificate` is this runner's chain, leaf first, and `key` its private key.
 */
export interface RunnerCredentials {
  readonly ca: string
  readonly certificate: string
  readonly key: Redacted.Redacted<string>
}

const DEPLOYMENT = /^[A-Za-z0-9._-]{1,128}$/u

/** The URI prefix every Akter runner identity starts with. */
export const PREFIX = "spiffe://akter/"

/**
 * The URI subject alternative name that marks a certificate as belonging to
 * `deployment`'s runners. Peers accept a certificate only when it carries
 * exactly this one Akter identity.
 */
export const identity = (deployment: string) => {
  if (!DEPLOYMENT.test(deployment) || deployment === "." || deployment === "..")
    throw new Error(
      "Runner deployment must be 1 to 128 characters of letters, digits, '.', '_' or '-'",
    )

  return `${PREFIX}deployment/${deployment}`
}
