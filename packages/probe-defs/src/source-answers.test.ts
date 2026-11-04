/**
 * @failure A stored source-answer key no longer round-trips, so the run reader cannot recognise a retired cell.
 * @level l0
 * @consumer Canonical run reader (run-parser) recognising stored source-answer cells as PROBE TODO
 * @testonly none
 */
import { expect, it } from "vitest"
import { parseSourceAnswerKey, sourceAnswerKey, type SourceAnswerSubject } from "./source-answers.ts"

// Restored from the pre-#32246 test (@cto batch7 A-F7): run-parser depends on these three behaviours of the key.
it("round-trips a stored source-answer key and rejects malformed ones", () => {
  const subject: SourceAnswerSubject = { kind: "lib", id: "vterm", version: "0.10.1", os: "linux" }
  expect(parseSourceAnswerKey(sourceAnswerKey(subject, "sgr.bold"))).toEqual({ subject, featureId: "sgr.bold" })
  expect(parseSourceAnswerKey("collector.review.original")).toBeUndefined()
  expect(() => parseSourceAnswerKey("[bad")).toThrow("Invalid source-answer key")
})
