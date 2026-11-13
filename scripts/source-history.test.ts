/**
 * @failure The per-row join reads the wrong defining file for a row (or none), calls two different files equal,
 *   or treats an unreadable source revision as "unrelated" or "equal", so a row joins across a probe change.
 * @level l2
 * @consumer Site per-row context join (app-cells.ts via current-results.ts joinedAppCells) and the lineage pick
 * @testonly none
 * @reach git-read vendor/terminfo.dev history (full-history checkout, as deploy and validate fetch)
 */
import { describe, expect, it } from "vitest"
import { definingFile, definitionDiffers, gitSourceHistory, type SourceHistory } from "../docs/data/source-history.ts"

// Terminal.app 2.15: hosted 26.7.2 measured at HOSTED, codimac 26.6.2 at OWNED (33587); HOSTED is OWNED's ancestor.
const HOSTED = "341e632f13080f74caeb6323f2e8d57652e2ac27"
const OWNED = "07fd3a9d8dbb1808c5f1d4ba8d417c093203fc1e"
const git = gitSourceHistory()

describe("the defining file of a row, read from the revision's registration", () => {
  it("names the family module ALL_PROBES imports, including rows a helper module builds", () => {
    expect(definingFile(git, HOSTED, "sgr.bold")).toEqual({ path: "packages/probe-defs/src/sgr.ts" })
    expect(definingFile(git, HOSTED, "device.env-term")).toEqual({ path: "packages/probe-defs/src/device.ts" })
    expect(definingFile(git, HOSTED, "extensions.osc52-write")).toEqual({
      path: "packages/probe-defs/src/extensions.ts",
    })
  })

  it("calls a row equal only when its defining file is byte-equal at both revisions, and names the file otherwise", () => {
    expect(definitionDiffers(git, "cursor.hide", HOSTED, OWNED)).toBeNull()
    expect(definitionDiffers(git, "sgr.bold", HOSTED, OWNED)).toBe(
      `packages/probe-defs/src/sgr.ts differs between ${HOSTED.slice(0, 12)} and ${OWNED.slice(0, 12)}`,
    )
  })

  it("refuses by name when the revision registers no single module for the row's family", () => {
    const stub: SourceHistory = {
      isAncestor: () => true,
      blobId: () => "0".repeat(40),
      text: () => 'import { sgrProbes } from "./sgr.ts"\nexport const ALL_PROBES = [...sgrProbes]\n',
    }
    expect(definingFile(stub, HOSTED, "cursor.hide")).toEqual({
      refused: `packages/probe-defs/src/index.ts at ${HOSTED.slice(0, 12)} registers 0 modules for cursorProbes, not one spread into ALL_PROBES`,
    })
  })
})

describe("source ancestry", () => {
  it("reads descendant and unrelated from git, never guessing", () => {
    expect(git.isAncestor(HOSTED, OWNED)).toBe(true)
    expect(git.isAncestor(OWNED, HOSTED)).toBe(false)
  })

  it("throws by name for a revision this repository does not hold", () => {
    expect(() => git.isAncestor("f".repeat(40), OWNED)).toThrow(
      /Source revision f{40} is not in .*full-history checkout/,
    )
  })
})
