const RESET_DELAY = 1600

/**
 * Wires every install command on the page to copy its text, swapping the copy icon for a check
 * for a moment. It is idempotent so the script can run once per component instance.
 */
export const bindCopyButtons = (): void => {
  for (const root of document.querySelectorAll<HTMLElement>("[data-install]")) {
    const button = root.querySelector<HTMLButtonElement>("[data-install-copy]")
    const source = root.querySelector<HTMLElement>("[data-install-text]")
    const copyIcon = root.querySelector<SVGElement>("[data-copy-icon]")
    const doneIcon = root.querySelector<SVGElement>("[data-done-icon]")

    if (button === null || source === null || button.dataset["bound"] === "true") continue

    button.dataset["bound"] = "true"
    button.addEventListener("click", () => {
      void navigator.clipboard.writeText(source.textContent ?? "").then(() => {
        if (copyIcon === null || doneIcon === null) return

        copyIcon.style.display = "none"
        doneIcon.style.display = "block"
        button.setAttribute("aria-label", "Copied")
        window.setTimeout(() => {
          copyIcon.style.display = ""
          doneIcon.style.display = ""
          button.setAttribute("aria-label", "Copy install command")
        }, RESET_DELAY)
      })
    })
  }
}
