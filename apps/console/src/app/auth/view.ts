import {
  avatar,
  button,
  choiceCards,
  codeBlock,
  field,
  illustration,
  input,
  mark,
  styleAttributes,
} from "@akter/ui"
import { letterOnContainer } from "@akter/ui/brand"
import { Match, Option, Predicate } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { fixturesEnabled, socialProviders } from "../api/client.ts"
import { AppRoute } from "../navigation/routes.ts"
import * as Routes from "../navigation/routes.ts"
import {
  ChangedField,
  ChoseSetting,
  CopiedText,
  type Message,
  RetriedPage,
  SubmittedForm,
} from "../shell/message.ts"
import type { Model, PageError } from "../shell/model.ts"
import type { Screen, ScreenInput } from "../shell/screen.ts"
import { displayUserCode, type DeviceProblem, type DeviceReview } from "../device/model.ts"
import { pageOf } from "../shell/screen.ts"
import { homeRegions, type InvitationPage, onboardingStep, onboardingSteps } from "./model.ts"
import { planLabel } from "../workspace/model.ts"
import { authLayout, authStyles as styles, deviceStyles } from "./styles.ts"

const fill = authLayout.fill

type H = HtmlBuilder<Message>

const textField = (
  h: H,
  model: Model,
  config: Readonly<{
    name: string
    label: string
    type?: "text" | "email" | "password"
    placeholder?: string
    autocomplete: string
    description?: string
    trailing?: Html
    minlength?: number
  }>,
): Html =>
  field(h, {
    id: config.name,
    label: config.label,
    description: config.description,
    trailing: config.trailing,
    control: input(h, {
      name: config.name,
      value: model.fields[config.name] ?? "",
      type: config.type ?? "text",
      placeholder: config.placeholder,
      autocomplete: config.autocomplete,
      size: "lg",
      required: true,
      describedBy: config.description === undefined ? undefined : `${config.name}-description`,
      attributes: config.minlength === undefined ? [] : [h.Minlength(config.minlength)],
      onInput: (value) => ChangedField({ name: config.name, value }),
    }),
  })

const organizationSlug = (model: Model): string => {
  const slug = model.fields["org-slug"]
  return slug === undefined || slug === "" ? "acme" : slug
}

const column = (h: H, children: ReadonlyArray<Html>, wide = false): Html =>
  h.main(
    [h.Id("main"), ...styleAttributes(h, styles.page)],
    [h.div([...styleAttributes(h, styles.column, wide && styles.wide)], children)],
  )

const heading = (h: H, title: string, lead?: Html | string): ReadonlyArray<Html> => [
  h.a([h.Href(Routes.overview()), h.AriaLabel("Akter")], [mark(h, { size: 26 })]),
  h.h1([...styleAttributes(h, styles.title)], [title]),
  lead === undefined ? h.empty : h.p([...styleAttributes(h, styles.lead)], [lead]),
]

const providers = (h: H, model: Model): ReadonlyArray<Html> => {
  const configured = socialProviders()
  if (configured.length === 0) return []
  return [
    ...(configured.includes("github")
      ? [
          button(h, {
            label: "Continue with GitHub",
            icon: "github",
            size: "lg",
            onClick: SubmittedForm({ form: "social-github" }),
            disabled: model.submitting,
            style: fill,
          }),
        ]
      : []),
    ...(configured.includes("google")
      ? [
          button(h, {
            label: "Continue with Google",
            size: "lg",
            onClick: SubmittedForm({ form: "social-google" }),
            disabled: model.submitting,
            style: fill,
          }),
        ]
      : []),
    h.div([h.AriaHidden(true), ...styleAttributes(h, styles.divider)], ["or"]),
  ]
}

const failureNote = (h: H, model: Model): Html =>
  Option.match(model.formError, {
    onNone: () => h.empty,
    onSome: (message) => h.p([h.Role("alert"), ...styleAttributes(h, styles.error)], [message]),
  })

const form = (h: H, model: Model, name: string, children: ReadonlyArray<Html>): Html =>
  h.form(
    [
      h.OnSubmit(SubmittedForm({ form: name })),
      h.AriaLabel(name),
      ...styleAttributes(h, styles.form),
    ],
    [...children, failureNote(h, model)],
  )

const foot = (h: H, text: string, link: Readonly<{ label: string; href: string }>): Html =>
  h.p(
    [...styleAttributes(h, styles.foot)],
    [`${text} `, h.a([h.Href(link.href), ...styleAttributes(h, styles.link)], [link.label])],
  )

const submit = (h: H, model: Model, label: string): Html =>
  button(h, {
    label,
    variant: "primary",
    size: "lg",
    type: "submit",
    disabled: model.submitting,
    style: fill,
  })

const signIn = (h: H, model: Model): Screen => ({
  title: "Sign in",
  crumbs: [],
  body: column(h, [
    ...heading(h, "Sign in to Akter"),
    ...providers(h, model),
    form(h, model, "sign-in", [
      textField(h, model, {
        name: "email",
        label: "Email",
        type: "email",
        placeholder: "you@company.com",
        autocomplete: "email",
      }),
      textField(h, model, {
        name: "password",
        label: "Password",
        type: "password",
        autocomplete: "current-password",
        trailing: h.a(
          [h.Href(Routes.forgotPassword()), ...styleAttributes(h, styles.link)],
          ["Forgot?"],
        ),
      }),
      submit(h, model, "Continue"),
    ]),
    foot(h, "No account?", { label: "Sign up", href: Routes.signUp() }),
  ]),
})

const signUp = (h: H, model: Model): Screen => ({
  title: "Create an account",
  crumbs: [],
  body: column(h, [
    ...heading(h, "Create your account", "Your actors on our runners, your data in Postgres."),
    ...providers(h, model),
    form(h, model, "sign-up", [
      textField(h, model, {
        name: "name",
        label: "Name",
        placeholder: "Ada Lovelace",
        autocomplete: "name",
      }),
      textField(h, model, {
        name: "email",
        label: "Work email",
        type: "email",
        placeholder: "ada@company.com",
        autocomplete: "email",
      }),
      textField(h, model, {
        name: "new-password",
        label: "Password",
        type: "password",
        autocomplete: "new-password",
        description: "At least 12 characters.",
        minlength: 12,
      }),
      submit(h, model, "Create account"),
    ]),
    foot(h, "Already have an account?", { label: "Sign in", href: Routes.signIn() }),
  ]),
})

const verifyEmail = (h: H, model: Model): Screen => ({
  title: "Verify your email",
  crumbs: [],
  body: column(h, [
    h.div(
      [...styleAttributes(h, styles.art)],
      [illustration(h, { drawing: letterOnContainer.drawing, viewBox: letterOnContainer.viewBox })],
    ),
    h.h1([...styleAttributes(h, styles.title)], ["Check your inbox"]),
    h.p(
      [...styleAttributes(h, styles.lead)],
      [
        "We sent a link to ",
        h.span([...styleAttributes(h, styles.strong)], [model.fields["email"] ?? "your email"]),
        ". Open it on this device to verify your address.",
      ],
    ),
    button(h, {
      label: "Continue",
      variant: "primary",
      size: "lg",
      onClick: SubmittedForm({ form: "verify-continue" }),
      disabled: model.submitting,
      style: fill,
    }),
    button(h, {
      label: "Resend email",
      size: "lg",
      onClick: SubmittedForm({ form: "verify-resend" }),
      disabled: model.submitting,
      style: fill,
    }),
    failureNote(h, model),
    foot(h, "Wrong address?", { label: "Use a different email", href: Routes.signUp() }),
  ]),
})

const forgotPassword = (h: H, model: Model): Screen => ({
  title: "Reset your password",
  crumbs: [],
  body: column(
    h,
    model.fields["recoverySent"] === "yes"
      ? [
          ...heading(
            h,
            "Check your inbox",
            "If that email has an account, a reset link is on its way. It works for one hour.",
          ),
          fixturesEnabled()
            ? button(h, {
                label: "Open the reset link",
                variant: "primary",
                size: "lg",
                href: Routes.resetPassword(),
                style: fill,
              })
            : h.empty,
          foot(h, "Remembered it?", { label: "Back to sign in", href: Routes.signIn() }),
        ]
      : [
          ...heading(h, "Reset your password", "Enter the email you signed up with."),
          form(h, model, "forgot", [
            textField(h, model, {
              name: "email",
              label: "Email",
              type: "email",
              placeholder: "you@company.com",
              autocomplete: "email",
            }),
            submit(h, model, "Send reset link"),
          ]),
          foot(h, "Remembered it?", { label: "Back to sign in", href: Routes.signIn() }),
        ],
  ),
})

const resetPassword = (h: H, model: Model): Screen => ({
  title: "Choose a new password",
  crumbs: [],
  body: column(h, [
    ...heading(h, "Choose a new password", "Other sessions are signed out when you save it."),
    form(h, model, "reset", [
      textField(h, model, {
        name: "new-password",
        label: "New password",
        type: "password",
        autocomplete: "new-password",
        description: "At least 12 characters.",
        minlength: 12,
      }),
      textField(h, model, {
        name: "confirm-password",
        label: "Confirm password",
        type: "password",
        autocomplete: "new-password",
        minlength: 12,
      }),
      submit(h, model, "Update password"),
    ]),
  ]),
})

const invitation = (h: H, model: Model, page: Option.Option<InvitationPage>): Screen => ({
  title: "Accept invitation",
  crumbs: [],
  body: Option.match(page, {
    onNone: () => column(h, [...heading(h, "Opening invitation")]),
    onSome: (invite) =>
      column(h, [
        h.div(
          [...styleAttributes(h, styles.organization)],
          [
            avatar(h, { name: invite.organization, size: "lg", kind: "organization" }),
            h.div(
              [],
              [
                h.p([...styleAttributes(h, styles.strong)], [invite.organization]),
                h.p(
                  [...styleAttributes(h, styles.note)],
                  [`${String(invite.members)} members · ${planLabel(invite.plan, invite.catalog)}`],
                ),
              ],
            ),
          ],
        ),
        h.h1([...styleAttributes(h, styles.title)], [`Join ${invite.organization} on Akter`]),
        h.p(
          [...styleAttributes(h, styles.lead)],
          [
            h.span([...styleAttributes(h, styles.strong)], [invite.inviter]),
            " invited ",
            h.span([...styleAttributes(h, styles.strong)], [invite.email]),
            ` as a ${invite.role}. You will be able to deploy, inspect actors and retry jobs.`,
          ],
        ),
        button(h, {
          label: "Accept invitation",
          variant: "primary",
          size: "lg",
          onClick: SubmittedForm({ form: "accept-invitation" }),
          disabled: model.submitting,
          style: fill,
        }),
        button(h, {
          label: "Decline",
          variant: "ghost",
          size: "lg",
          onClick: SubmittedForm({ form: "decline-invitation" }),
          disabled: model.submitting,
          style: fill,
        }),
        failureNote(h, model),
      ]),
  }),
})

const stepIndicator = (h: H, current: number): ReadonlyArray<Html> => [
  h.div(
    [h.AriaHidden(true), ...styleAttributes(h, styles.steps)],
    onboardingSteps.map((_, index) =>
      h.span([...styleAttributes(h, styles.step, index <= current && styles.stepDone)], []),
    ),
  ),
  h.p(
    [...styleAttributes(h, styles.stepLabel)],
    [`Step ${String(current + 1)} of ${String(onboardingSteps.length)}`],
  ),
]

const onboarding = (h: H, model: Model, step: string | undefined): Screen => {
  const current = onboardingStep(step)
  const index = onboardingSteps.indexOf(current)
  const back = (href: string) =>
    button(h, { label: "Back", variant: "ghost", icon: "arrowLeft", href })
  const body = (): ReadonlyArray<Html> => {
    if (current === "organization")
      return [
        h.h1([...styleAttributes(h, styles.title)], ["Name your organization"]),
        h.p([...styleAttributes(h, styles.lead)], ["Projects, members and billing live under it."]),
        form(h, model, "onboarding-organization", [
          textField(h, model, {
            name: "org-name",
            label: "Organization",
            placeholder: "Acme",
            autocomplete: "organization",
          }),
          textField(h, model, {
            name: "org-slug",
            label: "URL",
            placeholder: "acme",
            autocomplete: "off",
            description: `akter.cloud/${organizationSlug(model)}`,
          }),
          h.div(
            [...styleAttributes(h, styles.row)],
            [
              h.span([], []),
              button(h, {
                label: "Continue",
                variant: "primary",
                type: "submit",
                disabled: model.submitting,
              }),
            ],
          ),
        ]),
      ]
    if (current === "project")
      return [
        h.h1([...styleAttributes(h, styles.title)], ["Create your first project"]),
        h.p(
          [...styleAttributes(h, styles.lead)],
          ["Your actors and their rows live in its home region. You can add regions later."],
        ),
        form(h, model, "onboarding-project", [
          textField(h, model, {
            name: "project-name",
            label: "Project",
            placeholder: "storefront",
            autocomplete: "off",
          }),
          choiceCards(h, {
            label: "Home region",
            selected: model.choices["homeRegion"] ?? "us-east-1",
            onSelect: (value) => ChoseSetting({ key: "homeRegion", value }),
            choices: homeRegions.map((region) => ({
              value: region.id,
              label: region.id,
              preview: h.span(
                [...styleAttributes(h, styles.region)],
                [h.span([...styleAttributes(h, styles.regionPlace)], [region.place])],
              ),
            })),
          }),
          h.div(
            [...styleAttributes(h, styles.row)],
            [
              back(Routes.onboarding({ step: "organization" })),
              button(h, {
                label: "Continue",
                variant: "primary",
                type: "submit",
                disabled: model.submitting,
              }),
            ],
          ),
        ]),
      ]
    return [
      h.h1([...styleAttributes(h, styles.title)], ["Connect and deploy"]),
      h.p(
        [...styleAttributes(h, styles.lead)],
        ["Connect GitHub to deploy on every push to main, or deploy from your machine."],
      ),
      button(h, {
        label: "Connect GitHub",
        icon: "github",
        size: "lg",
        href: Routes.settingsIntegrations(),
        style: fill,
      }),
      h.div([h.AriaHidden(true), ...styleAttributes(h, styles.divider)], ["or"]),
      codeBlock(h, {
        language: "shell",
        code: "$ bun add @rikalabs/akter@alpha\n$ bunx akter login\n$ bunx akter deploy",
        onCopy: CopiedText({ text: "bun add @rikalabs/akter@alpha", label: "install command" }),
      }),
      h.form(
        [
          h.OnSubmit(SubmittedForm({ form: "onboarding-deploy" })),
          ...styleAttributes(h, styles.form),
        ],
        [
          h.div(
            [...styleAttributes(h, styles.row)],
            [
              back(Routes.onboarding({ step: "project" })),
              button(h, { label: "Go to project", variant: "primary", type: "submit" }),
            ],
          ),
        ],
      ),
    ]
  }
  return {
    title: "Set up Akter",
    crumbs: [],
    body: column(
      h,
      [
        h.a([h.Href(Routes.overview()), h.AriaLabel("Akter")], [mark(h, { size: 26 })]),
        ...stepIndicator(h, index),
        ...body(),
      ],
      true,
    ),
  }
}

const deviceAction = (
  h: H,
  model: Model,
  config: Readonly<{ label: string; form: string; quiet?: boolean }>,
): Html =>
  button(h, {
    label: config.label,
    variant: config.quiet === true ? "ghost" : "primary",
    size: "lg",
    onClick: SubmittedForm({ form: config.form }),
    disabled: model.submitting,
    style: fill,
  })

const deviceColumn = (h: H, body: ReadonlyArray<Html>): Screen => ({
  title: "Connect a device",
  crumbs: [],
  body: column(h, body),
})

/** The code field, filled from the link's `user_code` until the person types. */
const deviceEntry = (h: H, model: Model): Screen => {
  const linked = AppRoute.isAnyOf(["Device"])(model.route) ? model.route.user_code : undefined
  return deviceColumn(h, [
    ...heading(h, "Connect a device", "Enter the code shown in your terminal."),
    h.form(
      [
        h.OnSubmit(SubmittedForm({ form: "device-code" })),
        h.AriaLabel("device-code"),
        ...styleAttributes(h, styles.form),
      ],
      [
        field(h, {
          id: "device-code",
          label: "Code",
          control: input(h, {
            name: "device-code",
            value: model.fields["device-code"] ?? linked ?? "",
            placeholder: "ABCD-EFGH",
            autocomplete: "off",
            size: "lg",
            required: true,
            mono: true,
            attributes: [h.Autocapitalize("characters")],
            onInput: (value) => ChangedField({ name: "device-code", value }),
          }),
        }),
        button(h, {
          label: "Continue",
          variant: "primary",
          size: "lg",
          type: "submit",
          disabled: model.submitting,
          style: fill,
        }),
        failureNote(h, model),
      ],
    ),
  ])
}

const deviceRow = (
  h: H,
  term: string,
  detail: ReadonlyArray<Html | string>,
): ReadonlyArray<Html> => [
  h.dt([...styleAttributes(h, deviceStyles.term)], [term]),
  h.dd([...styleAttributes(h, deviceStyles.detail)], detail),
]

/**
 * A looked-up code: who is asking, the code itself to compare with the terminal, and the account
 * and organizations approving it signs in to. Approve and Deny appear only here.
 */
const deviceReview = (h: H, model: Model, step: DeviceReview): Screen =>
  deviceColumn(h, [
    ...heading(h, `Authorize ${step.client}`, step.clientDetail),
    h.p(
      [...styleAttributes(h, deviceStyles.prompt)],
      ["Check this code matches the one in your terminal."],
    ),
    h.p(
      [h.Id("device-user-code"), ...styleAttributes(h, deviceStyles.code)],
      [displayUserCode(step.code)],
    ),
    h.dl(
      [h.AriaLabel("Signs in as"), ...styleAttributes(h, deviceStyles.details)],
      [
        ...deviceRow(h, "Account", [
          step.name === "" ? step.email : step.name,
          step.name === ""
            ? h.empty
            : h.span([...styleAttributes(h, deviceStyles.email)], [step.email]),
        ]),
        ...deviceRow(h, "Access", [step.access]),
      ],
    ),
    deviceAction(h, model, { label: "Approve", form: "device-approve" }),
    deviceAction(h, model, { label: "Deny", form: "device-deny", quiet: true }),
    failureNote(h, model),
  ])

const deviceProblems: Readonly<
  Record<DeviceProblem, Readonly<{ title: string; lead: string; retry: boolean }>>
> = {
  invalid: {
    title: "This code isn’t valid",
    lead: "It may have expired or already been used. Check it against the code in your terminal, or start the sign-in again.",
    retry: false,
  },
  expired: {
    title: "This code has expired",
    lead: "Start the sign-in again in your terminal to get a new code.",
    retry: false,
  },
  elsewhere: {
    title: "This code belongs to another account",
    lead: "Another account opened it first. Start the sign-in again in your terminal to get a new code.",
    retry: false,
  },
  slowDown: {
    title: "Too many attempts",
    lead: "Wait a minute, then try again.",
    retry: true,
  },
  unreachable: {
    title: "We couldn’t reach Akter",
    lead: "Check your connection, then try again.",
    retry: true,
  },
}

const deviceRefused = (h: H, model: Model, problem: DeviceProblem): Screen => {
  const words = deviceProblems[problem]
  return deviceColumn(h, [
    ...heading(h, words.title, words.lead),
    words.retry
      ? deviceAction(h, model, { label: "Try again", form: "device-retry" })
      : deviceAction(h, model, { label: "Enter another code", form: "device-restart" }),
    failureNote(h, model),
  ])
}

const deviceDecided = (h: H, decision: "approved" | "denied"): Screen =>
  decision === "approved"
    ? deviceColumn(h, [
        ...heading(
          h,
          "You can return to your terminal",
          "The sign-in was approved. Your terminal finishes on its own in a few seconds.",
        ),
        foot(h, "Done here?", { label: "Go to the console", href: Routes.overview() }),
      ])
    : deviceColumn(h, [
        ...heading(h, "Request denied", "Nothing was signed in. Your terminal will say so."),
        foot(h, "Done here?", { label: "Go to the console", href: Routes.overview() }),
      ])

/**
 * `/device`, where a signed-in person approves the code the CLI printed. It asks for the code,
 * looks it up, and only then shows the code, the account and Approve or Deny.
 */
const device = (h: H, model: Model): Screen =>
  Option.match(pageOf("DevicePage")(model), {
    onNone: () => deviceEntry(h, model),
    onSome: ({ step }) =>
      Match.value(step).pipe(
        Match.tagsExhaustive({
          DeviceEntry: () => deviceEntry(h, model),
          DeviceReview: (found) => deviceReview(h, model, found),
          DeviceRefused: ({ problem }) => deviceRefused(h, model, problem),
          DeviceDecided: ({ decision }) => deviceDecided(h, decision),
        }),
      ),
  })

const waiting = (h: H): Screen => ({
  title: "Akter",
  crumbs: [],
  body: h.main(
    [h.Id("main"), h.AriaBusy(true), ...styleAttributes(h, styles.page)],
    [
      h.div(
        [...styleAttributes(h, styles.column)],
        [h.a([h.Href(Routes.overview()), h.AriaLabel("Akter")], [mark(h, { size: 26 })])],
      ),
    ],
  ),
})

const failure = (h: H, error: PageError): Screen => ({
  title: "Couldn’t open this page",
  crumbs: [],
  body: column(h, [
    ...heading(h, "This page couldn’t open", error.message),
    button(h, {
      label: "Try again",
      variant: "primary",
      size: "lg",
      onClick: RetriedPage(),
      style: fill,
    }),
    foot(h, "Or", { label: "go to sign in", href: Routes.signIn() }),
  ]),
})

/** The signed-out screens and onboarding, drawn without the application frame. */
export const authScreen = ({ h, model }: ScreenInput<undefined>): Screen =>
  Option.match(model.pageError, {
    onSome: (error) => failure(h, error),
    onNone: () => (model.loading ? waiting(h) : authRoute(h, model)),
  })

const authRoute = (h: H, model: Model): Screen =>
  AppRoute.matchOrElse(
    model.route,
    {
      SignIn: () => signIn(h, model),
      SignUp: () => signUp(h, model),
      VerifyEmail: () => verifyEmail(h, model),
      ForgotPassword: () => forgotPassword(h, model),
      ResetPassword: () => resetPassword(h, model),
      AcceptInvitation: () =>
        invitation(
          h,
          model,
          Option.filter(model.page, (page): page is InvitationPage =>
            Predicate.isTagged(page, "InvitationPage"),
          ),
        ),
      Device: () => device(h, model),
      Onboarding: ({ step }) => onboarding(h, model, step),
    },
    () => signIn(h, model),
  )
