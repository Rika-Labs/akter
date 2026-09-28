import { Effect } from "effect"
import { Payments } from "../payments/client.ts"
import { Order } from "./contract.ts"

/** May run in another process: it gets no database, only the payment provider. */
export const OrderEffects = Order.toEffectLayer(
  Effect.gen(function* () {
    const payments = yield* Payments

    return {
      Charge: Effect.fnUntraced(function* ({ customerId, amount }) {
        const exec = yield* Order.Executor

        return yield* payments.charge({ customerId, amount }, { idempotencyKey: exec.effectId })
      }),
    }
  }),
)
