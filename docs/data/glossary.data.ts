/**
 * VitePress build-time data loader for glossary entries.
 *
 * Consumed via: import { data } from './data/glossary.data'
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const glossaryPath = join(__dirname, "..", "..", "content", "glossary.json")

export interface GlossaryEntry {
  expansion: string
  description: string
  link?: string
}

export type GlossaryData = Record<string, GlossaryEntry>

export default {
  load(): GlossaryData {
    return JSON.parse(readFileSync(glossaryPath, "utf-8"))
  },
}

declare const data: GlossaryData
export { data }
