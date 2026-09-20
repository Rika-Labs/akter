import type { AcceptanceReceipt } from "@durable-actors/core"

/** HTTP representation, deliberately separate from actor domain outcomes. */
export interface AcceptedResponse {
  readonly status: 202
  readonly receipt: AcceptanceReceipt
  readonly statusLocation: string
}
