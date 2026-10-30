/** Persist retained domain results after native task metadata and attachments arrive. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Reporter } from "vitest/node"
import type { EraseRunRecord } from "../probes/erase-run.ts"

export default class CensusReporter implements Reporter {
  readonly records: EraseRunRecord[] = []
  private readonly ready = new Set<string>()
  constructor(private readonly directory: string) {}
  onTestCaseArtifactRecord: NonNullable<Reporter["onTestCaseArtifactRecord"]> = async (task, artifact) => {
    if (artifact.type !== "terminfo:erase") return
    for (const attachment of artifact.attachments ?? []) {
      if (!attachment.path) throw new Error("Erase attachment has no persisted path")
      JSON.parse(readFileSync(attachment.path, "utf8"))
    }
    this.ready.add(task.id)
  }
  onTestCaseResult: NonNullable<Reporter["onTestCaseResult"]> = async (task) => {
    const record = task.meta().terminfoErase
    if (!record) throw new Error("Erase task has no runner-owned final metadata: " + task.name)
    if (!record.error && !this.ready.has(task.id))
      throw new Error("Erase task completed before its attachments arrived")
    const results =
      record.failureResults ?? record.assertions.at(-1)?.results.filter((entry) => entry.attempt.scope !== "none")
    if (!results?.length) throw new Error("Erase task has no retained domain results: " + task.name)
    const counts: Record<string, number> = {}
    for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(
      join(this.directory, encodeURIComponent(task.id) + ".report.json"),
      JSON.stringify({ record, counts }, null, 2),
      { flag: "wx" },
    )
    this.records.push(record)
  }
}
