import type { ConformanceCase } from "../conformance.ts"
import { subscriptionAccessConformance } from "./subscriptions/access.ts"
import { subscriptionDeliveryConformance } from "./subscriptions/delivery.ts"
import { subscriptionDeployConformance } from "./subscriptions/deploys.ts"
import { subscriptionEpochConformance } from "./subscriptions/epochs.ts"
import { subscriptionFailureConformance } from "./subscriptions/failures.ts"
import { subscriptionFeedConformance } from "./subscriptions/feeds.ts"
import { subscriptionOperatorConformance } from "./subscriptions/operator.ts"
import { subscriptionRoutingConformance } from "./subscriptions/routing.ts"

/** Subscription cases: routing, start positions, delivery, and failure handling of event subscriptions. */
export const subscriptionsConformance: ReadonlyArray<ConformanceCase> = [
  ...subscriptionRoutingConformance,
  ...subscriptionEpochConformance,
  ...subscriptionFeedConformance,
  ...subscriptionDeliveryConformance,
  ...subscriptionOperatorConformance,
  ...subscriptionFailureConformance,
  ...subscriptionAccessConformance,
  ...subscriptionDeployConformance,
]
