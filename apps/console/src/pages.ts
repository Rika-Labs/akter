import { Effect, Match, Schema } from "effect"
import * as Server from "foldkit/experimental/server"
import type { Html } from "foldkit/html"
import { brand, button, classes, field, styles as s, themeClass, type Builder } from "@project/ui"
import type { Dashboard, Organizations } from "./http.js"

export const Page = Schema.Literals([
  "/sign-in",
  "/sign-up",
  "/dashboard",
  "/settings",
  "/billing",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/accept-invitation",
])

export type Page = typeof Page.Type

export type PageModel = {
  path: Page
  theme: "light" | "dark"
  csrf: string
  data?: Dashboard
  error?: string
  notice?: string
  token?: string
  invitationId?: string
  organizations?: Organizations
  organizationsError?: string
  returnTo?: string
}

const titles: Record<Page, string> = {
  "/sign-in": "Welcome back",
  "/sign-up": "Create your account",
  "/dashboard": "Workspace overview",
  "/settings": "Organization settings",
  "/billing": "Plans & billing",
  "/forgot-password": "Reset your password",
  "/reset-password": "Choose a new password",
  "/verify-email": "Verify your email",
  "/accept-invitation": "Join your team",
}

const hidden = (h: Builder, name: string, value: string) =>
  h.input([h.Type("hidden"), h.Name(name), h.Value(value)])

function form(h: Builder, model: PageModel, action: string, children: Html[]) {
  return h.form(
    [h.Method("post"), h.Action(`/forms/${action}`), h.Class(classes(s.form))],
    [hidden(h, "csrf", model.csrf), ...children],
  )
}

function theme(h: Builder, model: PageModel) {
  return form(h, model, "theme", [
    hidden(h, "theme", model.theme === "dark" ? "light" : "dark"),
    hidden(h, "returnTo", model.returnTo ?? model.path),
    button(h, model.theme === "dark" ? "☀  Light mode" : "◐  Dark mode", true),
  ])
}

function alert(h: Builder, message: string) {
  return h.div(
    [h.Class(classes(s.danger)), h.Attribute("role", "alert")],
    [h.strong([], ["We couldn’t complete that request."]), h.p([], [message])],
  )
}

function auth(h: Builder, model: PageModel) {
  const signup = model.path === "/sign-up"

  return h.main(
    [h.Class(classes(s.auth))],
    [
      h.aside(
        [h.Class(classes(s.authAside))],
        [
          brand(h),
          h.div(
            [],
            [
              h.p([h.Class(classes(s.eyebrow))], ["A place for your next chapter"]),
              h.h2([h.Class(classes(s.hero))], ["Less managing.", h.br([]), "More making."]),
              h.p(
                [h.Class(classes(s.subtitle))],
                [
                  "One thoughtful workspace for your team, your projects, and everything that comes next.",
                ],
              ),
            ],
          ),
          h.p([h.Class(classes(s.footer))], ["YOUR WORK. A LITTLE MORE ORGANIZED."]),
        ],
      ),
      h.section(
        [h.Class(classes(s.authMain))],
        [
          h.div(
            [h.Class(classes(s.authContent, s.stack))],
            [
              h.div(
                [h.Class(classes(s.row))],
                [
                  h.span([h.Class(classes(s.eyebrow))], ["YOUR WORKSPACE STARTS HERE"]),
                  theme(h, model),
                ],
              ),
              h.div(
                [],
                [
                  h.h1([h.Class(classes(s.title))], [titles[model.path]]),
                  h.p(
                    [h.Class(classes(s.subtitle))],
                    [
                      signup
                        ? "Make room for your best work."
                        : "Sign in to pick up where you left off.",
                    ],
                  ),
                ],
              ),
              ...(model.error !== undefined ? [alert(h, model.error)] : []),
              ...(model.notice !== undefined
                ? [h.p([h.Class(classes(s.badge)), h.Attribute("role", "status")], [model.notice])]
                : []),
              form(h, model, signup ? "sign-up" : "sign-in", [
                ...(signup ? [field(h, "name", "Full name")] : []),
                field(h, "email", "Email address", "email"),
                h.label(
                  [h.For("password"), h.Class(classes(s.field))],
                  [
                    "Password",
                    h.input([
                      h.Id("password"),
                      h.Name("password"),
                      h.Type("password"),
                      h.Required(true),
                      h.Attribute("minlength", signup ? "12" : "8"),
                      h.Attribute("autocomplete", signup ? "new-password" : "current-password"),
                      h.Class(classes(s.input)),
                    ]),
                  ],
                ),
                button(h, signup ? "Create account →" : "Sign in →"),
              ]),
              h.p(
                [h.Class(classes(s.subtitle))],
                [
                  signup ? "Already have an account? " : "New to Forma? ",
                  h.a(
                    [h.Href(signup ? "/sign-in" : "/sign-up")],
                    [signup ? "Sign in" : "Create an account"],
                  ),
                ],
              ),
              h.p(
                [h.Class(classes(s.footer))],
                ["Secure, cookie-based sessions. No browser application or tracking scripts."],
              ),
              h.div(
                [h.Class(classes(s.row))],
                [
                  h.a([h.Href("/forgot-password")], ["Forgot password?"]),
                  h.a([h.Href("/verify-email")], ["Verify email"]),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

function accountAction(h: Builder, model: PageModel) {
  const reset = model.path === "/reset-password"
  const invitation = model.path === "/accept-invitation"
  const verification = model.path === "/verify-email"

  const action = Match.value(model.path).pipe(
    Match.when("/reset-password", () => "reset-password"),
    Match.when("/accept-invitation", () => "accept-invitation"),
    Match.when("/verify-email", () => "verify-email"),
    Match.orElse(() => "forgot-password"),
  )

  const description = Match.value(model.path).pipe(
    Match.when(
      "/reset-password",
      () => "Use the token from your reset email to choose a new password.",
    ),
    Match.when(
      "/accept-invitation",
      () =>
        "Sign in with the verified email address that received this invitation, then accept it.",
    ),
    Match.when(
      "/verify-email",
      () => "Request a fresh verification email. Open its link to finish setting up your account.",
    ),
    Match.orElse(
      () =>
        "Enter your account email. If an account exists, we’ll send password reset instructions.",
    ),
  )

  return h.main(
    [h.Class(classes(s.authMain, s.page))],
    [
      h.section(
        [h.Class(classes(s.authContent, s.stack))],
        [
          brand(h),
          theme(h, model),
          h.h1([h.Class(classes(s.title))], [titles[model.path]]),
          h.p([h.Class(classes(s.subtitle))], [description]),
          ...(model.error !== undefined ? [alert(h, model.error)] : []),
          ...(model.notice !== undefined
            ? [h.p([h.Class(classes(s.badge)), h.Attribute("role", "status")], [model.notice])]
            : []),
          form(
            h,
            model,
            action,
            reset
              ? [
                  field(h, "token", "Reset token", "text", model.token ?? ""),
                  field(h, "newPassword", "New password", "password"),
                  button(h, "Reset password"),
                ]
              : invitation
                ? [
                    field(h, "invitationId", "Invitation ID", "text", model.invitationId ?? ""),
                    button(h, "Accept invitation"),
                  ]
                : [
                    field(h, "email", "Email address", "email"),
                    button(h, verification ? "Send verification email" : "Send reset instructions"),
                  ],
          ),
          h.a([h.Href("/sign-in")], ["Back to sign in"]),
        ],
      ),
    ],
  )
}

function dashboard(h: Builder, data: Dashboard) {
  return h.div(
    [h.Class(classes(s.stack))],
    [
      h.div(
        [h.Class(classes(s.stats))],
        [
          ["Projects", String(data.projects.length), "Across your organization"],
          ["Team members", String(data.members.length), "People building together"],
          ["Current plan", data.billing.plan, data.billing.status],
        ].map(([label, value, detail]) =>
          h.section(
            [h.Class(classes(s.card))],
            [
              h.p([h.Class(classes(s.subtitle))], [label!]),
              h.p([h.Class(classes(s.value))], [value!]),
              h.p([h.Class(classes(s.subtitle))], [detail!]),
            ],
          ),
        ),
      ),
      h.section(
        [h.Class(classes(s.card))],
        [
          h.div(
            [h.Class(classes(s.row))],
            [
              h.h2([], ["Your projects"]),
              h.span([h.Class(classes(s.badge))], [`${data.projects.length} total`]),
            ],
          ),
          data.projects.length > 0
            ? h.table(
                [h.Class(classes(s.table))],
                [
                  h.thead(
                    [],
                    [
                      h.tr(
                        [],
                        ["Project", "Status"].map((x) =>
                          h.th([h.Class(classes(s.cell)), h.Attribute("scope", "col")], [x]),
                        ),
                      ),
                    ],
                  ),
                  h.tbody(
                    [],
                    data.projects.map((project) =>
                      h.tr(
                        [],
                        [
                          h.td([h.Class(classes(s.cell))], [project.name]),
                          h.td(
                            [h.Class(classes(s.cell))],
                            [h.span([h.Class(classes(s.badge))], [project.status])],
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              )
            : h.div(
                [h.Class(classes(s.empty))],
                [
                  h.h3([], ["A fresh space for good work"]),
                  h.p(
                    [h.Class(classes(s.subtitle))],
                    [
                      "No projects yet. Projects created through your organization API will appear here.",
                    ],
                  ),
                ],
              ),
        ],
      ),
      h.section(
        [h.Class(classes(s.card))],
        [
          h.h2([], ["People in your workspace"]),
          ...(data.members.length > 0
            ? data.members.map((member) =>
                h.div(
                  [h.Class(classes(s.row, s.cell))],
                  [
                    h.div(
                      [],
                      [
                        h.strong([], [member.name]),
                        h.p([h.Class(classes(s.subtitle))], [member.email]),
                      ],
                    ),
                    h.span([h.Class(classes(s.badge))], [member.role]),
                  ],
                ),
              )
            : [
                h.p(
                  [h.Class(classes(s.subtitle))],
                  ["Create an organization to start bringing your team together."],
                ),
              ]),
        ],
      ),
    ],
  )
}

function settings(h: Builder, model: PageModel, data: Dashboard) {
  return h.div(
    [h.Class(classes(s.stack))],
    [
      h.section(
        [h.Class(classes(s.card))],
        [
          h.h2([], ["Organization details"]),
          ...(data.organization !== null
            ? [
                h.p(
                  [h.Class(classes(s.subtitle))],
                  [
                    "Your active organization. Changes to organization details are not supported by the current API.",
                  ],
                ),
                h.dl(
                  [],
                  [
                    h.dt([], ["Name"]),
                    h.dd([], [data.organization.name]),
                    h.dt([], ["Workspace URL name"]),
                    h.dd([], [data.organization.slug]),
                    h.dt([], ["Your role"]),
                    h.dd([], [data.organization.role]),
                  ],
                ),
              ]
            : [
                h.p(
                  [h.Class(classes(s.subtitle))],
                  ["Create your first organization. You’ll become its owner."],
                ),
                form(h, model, "organization", [
                  field(h, "name", "Organization name"),
                  field(h, "slug", "URL name"),
                  h.p(
                    [h.Class(classes(s.subtitle))],
                    ["Use lowercase letters, numbers, and hyphens for the URL name."],
                  ),
                  button(h, "Create organization"),
                ]),
              ]),
        ],
      ),
      h.section(
        [h.Class(classes(s.card))],
        [
          h.h2([], ["Your account"]),
          h.p([], [data.user.name]),
          h.p([h.Class(classes(s.subtitle))], [data.user.email]),
        ],
      ),
      h.section(
        [h.Class(classes(s.card, s.stack))],
        [
          h.h2([], ["Switch organization"]),
          ...(model.organizationsError !== undefined ? [alert(h, model.organizationsError)] : []),
          ...(model.organizations !== undefined && model.organizations.length > 0
            ? [
                form(h, model, "switch-organization", [
                  h.label(
                    [h.For("organizationId"), h.Class(classes(s.field))],
                    [
                      "Organization",
                      h.select(
                        [
                          h.Id("organizationId"),
                          h.Name("organizationId"),
                          h.Class(classes(s.input)),
                        ],
                        model.organizations.map((organization) =>
                          h.option(
                            [
                              h.Value(organization.id),
                              h.Selected(organization.id === data.organization?.id),
                            ],
                            [organization.name],
                          ),
                        ),
                      ),
                    ],
                  ),
                  button(h, "Switch workspace", true),
                ]),
              ]
            : model.organizationsError !== undefined
              ? []
              : [
                  h.p(
                    [h.Class(classes(s.subtitle))],
                    ["You don’t belong to any organizations yet."],
                  ),
                ]),
        ],
      ),
      ...(data.organization !== null && ["owner", "admin"].includes(data.organization.role)
        ? [
            h.section(
              [h.Class(classes(s.card, s.stack))],
              [
                h.h2([], ["Invite a teammate"]),
                h.p(
                  [h.Class(classes(s.subtitle))],
                  ["They’ll receive an email invitation to join as a member."],
                ),
                form(h, model, "invite-member", [
                  hidden(h, "organizationId", data.organization.id),
                  field(h, "email", "Teammate’s email", "email"),
                  button(h, "Send invitation"),
                ]),
              ],
            ),
          ]
        : []),
    ],
  )
}

function billing(h: Builder, model: PageModel, data: Dashboard) {
  const canManage =
    data.organization !== null && ["owner", "admin"].includes(data.organization.role)

  return h.section(
    [h.Class(classes(s.card, s.stack))],
    [
      h.div(
        [h.Class(classes(s.row))],
        [
          h.h2([], ["Your subscription"]),
          h.span([h.Class(classes(s.badge))], [data.billing.status]),
        ],
      ),
      h.div(
        [],
        [
          h.p([h.Class(classes(s.eyebrow))], ["CURRENT PLAN"]),
          h.p([h.Class(classes(s.value))], [data.billing.plan]),
          h.p(
            [h.Class(classes(s.subtitle))],
            [
              data.billing.renewalDate !== undefined
                ? `Renews ${data.billing.renewalDate}`
                : "No renewal date is available.",
            ],
          ),
        ],
      ),
      h.p(
        [h.Class(classes(s.subtitle))],
        [
          "Manage your subscription through secure, provider-hosted billing. Pricing and charges are confirmed before you subscribe.",
        ],
      ),
      ...(canManage
        ? [
            h.div(
              [h.Class(classes(s.row))],
              [
                form(h, model, "checkout", [button(h, "Explore Pro →")]),
                form(h, model, "portal", [button(h, "Manage billing", true)]),
              ],
            ),
          ]
        : [
            h.p(
              [h.Class(classes(s.subtitle))],
              [
                data.organization !== null
                  ? "Only organization owners and admins can manage billing."
                  : "Create an organization in Settings to manage a subscription.",
              ],
            ),
          ]),
    ],
  )
}

function workspace(h: Builder, model: PageModel) {
  const data = model.data

  return h.div(
    [h.Class(classes(s.layout))],
    [
      h.aside(
        [h.Class(classes(s.sidebar))],
        [
          brand(h),
          h.div(
            [],
            [
              h.p([h.Class(classes(s.eyebrow))], ["WORKSPACE"]),
              h.strong(
                [],
                [
                  data?.organization?.name ??
                    (data !== undefined ? "Your workspace" : "Workspace unavailable"),
                ],
              ),
            ],
          ),
          h.nav(
            [h.Class(classes(s.nav)), h.AriaLabel("Main navigation")],
            (
              [
                ["/dashboard", "◫  Overview"],
                ["/settings", "⚙  Settings"],
                ["/billing", "▤  Billing"],
              ] as const
            ).map(([path, label]) =>
              h.a(
                [
                  h.Href(path),
                  h.Class(classes(s.navLink, path === model.path && s.active)),
                  ...(path === model.path ? [h.Attribute("aria-current", "page")] : []),
                ],
                [label],
              ),
            ),
          ),
          h.div(
            [h.Class(classes(s.stack))],
            [
              theme(h, model),
              ...(data !== undefined
                ? [
                    h.p([h.Class(classes(s.subtitle))], [data.user.email]),
                    form(h, model, "sign-out", [button(h, "Sign out", true)]),
                  ]
                : [h.a([h.Href("/sign-in"), h.Class(classes(s.navLink))], ["Sign in →"])]),
            ],
          ),
        ],
      ),
      h.main(
        [h.Class(classes(s.main, s.stack))],
        [
          h.header(
            [h.Class(classes(s.row, s.header))],
            [
              h.span(
                [h.Class(classes(s.subtitle))],
                ["Workspace / ", model.path === "/dashboard" ? "Overview" : model.path.slice(1)],
              ),
              h.span(
                [h.Class(classes(s.badge))],
                [data !== undefined ? "Connected to your workspace" : "Connection unavailable"],
              ),
            ],
          ),
          h.div(
            [],
            [
              h.p(
                [h.Class(classes(s.eyebrow))],
                [model.path === "/dashboard" ? "THE BIG PICTURE" : "MAKE IT YOURS"],
              ),
              h.h1([h.Class(classes(s.title))], [titles[model.path]]),
              h.p(
                [h.Class(classes(s.subtitle))],
                [
                  Match.value(model.path).pipe(
                    Match.when(
                      "/dashboard",
                      () =>
                        `A little clarity for everything you’re building${data !== undefined ? `, ${data.user.name.split(" ")[0] ?? data.user.name}` : ""}.`,
                    ),
                    Match.when("/settings", () => "The details that make this workspace yours."),
                    Match.orElse(() => "A plan that grows with your team."),
                  ),
                ],
              ),
            ],
          ),
          ...(model.error !== undefined ? [alert(h, model.error)] : []),
          ...(data !== undefined
            ? [
                Match.value(model.path).pipe(
                  Match.when("/settings", () => settings(h, model, data)),
                  Match.when("/billing", () => billing(h, model, data)),
                  Match.orElse(() => dashboard(h, data)),
                ),
              ]
            : [
                h.section(
                  [h.Class(classes(s.card, s.empty))],
                  [
                    h.h2([], ["Your workspace is still yours."]),
                    h.p(
                      [h.Class(classes(s.subtitle))],
                      [
                        "We can’t reach your account data right now. No projects, members, or billing details have been loaded.",
                      ],
                    ),
                    h.p([], ["Please try again in a moment."]),
                    h.a(
                      [h.Href(model.path), h.Class(classes(s.button, s.secondary))],
                      ["Try again"],
                    ),
                  ],
                ),
              ]),
          h.footer([h.Class(classes(s.footer))], ["FORMA  /  A little space to do great things."]),
        ],
      ),
    ],
  )
}

export function renderPage(model: PageModel): Promise<string> {
  return Effect.runPromise(
    Server.renderToString(
      {
        init: () => ({ model }),
        view: (state, h: Builder) => ({
          title: `${titles[state.path]} · Forma`,
          lang: "en",
          body: h.div(
            [h.Class(themeClass(state.theme)), h.DataAttribute("theme", state.theme)],
            [
              Match.value(state.path).pipe(
                Match.whenOr("/sign-in", "/sign-up", () => auth(h, state)),
                Match.whenOr("/dashboard", "/settings", "/billing", () => workspace(h, state)),
                Match.orElse(() => accountAction(h, state)),
              ),
            ],
          ),
        }),
      },
      { isHydratable: false },
    ).pipe(
      Effect.map((rendered) =>
        Server.injectIntoTemplate(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Forma</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div></body></html>',
          rendered,
        ),
      ),
    ),
  )
}
