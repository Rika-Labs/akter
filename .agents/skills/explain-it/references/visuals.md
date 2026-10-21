# Choosing a visual

No more than about 120 words of prose in a row. Break longer stretches with a visual, a code example, a
table or a numbered list. A visual must carry something the sentences around it do not; if it only
repeats them, delete it.

| The content is                                                             | Use                                                         | Rule                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Ordered steps with several actors                                          | Swimlane: one column per actor, one numbered arrow per step | Every arrow label is a real action. Number steps to match the text.                               |
| Two cases that start alike                                                 | Fork: one shared path that splits                           | Mark the split step. Label both branches with real names.                                         |
| A flow of three or more parts                                              | Build-up series: draw it, then redraw adding one part       | One part per diagram. Never one diagram with everything.                                          |
| "Which one is this?"                                                       | Decision tree                                               | One yes/no question per node. Ends are real outcomes.                                             |
| Parts of a whole, with counts                                              | Proportion bar                                              | State the scale. Show unaccounted amounts as their own bar.                                       |
| Things that depend on each other                                           | Dependency graph with running totals                        | Arrows mean "needs". Running total on each node.                                                  |
| Something the reader will see: a file, request, error, screen              | Annotated artifact with callouts                            | Quote it exactly. Mark edits as illustration.                                                     |
| A rule drawn from examples                                                 | Ladder: example, rule, second example                       | The rule sits between two concrete cases.                                                         |
| Change over time                                                           | Timeline                                                    | Real dates only. Mark today.                                                                      |
| Counts into groups, a two-measure ranking, states, entities, a topic split | Sankey, quadrant, state, ER or mindmap (Mermaid)            | Counts add to the source total, unaccounted amount as its own band. Every label is a source name. |
| Behavior of code, a command, a config or a message                         | Code example                                                | Copied from the source or run; real output; under about 15 lines; one idea; every name real.      |
| A spatial or visual idea                                                   | Generated whiteboard image with a few short labels          | Labels from your term list. Inspect it before sending.                                            |

## Defaults

Text diagrams in a `diagram` block with square-corner box characters, under 70 columns:

```diagram
┌─────────┐  1. GET /app.css  ┌────────┐
│ Browser │ ────────────────▶ │ Server │
└─────────┘ ◀──────────────── └────────┘
             2. max-age=86400
```

Use Mermaid or a generated image only when text cannot show the idea. Render Mermaid and view the result
before sending; if you cannot render it, use a text diagram.
