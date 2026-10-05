import { accessibility, styleAttributes } from "@akter/ui"
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
import { actionButton, divider, providerButton, textField as field } from "./controls.ts"
import type { TextFieldConfig } from "./controls.ts"
import { frame } from "./frame.ts"
import { authStyles as styles, deviceStyles } from "./styles.ts"

type H = HtmlBuilder<Message>

const textField = (h: H, model: Model, config: Omit<TextFieldConfig, "value" | "onInput">): Html =>
  field(h, {
    ...config,
    value: model.fields[config.name] ?? "",
    onInput: (value) => ChangedField({ name: config.name, value }),
  })

const organizationSlug = (model: Model): string => {
  const slug = model.fields["org-slug"]
  return slug === undefined || slug === "" ? "acme" : slug
}

const heading = (h: H, title: string, lead?: Html | string): ReadonlyArray<Html> => [
  h.h1([...styleAttributes(h, styles.title)], [title]),
  lead === undefined ? h.empty : h.p([...styleAttributes(h, styles.lead)], [lead]),
]

const providerWords = {
  github: { label: "Continue with GitHub", icon: "github" },
  google: { label: "Continue with Google", icon: "google" },
} as const

const providers = (h: H, model: Model): ReadonlyArray<Html> => {
  const configured = socialProviders()
  if (configured.length === 0) return []
  return [
    h.div(
      [...styleAttributes(h, styles.oauth)],
      configured.map((provider) =>
        providerButton(h, {
          ...providerWords[provider],
          onClick: SubmittedForm({ form: `social-${provider}` }),
          disabled: model.submitting,
        }),
      ),
    ),
    divider(h),
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

const fine = (h: H, text: string, link: Readonly<{ label: string; href: string }>): Html =>
  h.p(
    [...styleAttributes(h, styles.fine)],
    [`${text} `, h.a([h.Href(link.href), ...styleAttributes(h, styles.fineLink)], [link.label])],
  )

const submit = (h: H, model: Model, label: string, marked = false): Html =>
  h.div(
    [...styleAttributes(h, styles.submit)],
    [actionButton(h, { label, type: "submit", disabled: model.submitting, mark: marked })],
  )

const actions = (h: H, buttons: ReadonlyArray<Html>): Html =>
  h.div([...styleAttributes(h, styles.stack)], buttons)

const signIn = (h: H, model: Model): Screen => ({
  title: "Sign in",
  crumbs: [],
  body: frame(h, { alt: { text: "No account?", label: "Sign up", href: Routes.signUp() } }, [
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
        placeholder: "••••••••••",
        autocomplete: "current-password",
        trailing: h.a(
          [h.Href(Routes.forgotPassword()), ...styleAttributes(h, styles.link)],
          ["Forgot password?"],
        ),
      }),
      submit(h, model, "Sign in", true),
    ]),
  ]),
})

const signUp = (h: H, model: Model): Screen => ({
  title: "Create an account",
  crumbs: [],
  body: frame(h, { alt: { text: "Have an account?", label: "Sign in", href: Routes.signIn() } }, [
    ...heading(
      h,
      "Create your account",
      "Your actors on our runners, your data in a Postgres database.",
    ),
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
        placeholder: "you@company.com",
        autocomplete: "email",
      }),
      textField(h, model, {
        name: "new-password",
        label: "Password",
        type: "password",
        placeholder: "At least 12 characters",
        autocomplete: "new-password",
        minlength: 12,
      }),
      submit(h, model, "Create account", true),
    ]),
  ]),
})

const inbox = (h: H): Html =>
  h.div(
    [...styleAttributes(h, styles.tile)],
    [
      h.svg(
        [
          h.ViewBox("0 0 24 24"),
          h.Width("24"),
          h.Height("24"),
          h.AriaHidden(true),
          h.Attribute("fill", "none"),
          h.Attribute("stroke", "currentColor"),
          h.StrokeWidth("1.5"),
        ],
        [h.path([h.D("M3 5h18v14H3Z M3 6l9 7 9-7")], [])],
      ),
    ],
  )

const verifyEmail = (h: H, model: Model): Screen => ({
  title: "Verify your email",
  crumbs: [],
  body: frame(h, { alt: { text: "Wrong email?", label: "Start over", href: Routes.signUp() } }, [
    inbox(h),
    ...heading(
      h,
      "Check your inbox",
      h.span(
        [],
        [
          "We sent a link to ",
          h.span([...styleAttributes(h, styles.strong)], [model.fields["email"] ?? "your email"]),
          ". Open it on this device to verify your address.",
        ],
      ),
    ),
    actions(h, [
      actionButton(h, {
        label: "Continue",
        onClick: SubmittedForm({ form: "verify-continue" }),
        disabled: model.submitting,
      }),
      actionButton(h, {
        label: "Resend the link",
        variant: "ghost",
        onClick: SubmittedForm({ form: "verify-resend" }),
        disabled: model.submitting,
      }),
    ]),
    failureNote(h, model),
  ]),
})

const forgotPassword = (h: H, model: Model): Screen => ({
  title: "Reset your password",
  crumbs: [],
  body: frame(
    h,
    { alt: { text: "Remembered it?", label: "Sign in", href: Routes.signIn() } },
    model.fields["recoverySent"] === "yes"
      ? [
          ...heading(
            h,
            "Check your inbox",
            "If that email has an account, a reset link is on its way. It works for one hour.",
          ),
          fixturesEnabled()
            ? actions(h, [
                actionButton(h, { label: "Open the reset link", href: Routes.resetPassword() }),
              ])
            : h.empty,
        ]
      : [
          ...heading(
            h,
            "Reset your password",
            "Enter the email you signed up with and we’ll send you a link.",
          ),
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
        ],
  ),
})

const resetPassword = (h: H, model: Model): Screen => ({
  title: "Choose a new password",
  crumbs: [],
  body: frame(h, { alt: { text: "Remembered it?", label: "Sign in", href: Routes.signIn() } }, [
    ...heading(h, "Choose a new password", "Other sessions are signed out when you save it."),
    form(h, model, "reset", [
      textField(h, model, {
        name: "new-password",
        label: "New password",
        type: "password",
        placeholder: "At least 12 characters",
        autocomplete: "new-password",
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
    onNone: () => frame(h, { busy: true }, [...heading(h, "Opening invitation")]),
    onSome: (invite) =>
      frame(h, {}, [
        h.div([...styleAttributes(h, styles.tile)], [invite.organization.slice(0, 1)]),
        ...heading(
          h,
          `Join ${invite.organization} on Akter`,
          h.span(
            [],
            [
              h.span([...styleAttributes(h, styles.strong)], [invite.inviter]),
              " invited ",
              h.span([...styleAttributes(h, styles.strong)], [invite.email]),
              ` as a ${invite.role}. You will be able to deploy, inspect actors and retry jobs.`,
            ],
          ),
        ),
        actions(h, [
          actionButton(h, {
            label: "Accept invitation",
            onClick: SubmittedForm({ form: "accept-invitation" }),
            disabled: model.submitting,
          }),
          actionButton(h, {
            label: "Decline",
            variant: "ghost",
            onClick: SubmittedForm({ form: "decline-invitation" }),
            disabled: model.submitting,
          }),
        ]),
        failureNote(h, model),
        h.p(
          [...styleAttributes(h, styles.fine)],
          [`${String(invite.members)} members · ${planLabel(invite.plan, invite.catalog)}`],
        ),
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

const regionChoice = (h: H, model: Model): Html => {
  const selected = model.choices["homeRegion"] ?? "us-east-1"
  return h.div(
    [],
    [
      h.p([...styleAttributes(h, styles.regionLegend)], ["Home region"]),
      h.div(
        [h.Role("radiogroup"), h.AriaLabel("Home region"), ...styleAttributes(h, styles.regions)],
        homeRegions.map((region) =>
          h.button(
            [
              h.Type("button"),
              h.Role("radio"),
              h.AriaChecked(region.id === selected),
              h.Tabindex(region.id === selected ? 0 : -1),
              h.OnClick(ChoseSetting({ key: "homeRegion", value: region.id })),
              h.DataAttribute("choice", region.id),
              ...styleAttributes(
                h,
                styles.region,
                region.id === selected && styles.regionSelected,
                accessibility.focusRing,
              ),
            ],
            [
              h.span([...styleAttributes(h, styles.regionId)], [region.id]),
              h.span([...styleAttributes(h, styles.regionPlace)], [region.place]),
            ],
          ),
        ),
      ),
    ],
  )
}

const installCommand = "bun add @rikalabs/akter@alpha"

const commands = (h: H): Html =>
  h.div(
    [...styleAttributes(h, styles.commandsBox)],
    [
      h.pre(
        [...styleAttributes(h, styles.commands)],
        [
          h.code(
            [],
            [
              h.span([...styleAttributes(h, styles.prompt)], ["$ "]),
              `${installCommand}\n`,
              h.span([...styleAttributes(h, styles.prompt)], ["$ "]),
              "bunx akter login\n",
              h.span([...styleAttributes(h, styles.prompt)], ["$ "]),
              "bunx akter deploy",
            ],
          ),
        ],
      ),
      h.button(
        [
          h.Type("button"),
          h.AriaLabel("Copy install command"),
          h.OnClick(CopiedText({ text: installCommand, label: "install command" })),
          ...styleAttributes(h, styles.copyButton, accessibility.focusRing),
        ],
        ["Copy"],
      ),
    ],
  )

const onboarding = (h: H, model: Model, step: string | undefined): Screen => {
  const current = onboardingStep(step)
  const index = onboardingSteps.indexOf(current)
  const back = (href: string) =>
    actionButton(h, { label: "Back", variant: "ghost", fit: true, href })
  const body = (): ReadonlyArray<Html> => {
    if (current === "organization")
      return [
        ...heading(h, "Name your organization", "Projects, members and billing live under it."),
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
              actionButton(h, {
                label: "Continue",
                type: "submit",
                fit: true,
                disabled: model.submitting,
              }),
            ],
          ),
        ]),
      ]
    if (current === "project")
      return [
        ...heading(
          h,
          "Create your first project",
          "Your actors and their rows live in its home region. You can add regions later.",
        ),
        form(h, model, "onboarding-project", [
          textField(h, model, {
            name: "project-name",
            label: "Project",
            placeholder: "storefront",
            autocomplete: "off",
          }),
          regionChoice(h, model),
          h.div(
            [...styleAttributes(h, styles.row)],
            [
              back(Routes.onboarding({ step: "organization" })),
              actionButton(h, {
                label: "Continue",
                type: "submit",
                fit: true,
                disabled: model.submitting,
              }),
            ],
          ),
        ]),
      ]
    return [
      ...heading(
        h,
        "Connect and deploy",
        "Connect GitHub to deploy on every push to main, or deploy from your machine.",
      ),
      actions(h, [
        actionButton(h, {
          label: "Connect GitHub",
          variant: "ghost",
          href: Routes.settingsIntegrations(),
        }),
      ]),
      divider(h),
      commands(h),
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
              actionButton(h, { label: "Go to project", type: "submit", fit: true }),
            ],
          ),
        ],
      ),
    ]
  }
  return {
    title: "Set up Akter",
    crumbs: [],
    body: frame(h, { wide: true }, [...stepIndicator(h, index), ...body()]),
  }
}

const deviceColumn = (h: H, body: ReadonlyArray<Html>): Screen => ({
  title: "Connect a device",
  crumbs: [],
  body: frame(h, {}, body),
})

/** The code field, filled from the link's `user_code` until the person types. */
const deviceEntry = (h: H, model: Model): Screen => {
  const linked = AppRoute.isAnyOf(["Device"])(model.route) ? model.route.user_code : undefined
  return deviceColumn(h, [
    ...heading(h, "Connect a device", "Enter the code shown in your terminal."),
    form(h, model, "device-code", [
      field(h, {
        name: "device-code",
        label: "Code",
        value: model.fields["device-code"] ?? linked ?? "",
        placeholder: "ABCD-EFGH",
        autocomplete: "off",
        mono: true,
        autocapitalize: "characters",
        onInput: (value) => ChangedField({ name: "device-code", value }),
      }),
      submit(h, model, "Continue"),
    ]),
  ])
}

const deviceRow = (h: H, term: string, detail: ReadonlyArray<Html | string>): Html =>
  h.div(
    [...styleAttributes(h, deviceStyles.row)],
    [
      h.dt([...styleAttributes(h, deviceStyles.term)], [term]),
      h.dd([...styleAttributes(h, deviceStyles.detail)], detail),
    ],
  )

/** The code a person compares with their terminal, one mono box per character. */
const userCode = (h: H, code: string): Html =>
  h.div(
    [
      h.Id("device-user-code"),
      h.Role("img"),
      h.AriaLabel(displayUserCode(code)),
      ...styleAttributes(h, deviceStyles.code),
    ],
    displayUserCode(code)
      .split("")
      .map((character) =>
        h.span(
          [...styleAttributes(h, character === "-" ? deviceStyles.separator : deviceStyles.box)],
          [character],
        ),
      ),
  )

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
    userCode(h, step.code),
    h.dl(
      [h.AriaLabel("Signs in as"), ...styleAttributes(h, deviceStyles.details)],
      [
        deviceRow(h, "Account", [
          step.name === "" ? step.email : step.name,
          step.name === ""
            ? h.empty
            : h.span([...styleAttributes(h, deviceStyles.email)], [step.email]),
        ]),
        deviceRow(h, "Access", [step.access]),
      ],
    ),
    h.div(
      [...styleAttributes(h, deviceStyles.actions)],
      [
        actionButton(h, {
          label: "Deny",
          variant: "ghost",
          onClick: SubmittedForm({ form: "device-deny" }),
          disabled: model.submitting,
        }),
        actionButton(h, {
          label: "Approve",
          onClick: SubmittedForm({ form: "device-approve" }),
          disabled: model.submitting,
        }),
      ],
    ),
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
    actions(h, [
      actionButton(h, {
        label: words.retry ? "Try again" : "Enter another code",
        onClick: SubmittedForm({ form: words.retry ? "device-retry" : "device-restart" }),
        disabled: model.submitting,
      }),
    ]),
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
        fine(h, "Done here?", { label: "Go to the console", href: Routes.overview() }),
      ])
    : deviceColumn(h, [
        ...heading(h, "Request denied", "Nothing was signed in. Your terminal will say so."),
        fine(h, "Done here?", { label: "Go to the console", href: Routes.overview() }),
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
  body: frame(h, { busy: true }, []),
})

const failure = (h: H, error: PageError): Screen => ({
  title: "Couldn’t open this page",
  crumbs: [],
  body: frame(h, {}, [
    ...heading(h, "This page couldn’t open", error.message),
    actions(h, [actionButton(h, { label: "Try again", onClick: RetriedPage() })]),
    fine(h, "Or", { label: "go to sign in", href: Routes.signIn() }),
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
