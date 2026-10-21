# Style

- Real names, files, commands and numbers; never "Service A". One name per concept, no synonyms.
- Say who does what. One idea per sentence and per paragraph; split anything over about 40 words.
- Whole sentences, periods not semicolons, plain words. State the mechanism, not a feeling about it.
- Prefer a traced case to an analogy; if you use one, say where it stops fitting.
- Say each thing once, in one form.
- Never: em dashes, "key insight", "at its core", "TL;DR", "worth noting", "simply", "just", "if and only
  if", stacked hedges, flourishes, praise for the question, a closing summary.
- Sentence-case headings that state the point. Bold a term only where you define it.

## Example

Weak: "Browser caching can cause stale assets. Try clearing the cache."

Strong:

> The browser reused its saved copy of `app.css` instead of asking the server for the new one. Your server
> sent that file with `Cache-Control: max-age=86400`, which tells the browser to keep it for 24 hours.
>
> ```diagram
>  9:00 loaded ──── 9:30 edited ──── 9:31 reloaded ──▶ copy is 31 min old
>  saved app.css    deployed         limit is 24 hours   browser never asks
> ```
>
> You loaded the page at 9:00 and the browser saved `app.css`. At 9:30 you edited the file and deployed. At
> 9:31 you reloaded. The browser saw its copy was 31 minutes old, under the 24-hour limit, and never
> contacted the server. A teammate who first opened the page at 9:31 had no saved copy, so they got the new
> file.
>
> A hard reload skips the saved copy once. To fix it for everyone, name the file `app.3f9a1c.css` so each
> deploy has a new address. The browser treats a new address as a new file.
>
> Unchecked: I did not confirm your CDN is not also caching the old file.
