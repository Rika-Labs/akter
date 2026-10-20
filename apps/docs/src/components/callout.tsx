import { CircleCheck, Info, Lightbulb, TriangleAlert, type LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

const kinds = {
  info: { Icon: Info, title: "Note" },
  idea: { Icon: Lightbulb, title: "Tip" },
  success: { Icon: CircleCheck, title: "Check" },
  warning: { Icon: TriangleAlert, title: "Warning" },
} as const satisfies Readonly<Record<string, { Icon: LucideIcon; title: string }>>

type CalloutKind = keyof typeof kinds

const isKind = (value: string): value is CalloutKind => value in kinds

/** A note, tip, check or warning set apart from the text: an icon, a title and the body. */
export function Callout(props: { readonly type?: string; readonly children?: ReactNode }) {
  const kind = props.type !== undefined && isKind(props.type) ? props.type : "info"
  const { Icon, title } = kinds[kind]

  return (
    <div className="ak-callout" data-kind={kind} role="note">
      <Icon aria-hidden="true" />
      <div>
        <p className="ak-callout-title">{title}</p>
        <div className="ak-callout-body">{props.children}</div>
      </div>
    </div>
  )
}
