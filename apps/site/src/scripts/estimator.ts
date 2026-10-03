import { dollars, estimate } from "../pricing/estimate.ts"

const field = (form: HTMLFormElement, name: string): number => {
  const checked = form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)

  return Number(checked?.value ?? 0)
}

const OPACITY = [1, 0.78, 0.58, 0.4, 0.26]

/**
 * Recomputes the bill whenever a choice changes. It shares `estimate` with the server render, so the
 * page opens on the same numbers the script produces, and updates the text, the split bar and the
 * total in place.
 */
export const bindEstimator = (): void => {
  const form = document.querySelector<HTMLFormElement>("[data-estimator]")

  if (form === null) return

  const update = (): void => {
    const result = estimate({
      commands: field(form, "commands"),
      runners: field(form, "runners"),
      storageGb: field(form, "storage"),
      egressGb: 100,
      regions: field(form, "regions"),
    })
    const rows = form.querySelectorAll<HTMLElement>("[data-line]")
    const segments = form.querySelectorAll<HTMLElement>("[data-segment]")
    const plan = form.querySelector<HTMLElement>("[data-plan]")
    const total = form.querySelector<HTMLElement>("[data-total]")

    result.lines.forEach((line, index) => {
      const row = rows[index]
      const label = row?.querySelector<HTMLElement>("[data-label]")
      const detail = row?.querySelector<HTMLElement>("[data-detail]")
      const amount = row?.querySelector<HTMLElement>("[data-amount]")
      const segment = segments[index]

      if (label !== null && label !== undefined) label.textContent = line.label
      if (detail !== null && detail !== undefined) detail.textContent = line.detail ?? ""
      if (amount !== null && amount !== undefined) amount.textContent = dollars(line.amount)
      if (segment !== undefined) {
        segment.style.width = `${(line.amount / result.total) * 100}%`
        segment.style.opacity = String(OPACITY[index] ?? 0.3)
      }
    })

    if (plan !== null) plan.textContent = result.plan.name.toUpperCase()
    if (total !== null) total.textContent = dollars(result.total)
  }

  form.addEventListener("change", update)
  form.addEventListener("submit", (event) => event.preventDefault())
  update()
}

/** Switches the plan cards between monthly and yearly prices, where yearly is two months free. */
export const bindBilling = (): void => {
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-billing]")
  const root = document.querySelector<HTMLElement>("[data-billing-root]")
  const on = root?.dataset["on"] ?? ""
  const off = root?.dataset["off"] ?? ""

  for (const button of buttons)
    button.addEventListener("click", () => {
      const mode = button.dataset["billing"]

      for (const other of buttons) {
        const active = other === button

        other.setAttribute("aria-pressed", String(active))
        other.className = active ? on : off
      }

      for (const element of document.querySelectorAll<HTMLElement>("[data-show]"))
        element.hidden = element.dataset["show"] !== mode
    })
}
