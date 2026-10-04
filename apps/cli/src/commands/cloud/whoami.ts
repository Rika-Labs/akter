import { Console, Effect } from "effect"
import { Command } from "effect/cli"
import { reportFailures, signedIn } from "./client.ts"

/** `akter whoami`: who the stored session signs in as, where, and the organizations it belongs to. */
export const whoamiCommand = Command.make("whoami", {}, () =>
  Effect.gen(function* () {
    const { credentials, client } = yield* signedIn
    const me = yield* client.account.me()

    yield* Console.log(
      [
        `${me.user?.email ?? credentials.email} at ${credentials.apiUrl}`,
        ...me.organizations.map(
          (membership) =>
            `  ${membership.organization.slug}  ${membership.role}  ${membership.organization.id}`,
        ),
      ].join("\n"),
    )
  }).pipe(reportFailures),
).pipe(Command.withDescription("Show who the stored Akter Cloud session signs in as"))
