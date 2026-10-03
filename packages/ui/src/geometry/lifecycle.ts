/** A stage box in a diagram, in the diagram's own coordinates. */
export interface DiagramNode {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly emphasis: boolean
}

/** A connector between two stages; `dashed` marks work that happens after the turn has replied. */
export interface DiagramEdge {
  readonly id: string
  readonly d: string
  readonly dashed: boolean
}

/** A labelled boundary drawn around several stages. */
export interface DiagramRegion {
  readonly label: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Everything a renderer needs to draw a diagram, plus the paths a moving marker follows. */
export interface DiagramLayout {
  readonly width: number
  readonly height: number
  readonly nodes: ReadonlyArray<DiagramNode>
  readonly edges: ReadonlyArray<DiagramEdge>
  readonly regions: ReadonlyArray<DiagramRegion>
  readonly tracks: ReadonlyArray<string>
}

/** One stage of an actor turn and what it guarantees. */
export interface Stage {
  readonly id: string
  readonly label: string
  readonly detail: string
}

/** The stages of one actor turn, from the command arriving to the reply. */
export const turnStages: ReadonlyArray<Stage> = [
  { id: "command", label: "Command", detail: "with an idempotency key" },
  { id: "fence", label: "Fence", detail: "owner and generation" },
  { id: "receipt", label: "Receipt", detail: "a retry returns it" },
  { id: "handler", label: "Handler", detail: "a short, pure turn" },
  { id: "commit", label: "Commit", detail: "state, rows, outbox" },
  { id: "reply", label: "Reply", detail: "result or typed error" },
]

/** The outbox a commit writes, released only once the turn is durable. */
export const outboxStage: Stage = { id: "outbox", label: "Outbox", detail: "released after commit" }

/** What the outbox releases once a turn has committed. */
export const releasedStages: ReadonlyArray<Stage> = [
  { id: "jobs", label: "Jobs", detail: "retried until done" },
  { id: "timers", label: "Timers", detail: "wake the actor later" },
  { id: "messages", label: "Messages", detail: "to other actors" },
]

const commitIndex = turnStages.findIndex((stage) => stage.id === "commit")

const transaction = new Set(["fence", "receipt", "handler", "commit"])

const node = (
  stage: Stage,
  box: Readonly<{ x: number; y: number; width: number; height: number }>,
): DiagramNode => ({ ...stage, ...box, emphasis: stage.id === "commit" })

const horizontal = (): DiagramLayout => {
  const width = 1000
  const boxWidth = 128
  const boxHeight = 54
  const gap = (width - 40 - boxWidth * turnStages.length) / (turnStages.length - 1)
  const mainY = 64
  const main = turnStages.map((stage, index) =>
    node(stage, { x: 20 + index * (boxWidth + gap), y: mainY, width: boxWidth, height: boxHeight }),
  )
  const commitX = 20 + commitIndex * (boxWidth + gap)
  const commit = node(turnStages[commitIndex] ?? outboxStage, {
    x: commitX,
    y: mainY,
    width: boxWidth,
    height: boxHeight,
  })
  const outboxY = 196
  const outbox = node(outboxStage, {
    x: commit.x,
    y: outboxY,
    width: boxWidth,
    height: boxHeight,
  })
  const fanY = 300
  const fan = releasedStages.map((stage, index) =>
    node(stage, {
      x: commit.x + (index - 1) * (boxWidth + 26),
      y: fanY,
      width: boxWidth,
      height: boxHeight,
    }),
  )
  const middle = mainY + boxHeight / 2
  const edges: Array<DiagramEdge> = main.slice(1).map((target, index) => {
    const source = main[index] ?? target
    return {
      id: `${source.id}-${target.id}`,
      d: `M${source.x + source.width} ${middle}H${target.x - 4}`,
      dashed: false,
    }
  })
  const commitBottom = commit.y + commit.height
  const outboxCenter = commit.x + boxWidth / 2
  edges.push({
    id: "commit-outbox",
    d: `M${outboxCenter} ${commitBottom}V${outboxY - 4}`,
    dashed: true,
  })
  for (const target of fan) {
    const targetCenter = target.x + boxWidth / 2
    const startY = outboxY + boxHeight
    const bend = (startY + fanY) / 2
    edges.push({
      id: `outbox-${target.id}`,
      d: `M${outboxCenter} ${startY}C${outboxCenter} ${bend} ${targetCenter} ${bend} ${targetCenter} ${fanY - 4}`,
      dashed: true,
    })
  }
  const inside = main.filter((candidate) => transaction.has(candidate.id))
  const first = inside[0] ?? commit
  const last = inside.at(-1) ?? commit
  return {
    width,
    height: fanY + boxHeight + 16,
    nodes: [...main, outbox, ...fan],
    edges,
    regions: [
      {
        label: "One transaction",
        x: first.x - 14,
        y: mainY - 36,
        width: last.x + last.width - first.x + 28,
        height: boxHeight + 52,
      },
    ],
    tracks: [
      `M${(main[0]?.x ?? 0) + 8} ${middle}H${(main.at(-1)?.x ?? 0) + boxWidth - 8}`,
      `M${outboxCenter} ${middle}V${outboxY + boxHeight / 2}`,
    ],
  }
}

const vertical = (): DiagramLayout => {
  const width = 360
  const boxWidth = 150
  const boxHeight = 50
  const step = 70
  const top = 34
  const main = turnStages.map((stage, index) =>
    node(stage, { x: 14, y: top + index * step, width: boxWidth, height: boxHeight }),
  )
  const commit = node(turnStages[commitIndex] ?? outboxStage, {
    x: 14,
    y: top + commitIndex * step,
    width: boxWidth,
    height: boxHeight,
  })
  const sideX = width - 14 - boxWidth + 10
  const sideWidth = boxWidth - 10
  const outbox = node(outboxStage, {
    x: sideX,
    y: commit.y,
    width: sideWidth,
    height: boxHeight,
  })
  const fan = releasedStages.map((stage, index) =>
    node(stage, {
      x: sideX,
      y: commit.y + (index + 1) * step,
      width: sideWidth,
      height: boxHeight,
    }),
  )
  const center = 14 + boxWidth / 2
  const edges: Array<DiagramEdge> = main.slice(1).map((target, index) => {
    const source = main[index] ?? target
    return {
      id: `${source.id}-${target.id}`,
      d: `M${center} ${source.y + boxHeight}V${target.y - 4}`,
      dashed: false,
    }
  })
  const sideCenter = sideX + sideWidth / 2
  edges.push({
    id: "commit-outbox",
    d: `M${commit.x + boxWidth} ${commit.y + boxHeight / 2}H${sideX - 4}`,
    dashed: true,
  })
  const chain = [outbox, ...fan]
  chain.slice(1).forEach((target, index) => {
    const source = chain[index] ?? target
    edges.push({
      id: `${source.id}-${target.id}`,
      d: `M${sideCenter} ${source.y + boxHeight}V${target.y - 4}`,
      dashed: true,
    })
  })
  const inside = main.filter((candidate) => transaction.has(candidate.id))
  const first = inside[0] ?? commit
  const last = inside.at(-1) ?? commit
  return {
    width,
    height: top + (main.length - 1) * step + boxHeight + 34,
    nodes: [...main, ...chain],
    edges,
    regions: [
      {
        label: "One transaction",
        x: 6,
        y: first.y - 26,
        width: boxWidth + 16,
        height: last.y + boxHeight - first.y + 34,
      },
    ],
    tracks: [`M${center} ${top + 8}V${(main.at(-1)?.y ?? 0) + boxHeight - 8}`],
  }
}

/**
 * The actor turn lifecycle: a command passes the fence and the receipt check, runs its handler and
 * commits in one transaction, then replies; the commit's outbox later releases jobs, timers and
 * messages. `horizontal` suits wide screens, `vertical` phones.
 */
export const lifecycleLayout = (orientation: "horizontal" | "vertical"): DiagramLayout =>
  orientation === "horizontal" ? horizontal() : vertical()
