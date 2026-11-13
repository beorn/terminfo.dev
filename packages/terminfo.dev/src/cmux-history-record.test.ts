/**
 * @failure The persisted run loses the cmux arm's grant receipt, its acquired surface or its last read,
 *   or records the grant as if it were the last read.
 * @level l1
 * @consumer serve.ts's run-record construction for a hosted cmux arm (31741 follow-up, @dev/1 peer read).
 * @testonly none
 */
import { expect, test } from "vitest"
import { cmuxHistoryEvidence } from "./cmux-history-record.ts"

const surface = "33D1C212-FBFA-46FA-B2C9-44F20A949C0E"

test("the record carries the read that happened, not the grant it started from", () => {
  const grant = JSON.stringify({ surface, ownership: "nonce", markers: null, extras: null, totalLines: 41 })
  const later = JSON.stringify({ surface, ownership: "surface", markers: null, extras: null, totalLines: 73 })
  let current = grant
  const history = {
    executable: "/Applications/cmux.app/Contents/MacOS/cmux",
    surface,
    grantProof: grant,
    get lastRead(): string | null {
      return current
    },
  }
  const before = cmuxHistoryEvidence(history)
  const beforeRecord = JSON.parse(before?.["collector.cmuxHistory"] ?? "{}")
  expect(JSON.parse(beforeRecord.lastRead)).toMatchObject({ ownership: "nonce", totalLines: 41 })
  current = later
  const after = cmuxHistoryEvidence(history)
  const afterRecord = JSON.parse(after?.["collector.cmuxHistory"] ?? "{}")
  expect(JSON.parse(afterRecord.lastRead)).toMatchObject({ ownership: "surface", totalLines: 73 })
})

test("a failed grant is recorded in its own words, with no read to show", () => {
  const failure =
    "cmux-surface-not-owned: the app published no CMUX_SURFACE_ID, so no read can name the surface this run acquired"
  const evidence = cmuxHistoryEvidence({
    executable: "/Applications/cmux.app/Contents/MacOS/cmux",
    surface: null,
    grantProof: failure,
    lastRead: null,
  })
  expect(JSON.parse(evidence?.["collector.cmuxHistory"] ?? "{}")).toEqual({
    executable: "/Applications/cmux.app/Contents/MacOS/cmux",
    surface: null,
    grantProof: failure,
    lastRead: null,
  })
})

test("a launch with no config file keeps the absence in the receipt instead of dropping it", () => {
  const receipt = JSON.stringify({ surface, ownership: "nonce", config: { read: "absent" }, totalLines: 12 })
  const evidence = cmuxHistoryEvidence({
    executable: "/Applications/cmux.app/Contents/MacOS/cmux",
    surface,
    grantProof: receipt,
    lastRead: null,
  })
  expect(JSON.parse(JSON.parse(evidence?.["collector.cmuxHistory"] ?? "{}").grantProof).config).toEqual({
    read: "absent",
  })
})

test("a run with no cmux arm writes no cmux evidence at all", () => {
  expect(cmuxHistoryEvidence(undefined)).toBeUndefined()
})
