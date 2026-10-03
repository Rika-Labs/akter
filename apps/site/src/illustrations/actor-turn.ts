/** One stage of a turn, with the two short lines of detail that explain it. */
export interface Stage {
  readonly title: string
  readonly lines: readonly [string, string]
}

/** The stages of one command, in the order a turn runs them. */
export const stages: ReadonlyArray<Stage> = [
  { title: "Command", lines: ["Place({ lines })", "with a command ID"] },
  { title: "Fence", lines: ["still the owner?", "checked in the DB"] },
  { title: "Receipt", lines: ["seen this ID?", "replay the result"] },
  { title: "Handler", lines: ["your Effect runs", "rows · events · jobs"] },
  { title: "Commit", lines: ["state · rows · events", "receipt · outbox"] },
  { title: "Reply", lines: ["the result, 2400", "after the commit"] },
]

/** The work the outbox runs once the commit has landed. */
export const afterCommit: ReadonlyArray<Stage> = [
  { title: "Deliver messages", lines: ["", ""] },
  { title: "Fire timers", lines: ["", ""] },
  { title: "Run jobs", lines: ["", ""] },
]

/** A node's top-left corner and size, in SVG user units, and when it lights up in the loop. */
export interface Node extends Stage {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly delay: number
}

/** A straight connector with an arrowhead, drawn on at `delay` seconds when `drawn` is set. */
export interface Link {
  readonly line: string
  readonly head: string
  readonly length: number
  readonly delay: number
  readonly drawn: boolean
}

/** The packet's start point and how far it travels along one axis. */
export interface Travel {
  readonly x: number
  readonly y: number
  readonly axis: "x" | "y"
  readonly distance: number
}

/** The labelled rectangle drawn around the stages that share one transaction. */
export interface Region {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly labelX: number
  readonly labelY: number
}

/** Everything the renderer needs to draw one orientation of the diagram. */
export interface Layout {
  readonly width: number
  readonly height: number
  readonly nodes: ReadonlyArray<Node>
  readonly afterNodes: ReadonlyArray<Node>
  readonly links: ReadonlyArray<Link>
  readonly region: Region
  readonly afterLabel: { readonly x: number; readonly y: number; readonly anchor: "start" | "end" }
  readonly travel: Travel
}

const STAGE_START = 0.4
const AFTER_START = 5.6

const link = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  delay: number,
  drawn: boolean,
): Link => {
  const horizontal = y1 === y2
  const direction = horizontal ? Math.sign(x2 - x1) : Math.sign(y2 - y1)
  const head = horizontal
    ? `M${x2 - direction * 5} ${y2 - 3.5} L${x2} ${y2} L${x2 - direction * 5} ${y2 + 3.5}`
    : `M${x2 - 3.5} ${y2 - direction * 5} L${x2} ${y2} L${x2 + 3.5} ${y2 - direction * 5}`

  return {
    line: `M${x1} ${y1} L${x2} ${y2}`,
    head,
    length: Math.abs(x2 - x1) + Math.abs(y2 - y1),
    delay,
    drawn,
  }
}

const NODE_W = 140
const PITCH = 172

const wide = (): Layout => {
  const top = 84
  const height = 60
  const nodes = stages.map((stage, index): Node => ({
    ...stage,
    x: index * PITCH,
    y: top,
    width: NODE_W,
    height,
    delay: STAGE_START + index,
  }))
  const commitX = 4 * PITCH + NODE_W / 2
  const afterNodes = afterCommit.map((stage, index): Node => ({
    ...stage,
    x: commitX - 66 + (index - 1) * 174,
    y: 214,
    width: 132,
    height: 40,
    delay: AFTER_START + index * 0.3,
  }))
  const mid = top + height / 2
  const regionBottom = 166
  const rail = 192
  const stageLinks = nodes
    .slice(0, -1)
    .map((node, index) =>
      link(node.x + NODE_W + 3, mid, (nodes[index + 1]?.x ?? 0) - 3, mid, 0, false),
    )
  const [first, , last] = afterNodes

  return {
    width: 1000,
    height: 268,
    nodes,
    afterNodes,
    links: [
      ...stageLinks,
      link(commitX, regionBottom + 2, commitX, rail, 5.0, true),
      link(commitX, rail, (first?.x ?? 0) + 66, rail, 5.3, true),
      link(commitX, rail, (last?.x ?? 0) + 66, rail, 5.3, true),
      ...afterNodes.map((node) =>
        link(node.x + 66, rail, node.x + 66, node.y - 3, node.delay - 0.15, true),
      ),
    ],
    region: {
      x: PITCH - 16,
      y: 38,
      width: 3 * PITCH + NODE_W + 32,
      height: regionBottom - 38,
      labelX: PITCH + 2,
      labelY: 64,
    },
    afterLabel: { x: (afterNodes[0]?.x ?? 0) - 14, y: 238, anchor: "end" },
    travel: { x: NODE_W / 2, y: mid, axis: "x", distance: 5 * PITCH },
  }
}

const COLUMN_W = 280
const COLUMN_H = 56
const COLUMN_PITCH = 76

const tall = (): Layout => {
  const nodes = stages.map((stage, index): Node => ({
    ...stage,
    x: 0,
    y: index * COLUMN_PITCH,
    width: COLUMN_W,
    height: COLUMN_H,
    delay: STAGE_START + index,
  }))
  const commitMid = 4 * COLUMN_PITCH + COLUMN_H / 2
  const lanesTop = 5 * COLUMN_PITCH + COLUMN_H + 40
  const afterNodes = afterCommit.map((stage, index): Node => ({
    ...stage,
    x: 0,
    y: lanesTop + index * 54,
    width: COLUMN_W,
    height: 40,
    delay: AFTER_START + index * 0.3,
  }))
  const rail = COLUMN_W + 28
  const lastMid = lanesTop + 2 * 54 + 20
  const stageLinks = nodes
    .slice(0, -1)
    .map((node, index) =>
      link(
        COLUMN_W / 2,
        node.y + COLUMN_H + 2,
        COLUMN_W / 2,
        (nodes[index + 1]?.y ?? 0) - 3,
        0,
        false,
      ),
    )

  return {
    width: rail + 24,
    height: lanesTop + 2 * 54 + 40,
    nodes,
    afterNodes,
    links: [
      ...stageLinks,
      link(COLUMN_W + 2, commitMid, rail, commitMid, 5.0, true),
      link(rail, commitMid, rail, lastMid, 5.3, true),
      ...afterNodes.map((node) =>
        link(rail, node.y + 20, COLUMN_W + 3, node.y + 20, node.delay - 0.15, true),
      ),
    ],
    region: {
      x: -10,
      y: COLUMN_PITCH - 16,
      width: COLUMN_W + 20,
      height: 3 * COLUMN_PITCH + COLUMN_H + 32,
      labelX: 2,
      labelY: COLUMN_PITCH - 3,
    },
    afterLabel: { x: 0, y: lanesTop - 12, anchor: "start" },
    travel: { x: COLUMN_W / 2, y: COLUMN_H / 2, axis: "y", distance: 5 * COLUMN_PITCH },
  }
}

/** The wide layout: six stages in a row, with the after-commit lane beneath the last three. */
export const wideLayout: Layout = wide()

/** The narrow layout: the stages stacked, with the after-commit lane beside the commit. */
export const tallLayout: Layout = tall()
