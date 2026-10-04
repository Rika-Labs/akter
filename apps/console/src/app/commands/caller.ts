import type { CommandCaller } from "@akter/cloud-api"
import { Function, Match } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { unknown } from "../shell/unknown.ts"
import type { Person } from "../workspace/model.ts"

/** The subject prefix of a command attributed to an API key. */
const apiKeyPrefix = "api-key:"

/** The subject prefix of a command attributed to a member. */
const userPrefix = "user:"

/**
 * Whom a command ran as, in words. A subject is the attribution the runner recorded, not proof of
 * who sent it: the control plane attributes console commands to `user:<id>` or `api-key:<id>`, but
 * an application's own authentication can carry the same subject. So only the subject's prefix
 * decides the wording, the words never claim more than the attribution, and the cell's title keeps
 * the full subject. The runtime pages know one member, the signed-in person, so a subject naming
 * them reads as their name and any other member's as written; no API key names are loaded here, so
 * an `api-key:` subject reads as `API key …` and its last six characters. Any other subject reads
 * as written. Deliveries the framework made read `System`, and unauthenticated callers `Anonymous`.
 */
export const callerText =
  (person: Pick<Person, "id" | "name">) =>
  (caller: CommandCaller | null): string => {
    if (caller === null) return unknown
    return Match.value(caller.kind).pipe(
      Match.when("system", () => "System"),
      Match.when("anonymous", () => "Anonymous"),
      Match.when("user", () => {
        const { subject } = caller
        if (subject === null) return unknown
        if (subject.startsWith(apiKeyPrefix)) return `API key …${subject.slice(-6)}`
        const own =
          person.id !== "" && person.name !== "" && subject === `${userPrefix}${person.id}`
        return own ? person.name : subject
      }),
      Match.exhaustive,
    )
  }

/**
 * Whom a command ran as, as a table cell. Its title holds the full identity, the subject or the
 * source of a system delivery, which the words may shorten or replace with a name.
 */
export const callerCell: {
  <Message>(
    h: HtmlBuilder<Message>,
    person: Pick<Person, "id" | "name">,
    caller: CommandCaller | null,
  ): Html | string
  (
    person: Pick<Person, "id" | "name">,
    caller: CommandCaller | null,
  ): <Message>(h: HtmlBuilder<Message>) => Html | string
} = Function.dual(
  3,
  <Message>(
    h: HtmlBuilder<Message>,
    person: Pick<Person, "id" | "name">,
    caller: CommandCaller | null,
  ): Html | string => {
    const text = callerText(person)(caller)
    const title = caller?.subject ?? caller?.source ?? null
    return title === null ? text : h.span([h.Title(title)], [text])
  },
)
