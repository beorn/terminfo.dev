// Spike only (29814): report the first byte this terminal receives from the OS input path.
// Runs INSIDE the terminal under test, so a delivered key is observed by the app, not by the driver.
import { writeFileSync } from "node:fs"

const out = process.argv[2]
if (!out) throw new Error("usage: input-spike-reader.mjs <output path>")

// A start marker separates "the terminal never ran the reader" from "no byte arrived".
writeFileSync(`${out}.started`, String(process.pid))

process.stdin.once("data", (chunk) => {
  writeFileSync(out, chunk)
  writeFileSync(`${out}.done`, "1")
  process.exit(0)
})
process.stdin.resume()
