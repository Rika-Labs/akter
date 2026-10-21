# Browser operations

Paths and selectors in this table are examples. Replace screenshot/video paths with absolute paths
outside the repo and request patterns with the actual boundary under test; never save auth state.

| Operation               | agent-browser                                          | Aside `repl`                                                               |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Open                    | `open <url>`                                           | `const p1 = await openTab(url)`                                            |
| Desktop / mobile        | `set viewport 1440 900` / `set viewport 390 844 2`     | `await p1.setViewportSize({ width: 390, height: 844 })` (no pixel ratio)   |
| Theme                   | `set media dark`                                       | `await p1.emulateMedia({ colorScheme: 'dark' })`                           |
| Read                    | `snapshot -i`                                          | `(await snapshot(p1, { interactive: true })).tree`                         |
| Act                     | `click @e1`, `fill @e2 "text"`, `press Enter`          | `await p1.locator('e1').click()`                                           |
| Wait                    | `wait --text "Saved"`                                  | `await p1.getByText('Saved').waitFor()`                                    |
| Screenshot              | `screenshot /abs/x.png`                                | `await p1.screenshot({ path: './artifacts/x.png' })`                       |
| Run JS                  | `eval --stdin`                                         | `await p1.evaluate(() => ...)`                                             |
| Computed CSS            | `get styles "<sel>"`                                   | `await p1.evaluate(s => getComputedStyle(document.querySelector(s)), sel)` |
| Console / errors        | `console`, `errors`                                    | `p1.on('console', ...)` in the same call                                   |
| Video                   | `record start /abs/x.webm --cursor` … `record stop`    | agent-browser only                                                         |
| Pixel diff              | `diff screenshot --baseline A --selector S --output B` | agent-browser only                                                         |
| Block an endpoint       | `network route "**/rpc" --abort`                       | isolated agent-browser session only                                        |
| Offline                 | `set offline on` / `off`                               | isolated agent-browser session only                                        |
| Cookies clear or tamper | `cookies clear`, `cookies set ...`                     | isolated agent-browser session only                                        |
