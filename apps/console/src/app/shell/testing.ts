import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Scene from "foldkit/scene"
import * as Url from "foldkit/url"
import { workspace } from "../workspace/fixtures.ts"
import type { Message } from "./message.ts"
import type { Model } from "./model.ts"
import type { Screen, ScreenInput } from "./screen.ts"
import { init } from "./update.ts"

/** The rendered screen's root, so a test can read every word a page shows. */
export const screenRoot = Scene.selector("#screen")

/**
 * Renders one page screen for a view test: the console's initial model at `path`, loaded and live
 * unless `model` says otherwise, with the screen's actions and body under `screenRoot`. Updates
 * leave the model unchanged, so the test asserts on the page as given.
 */
export const screenScene = <Page>(
  input: Readonly<{
    path: string
    screen: (input: ScreenInput<Page>) => Screen
    page: Page
    model?: Partial<Model>
  }>,
  ...steps: ReadonlyArray<Scene.SceneStep<Model, Message, undefined>>
) => {
  const url = Option.getOrThrow(Url.fromString(`http://localhost${input.path}`))
  const model: Model = {
    ...init({ workspace, theme: "light" }, url).model,
    loading: false,
    pageSample: false,
    ...input.model,
  }
  return Scene.scene(
    {
      update: (current: Model) => ({ model: current }),
      view: (current: Model, h: HtmlBuilder<Message>): Html => {
        const screen = input.screen({ h, model: current, page: input.page })
        return h.div([h.Id("screen")], [...(screen.actions ?? []), screen.body])
      },
    },
    Scene.given(model),
    ...steps,
  )
}
