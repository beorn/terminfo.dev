// Spike only (29814): report the first byte this terminal receives from the OS input path.
// Runs INSIDE the terminal under test, so a delivered key is observed by the app, not by the driver.
import { writeFileSync } from "node:fs"

const out = process.argv[2]
if (!out) throw new Error("usage: input-spike-reader.mjs <output path>")

process.stdin.once("data", (chunk) => {
  writeFileSync(out, chunk)
  process.exit(0)
})
process.stdin.resume()
