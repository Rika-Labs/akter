import { Resource } from "alchemy/Resource"
import type { DnsRecord } from "./dns-record.ts"

/**
 * The Vercel resource constructors, held in an object because the repository's lint
 * rejects exporting a bare Alchemy constructor, which has no pipeable overload.
 */
export const Vercel = {
  DnsRecord: Resource<DnsRecord>("Vercel.DnsRecord"),
}
