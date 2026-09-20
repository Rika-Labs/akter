import * as stylex from "@stylexjs/stylex"
import { Match, Predicate } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { darkTheme, tokens } from "./tokens.stylex.js"

export type Builder = HtmlBuilder<never>

export { tokens } from "./tokens.stylex.js"

export const styles = stylex.create({
  page: {
    minHeight: "100vh",
    backgroundColor: tokens.background,
    color: tokens.foreground,
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    fontSize: "14px",
    lineHeight: 1.6,
  },
  layout: {
    display: "grid",
    gridTemplateColumns: { default: "240px minmax(0, 1fr)", "@media (max-width: 760px)": "1fr" },
    minHeight: "100vh",
  },
  sidebar: {
    backgroundColor: tokens.card,
    borderRight: `1px solid ${tokens.border}`,
    padding: "32px 22px",
    display: "flex",
    flexDirection: "column",
    gap: "30px",
  },
  brand: {
    fontWeight: 750,
    fontSize: "22px",
    letterSpacing: "-0.8px",
    textDecoration: "none",
    color: tokens.foreground,
  },
  logo: {
    display: "inline-grid",
    placeItems: "center",
    width: "32px",
    height: "32px",
    marginRight: "10px",
    borderRadius: "9px",
    backgroundColor: tokens.primary,
    color: tokens.primaryForeground,
    fontSize: "20px",
  },
  nav: { display: "grid", gap: "7px" },
  navLink: {
    display: "block",
    padding: "10px 14px",
    borderRadius: "8px",
    textDecoration: "none",
    color: tokens.mutedForeground,
    fontWeight: 550,
    backgroundColor: { default: "transparent", ":hover": tokens.muted },
  },
  active: { color: tokens.primary, backgroundColor: tokens.accent },
  main: {
    padding: { default: "30px 48px 64px", "@media (max-width: 1000px)": "24px" },
    maxWidth: "1400px",
    width: "100%",
    marginInline: "auto",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    flexWrap: "wrap",
  },
  header: {
    paddingBottom: "24px",
    marginBottom: "38px",
    borderBottom: `1px solid ${tokens.border}`,
  },
  title: {
    fontSize: { default: "32px", "@media (max-width: 760px)": "27px" },
    letterSpacing: "-1px",
    lineHeight: 1.2,
    fontWeight: 650,
    marginBottom: "10px",
  },
  subtitle: { color: tokens.mutedForeground, margin: 0 },
  eyebrow: {
    fontSize: "11px",
    letterSpacing: "1.5px",
    fontWeight: 700,
    textTransform: "uppercase",
    color: tokens.mutedForeground,
    marginBottom: "12px",
  },
  card: {
    backgroundColor: tokens.card,
    border: `1px solid ${tokens.border}`,
    borderRadius: tokens.radius,
    padding: "26px",
  },
  stack: { display: "grid", gap: "22px" },
  stats: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      "@media (max-width: 760px)": "1fr",
    },
    gap: "18px",
  },
  value: { fontSize: "30px", fontWeight: 600, letterSpacing: "-1px", marginBlock: "14px 4px" },
  badge: {
    display: "inline-block",
    color: tokens.primary,
    backgroundColor: tokens.accent,
    padding: "4px 10px",
    fontSize: "12px",
    fontWeight: 600,
    borderRadius: "6px",
  },
  button: {
    display: "inline-flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "42px",
    padding: "10px 17px",
    borderRadius: "7px",
    border: "1px solid transparent",
    backgroundColor: { default: tokens.primary, ":hover": tokens.ring },
    color: tokens.primaryForeground,
    fontWeight: 600,
    fontSize: "13px",
    textDecoration: "none",
    cursor: "pointer",
    ":focus-visible": { outline: `3px solid ${tokens.ring}`, outlineOffset: "3px" },
  },
  secondary: {
    backgroundColor: { default: tokens.card, ":hover": tokens.muted },
    borderColor: tokens.border,
    color: tokens.foreground,
  },
  field: { display: "grid", gap: "7px", fontSize: "13px", fontWeight: 550 },
  input: {
    width: "100%",
    backgroundColor: tokens.card,
    color: tokens.foreground,
    border: `1px solid ${tokens.border}`,
    borderRadius: "7px",
    padding: "12px",
    fontSize: "14px",
    ":focus": { outline: `2px solid ${tokens.ring}`, outlineOffset: "1px" },
  },
  form: { display: "grid", gap: "20px", maxWidth: "500px" },
  danger: {
    padding: "18px 22px",
    borderRadius: "9px",
    backgroundColor: tokens.destructiveBackground,
    color: tokens.destructive,
    border: `1px solid ${tokens.destructive}`,
  },
  empty: { textAlign: "center", padding: "42px 20px" },
  table: { width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "13px" },
  cell: { padding: "15px 10px", borderBottom: `1px solid ${tokens.border}` },
  auth: {
    display: "grid",
    gridTemplateColumns: { default: "1fr 1fr", "@media (max-width: 760px)": "1fr" },
    minHeight: "100vh",
  },
  authAside: {
    padding: { default: "52px 64px", "@media (max-width: 760px)": "28px" },
    backgroundColor: tokens.accent,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap: "60px",
  },
  authMain: { padding: "36px", display: "grid", alignContent: "center", justifyItems: "center" },
  authContent: { width: "100%", maxWidth: "390px" },
  hero: {
    fontSize: { default: "48px", "@media (max-width: 1000px)": "36px" },
    lineHeight: 1.12,
    letterSpacing: "-2px",
    maxWidth: "450px",
    fontWeight: 600,
  },
  footer: { color: tokens.mutedForeground, fontSize: "12px", marginTop: "32px" },
})

export function classes(...values: stylex.StyleXStyles[]): string {
  return stylex.props(...values).className ?? ""
}

export function themeClass(theme: "light" | "dark"): string {
  return stylex.props(styles.page, theme === "dark" && darkTheme).className ?? ""
}

export function brand(h: Builder) {
  return h.a(
    [h.Href("/dashboard"), h.Class(classes(styles.brand))],
    [h.span([h.Class(classes(styles.logo)), h.Attribute("aria-hidden", "true")], ["↗"]), "Forma"],
  )
}

export function button(
  label: string,
  secondary?: boolean,
): (h: Builder) => ReturnType<Builder["button"]>
export function button(
  h: Builder,
  label: string,
  secondary?: boolean,
): ReturnType<Builder["button"]>
export function button(
  hOrLabel: Builder | string,
  labelOrSecondary?: string | boolean,
  secondary = false,
) {
  if (Predicate.isString(hOrLabel)) {
    const label = hOrLabel
    const isSecondary = labelOrSecondary === true

    return (h: Builder) => button(h, label, isSecondary)
  }

  const h = hOrLabel
  const label = Predicate.isString(labelOrSecondary) ? labelOrSecondary : ""

  return h.button(
    [h.Type("submit"), h.Class(classes(styles.button, secondary && styles.secondary))],
    [label],
  )
}

export function field(
  name: string,
  label: string,
  type?: string,
  value?: string,
): (h: Builder) => ReturnType<Builder["label"]>
export function field(
  h: Builder,
  name: string,
  label: string,
  type?: string,
  value?: string,
): ReturnType<Builder["label"]>
export function field(
  hOrName: Builder | string,
  nameOrLabel: string,
  labelOrType?: string,
  typeOrValue?: string,
  value?: string,
) {
  if (Predicate.isString(hOrName)) {
    const name = hOrName
    const label = nameOrLabel
    const type = labelOrType ?? "text"
    const fieldValue = typeOrValue ?? ""

    return (h: Builder) => field(h, name, label, type, fieldValue)
  }

  const h = hOrName
  const name = nameOrLabel
  const label = labelOrType ?? ""
  const type = typeOrValue ?? "text"
  const fieldValue = value ?? ""

  return h.label(
    [h.Class(classes(styles.field)), h.For(name)],
    [
      label,
      h.input([
        h.Id(name),
        h.Name(name),
        h.Type(type),
        h.Value(fieldValue),
        h.Required(true),
        h.Class(classes(styles.input)),
        h.Attribute(
          "autocomplete",
          Match.value(name).pipe(
            Match.when("newPassword", () => "new-password"),
            Match.when("password", () => "current-password"),
            Match.when("email", () => "email"),
            Match.when("name", () => "name"),
            Match.orElse(() => "off"),
          ),
        ),
        ...(type === "password" ? [h.Attribute("minlength", "12")] : []),
      ]),
    ],
  )
}
