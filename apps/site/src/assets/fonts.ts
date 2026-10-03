import polySans from "@akter/ui/fonts/PolySans-variable.woff2?inline"
import sagittaire from "@akter/ui/fonts/SagittaireDisplay-Regular.woff2?inline"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import wawoff2 from "wawoff2"

const sources: ReadonlyArray<readonly [string, string]> = [
  ["polysans.ttf", polySans],
  ["sagittaire.ttf", sagittaire],
]

const decode = (dataUri: string): Uint8Array =>
  Uint8Array.from(Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64"))

let files: Promise<ReadonlyArray<string>> | undefined

/**
 * The brand fonts as TrueType files on disk, which the image renderer needs because it cannot read
 * WOFF2. They are converted once per build from the files `@akter/ui` ships. The converter hands
 * back a view into one shared memory, so each result is copied before the next conversion starts.
 */
export const fontFiles = (): Promise<ReadonlyArray<string>> => {
  files ??= (async () => {
    const directory = join(tmpdir(), "akter-site-fonts")
    const written: Array<string> = []

    await mkdir(directory, { recursive: true })

    for (const [name, source] of sources) {
      const path = join(directory, name)

      await writeFile(path, Buffer.from(await wawoff2.decompress(decode(source))))
      written.push(path)
    }

    return written
  })()

  return files
}
