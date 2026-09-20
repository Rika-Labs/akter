const role = process.argv[2] ?? "requested feature"
console.error(`${role} is intentionally not implemented in this setup-only repository.`)
console.error("Read START_HERE.md and docs/VALIDATION_GATES.md before adding runtime behavior.")
process.exitCode = 1
