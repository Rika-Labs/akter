import readme from "../../../../README.md?raw"

/** A fenced code block from the README: its `title` attribute (the file path) and its source. */
export interface Example {
  readonly file: string
  readonly code: string
}

const FENCE = /```ts title="([^"]+)"\n([\s\S]*?)\n```/g

/**
 * Reads the README's titled TypeScript blocks, so the landing page shows the same Order example the
 * repository shows. Throws when a block is missing, so a rename fails the build.
 */
export const readmeExample = (file: string): Example => {
  for (const match of readme.matchAll(FENCE))
    if (match[1] === file) return { file, code: match[2] ?? "" }

  throw new Error(`README.md has no \`\`\`ts title="${file}" block`)
}

/** The three files of the README's Order example, in the order the landing page shows them. */
export const orderExample = {
  contract: readmeExample("src/order/contract.ts"),
  handler: readmeExample("src/order/layer.ts"),
  call: readmeExample("src/checkout.ts"),
}

/** The `Order` definition from the contract file, without the tables, events and jobs above it. */
export const orderDefinition = (): string => {
  const source = orderExample.contract.code
  const start = source.indexOf("export const Order = Actor.make(")

  if (start === -1)
    throw new Error("README.md's contract no longer defines `export const Order = Actor.make(`")

  return source.slice(start)
}

/** A README example without its import lines, which the landing page's narrow panels omit. */
export const withoutImports = (example: Example): string =>
  example.code
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n")
    .replace(/^\n+/, "")
