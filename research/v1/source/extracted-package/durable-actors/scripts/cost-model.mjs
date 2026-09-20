import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const model = JSON.parse(readFileSync(join(root, "models/unit-economics.json"), "utf8"))
const rows = []
for (const scenario of ["illustrative-retail", "hypothetical-negotiated"]) {
  const r = { ...model.rates, ...(scenario === "hypothetical-negotiated" ? model.negotiatedScenario : {}) }
  for (const w of model.workloads) {
    const computeM = w.commandsMillion * w.computeGbSecondsPerCommand
    const revenue = r.platformPrice + w.commandsMillion * r.commandsPerMillionPrice + computeM * r.computePerMillionGbSecondsPrice + w.dbGb * r.dbGbMonthPrice + w.blobGb * r.blobGbMonthPrice + w.egressGb * r.egressGbPrice
    const dbWrites = w.commandsMillion * w.writesPerCommand * r.dbWriteMillionCost
    const baseCost = dbWrites + w.commandsMillion * w.readsPerCommand * r.dbReadMillionCost + computeM * r.computePerMillionGbSecondsCost + w.dbGb * r.dbGbMonthCost + w.blobGb * r.blobGbMonthCost + w.egressGb * r.egressGbCost + r.platformBaselinePerCustomerCost + r.supportPerCustomerCost + w.commandsMillion * r.telemetryPerMillionCommandsCost + r.databaseFleetFixedCost + w.newDatabases / 1000 * r.databaseCreationPerThousandCost
    const cost = baseCost * (1 + r.contingencyFraction) + revenue * r.paymentProcessingFraction
    rows.push({ scenario, workload: w.name, actors: w.actors, commandsMillion: w.commandsMillion, writesPerCommand: w.writesPerCommand, revenue: Number(revenue.toFixed(2)), cogs: Number(cost.toFixed(2)), grossProfit: Number((revenue - cost).toFixed(2)), grossMarginPercent: Number(((revenue - cost) / revenue * 100).toFixed(2)) })
  }
}
const directory = join(root, "models/results")
mkdirSync(directory, { recursive: true })
writeFileSync(join(directory, "scenarios.json"), JSON.stringify({ status: model.status, warnings: model.warnings, rows }, null, 2))
const columns = Object.keys(rows[0])
writeFileSync(join(directory, "scenarios.csv"), `${columns.join(",")}\n${rows.map((row) => columns.map((key) => row[key]).join(",")).join("\n")}\n`)
console.table(rows)
console.log("These are arithmetic scenarios, not vendor quotes or a revenue forecast. Negative margins are intentionally not hidden.")
