import "./style.css"

interface DocumentEntry {
  readonly title: string
  readonly path: string
}

const list = document.querySelector<HTMLUListElement>("#documents")
const search = document.querySelector<HTMLInputElement>("#search")
const response = await fetch("/manifest.json")
const entries: ReadonlyArray<DocumentEntry> = await response.json()

const render = () => {
  if (!list) return
  const term = search?.value.toLowerCase() ?? ""
  list.replaceChildren()
  for (const entry of entries) {
    if (!entry.title.toLowerCase().includes(term)) continue
    const item = document.createElement("li")
    const link = document.createElement("a")
    link.href = entry.path
    link.textContent = entry.title
    item.append(link)
    list.append(item)
  }
}

search?.addEventListener("input", render)
render()
