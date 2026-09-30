import { Context, Effect, Option } from "effect"
import { CurrentCaller, System, Tenant } from "../identity/caller.ts"
import { checkExecutionKey } from "../identity/execution.ts"
import type { RegisteredWorkflow } from "../runtime/members.ts"
import type { Descriptor } from "./descriptor.ts"

type Body = (input: unknown) => Effect.Effect<unknown, unknown, unknown>

/**
 * Every workflow's body. A body runs outside turns with the layer's context
 * minus its `Scope`, since a body's scope is its run's, and calls as the
 * execution's recorded principal through a `System({ source: "workflow" })`
 * caller.
 */
export const workflowsOf = (
  descriptor: Descriptor,
  Workflow: Context.Key<unknown, unknown>,
  bodies: Readonly<Record<string, Body | undefined>>,
  services: Context.Context<never>,
) =>
  Effect.gen(function* () {
    const registered = new Map<string, RegisteredWorkflow>()

    for (const member of descriptor.workflows) {
      const body = bodies[member.tag]

      if (body === undefined) return yield* Effect.die(new Error(`Missing workflow ${member.tag}`))

      const codecs = descriptor.codecs.get(member.tag)!

      registered.set(member.tag, {
        member,
        steps: new Map(member.registry.steps),
        key: (payload, fallback) =>
          Effect.gen(function* () {
            if (member.key === undefined) return fallback

            const input = yield* codecs.decodeInput(payload)
            const key = member.key(input.value)

            yield* checkExecutionKey(key)

            return key
          }).pipe(Effect.orDie),
        run: (payload, context) =>
          codecs.decodeInput(payload).pipe(
            Effect.orDie,
            Effect.flatMap((input) => body(input.value)),
            Effect.exit,
            Effect.provideContext(
              Context.merge(Context.make(Workflow, context), services).pipe(
                Context.add(Tenant, context.ref.tenant),
                Context.add(
                  CurrentCaller,
                  System.make({
                    source: "workflow",
                    ref: context.ref,
                    onBehalfOf: Option.getOrUndefined(context.principal),
                  }),
                ),
              ),
            ),
          ) as ReturnType<RegisteredWorkflow["run"]>,
        encodeExit: descriptor.workflowExits.get(member.tag)!.encode,
      })
    }

    return registered as ReadonlyMap<string, RegisteredWorkflow>
  })
