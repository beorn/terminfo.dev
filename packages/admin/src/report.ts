/** Report command — render the canonical selected observations and separate history. */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadCurrentResults } from "../../../docs/data/current-results.ts"
import { renderReport } from "../report.tsx"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

export async function handleReport(): Promise<void> {
  const contentDir = join(ROOT, "content")
  const { projection } = loadCurrentResults(contentDir)
  // The selector has already validated this required catalog; its IDs supply the report's absent rows.
  const catalog = JSON.parse(readFileSync(join(contentDir, "features.json"), "utf8")) as Record<string, unknown>
  const featureIds = Object.keys(catalog).filter((id) => !id.startsWith("$"))
  console.log(await renderReport(projection, featureIds))
}
