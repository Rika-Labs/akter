/** One searchable section of the documentation, as the search index lists it. */
interface Entry {
  readonly title: string
  readonly group: string
  readonly url: string
  readonly id: string
  readonly heading: string
  readonly text: string
}

const MODE_KEY = "akter-docs-mode"

const RESULTS = 8

const classList = (value: string | undefined): ReadonlyArray<string> =>
  (value ?? "").split(" ").filter((name) => name !== "")

const flash = (button: HTMLElement, done: string): void => {
  const original = button.textContent
  button.textContent = done
  window.setTimeout(() => {
    button.textContent = original
  }, 1400)
}

const bindModes = (config: HTMLElement): void => {
  const human = document.querySelector<HTMLElement>("[data-view=human]")
  const agent = document.querySelector<HTMLElement>("[data-view=agent]")
  const output = document.querySelector<HTMLElement>("[data-agent-markdown]")
  const article = document.querySelector<HTMLElement>("[data-doc]")
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-mode]")
  const on = config.dataset["modeOn"] ?? ""
  const off = config.dataset["modeOff"] ?? ""
  let loaded = false

  if (human === null || agent === null || output === null || article === null) return

  const apply = (mode: "human" | "agent"): void => {
    human.hidden = mode === "agent"
    agent.hidden = mode !== "agent"

    for (const button of buttons) {
      const active = button.dataset["mode"] === mode

      button.setAttribute("aria-pressed", String(active))
      button.className = active ? on : off
    }

    if (mode === "agent" && !loaded) {
      loaded = true
      void fetch(article.dataset["markdownUrl"] ?? "")
        .then((response) => response.text())
        .then((markdown) => {
          output.textContent = markdown
        })
    }

    window.localStorage.setItem(MODE_KEY, mode)
  }

  for (const button of buttons)
    button.addEventListener("click", () =>
      apply(button.dataset["mode"] === "agent" ? "agent" : "human"),
    )

  if (window.localStorage.getItem(MODE_KEY) === "agent") apply("agent")
}

const bindCopy = (): void => {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null
    const code = target?.closest<HTMLElement>("[data-copy-code]")
    const markdown = target?.closest<HTMLElement>("[data-copy-markdown]")

    if (code !== null && code !== undefined) {
      const source = code.parentElement?.querySelector("pre")?.textContent ?? ""
      void navigator.clipboard.writeText(source).then(() => flash(code, "Copied"))
    }

    if (markdown !== null && markdown !== undefined)
      void fetch(markdown.dataset["markdownUrl"] ?? "")
        .then((response) => response.text())
        .then((text) => navigator.clipboard.writeText(text))
        .then(() => flash(markdown, "Copied"))
  })
}

const bindOutline = (): void => {
  const links = document.querySelectorAll<HTMLAnchorElement>("[data-outline] a[data-target]")
  const headings = [...links].flatMap((link) => {
    const heading = document.getElementById(link.dataset["target"] ?? "")

    return heading === null ? [] : [{ link, heading }]
  })

  if (headings.length === 0) return

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.find((entry) => entry.isIntersecting)

      if (visible === undefined) return

      for (const { link, heading } of headings) {
        const active = heading === visible.target

        link.className = (active ? link.dataset["current"] : link.dataset["idle"]) ?? ""
        if (active) link.setAttribute("aria-current", "location")
        else link.removeAttribute("aria-current")
      }
    },
    { rootMargin: "-15% 0px -75% 0px" },
  )

  for (const { heading } of headings) observer.observe(heading)
}

const score = (entry: Entry, words: ReadonlyArray<string>): number => {
  const heading = entry.heading.toLowerCase()
  const title = entry.title.toLowerCase()
  const text = entry.text.toLowerCase()
  let total = 0

  for (const word of words) {
    if (heading.includes(word)) total += 3
    else if (title.includes(word)) total += 2
    else if (text.includes(word)) total += 1
    else return 0
  }

  return total
}

const bindSearch = (config: HTMLElement): void => {
  const roots = document.querySelectorAll<HTMLElement>("[data-search]")
  const item = classList(config.dataset["result"])
  const itemTitle = classList(config.dataset["resultTitle"])
  const itemText = classList(config.dataset["resultText"])
  const empty = classList(config.dataset["resultEmpty"])
  let entries: Promise<ReadonlyArray<Entry>> | undefined

  const load = (): Promise<ReadonlyArray<Entry>> => {
    entries ??= fetch("/docs/search.json").then((response) => response.json())
    return entries
  }

  const inputs: Array<HTMLInputElement> = []

  for (const root of roots) {
    const input = root.querySelector<HTMLInputElement>("[data-search-input]")
    const results = root.querySelector<HTMLElement>("[data-search-results]")

    if (input === null || results === null) continue

    inputs.push(input)

    const render = async (): Promise<void> => {
      const words = input.value
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word !== "")

      results.replaceChildren()
      results.hidden = words.length === 0

      if (words.length === 0) return

      const found = (await load())
        .map((entry) => ({ entry, rank: score(entry, words) }))
        .filter((match) => match.rank > 0)
        .toSorted((a, b) => b.rank - a.rank)
        .slice(0, RESULTS)

      if (found.length === 0) {
        const none = document.createElement("p")

        none.classList.add(...empty)
        none.textContent = "No matches in the documentation."
        results.append(none)
        return
      }

      for (const { entry } of found) {
        const link = document.createElement("a")
        const title = document.createElement("span")
        const text = document.createElement("span")

        link.href = entry.id === "" ? entry.url : `${entry.url}#${entry.id}`
        link.classList.add(...item)
        title.classList.add(...itemTitle)
        title.textContent =
          entry.heading === entry.title ? entry.title : `${entry.title} › ${entry.heading}`
        text.classList.add(...itemText)
        text.textContent = entry.text
        link.append(title, text)
        results.append(link)
      }
    }

    input.addEventListener("focus", () => void load())
    input.addEventListener("input", () => void render())
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        input.value = ""
        void render()
      }

      if (event.key === "Enter") results.querySelector<HTMLAnchorElement>("a")?.click()

      if (event.key === "ArrowDown") results.querySelector<HTMLAnchorElement>("a")?.focus()
    })
    document.addEventListener("click", (event) => {
      if (event.target instanceof Node && !root.contains(event.target)) results.hidden = true
    })
  }

  document.addEventListener("keydown", (event) => {
    const typing =
      event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement

    if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
      event.preventDefault()
      inputs.find((input) => input.offsetParent !== null)?.focus()
    }
  })
}

/** Wires the documentation page: reading modes, outline highlighting, search and copy buttons. */
export const bindDocs = (): void => {
  const config = document.querySelector<HTMLElement>("[data-docs-config]")

  bindCopy()

  if (config === null) return

  bindModes(config)
  bindOutline()
  bindSearch(config)
}
