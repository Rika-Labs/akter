import type { ThemeRegistration } from "shiki"
import { bundledThemes } from "shiki/themes"

/** The reader-facing colours of code. Yellow stands where the base theme draws properties and constants. */
const palettes = {
  light: { base: "github-light", name: "akter-light", ink: "#0b0d0b", accent: "#8a6400" },
  dark: { base: "github-dark", name: "akter-dark", ink: "#ecebe7", accent: "#ffd54d" },
} as const

const BASE_ACCENT = { light: "#005cc5", dark: "#79b8ff" } as const

const BASE_INK = { light: "#24292e", dark: "#e1e4e8" } as const

/**
 * A code theme built from GitHub's: the same tokens and colours, with the base accent
 * swapped for Akter yellow and the base text colour for the page's ink, so a block reads
 * like the rest of the page in both themes.
 */
const theme = async (mode: keyof typeof palettes): Promise<ThemeRegistration> => {
  const palette = palettes[mode]
  const base = (await bundledThemes[palette.base]()).default
  const recoloured = JSON.stringify(base)
    .replaceAll(new RegExp(BASE_ACCENT[mode], "gi"), palette.accent)
    .replaceAll(new RegExp(BASE_INK[mode], "gi"), palette.ink)

  return { ...(JSON.parse(recoloured) as ThemeRegistration), name: palette.name, fg: palette.ink }
}

/** The light and dark code themes. */
export const codeThemes = { light: await theme("light"), dark: await theme("dark") }
