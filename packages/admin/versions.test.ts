/**
 * @failure Imported probe definitions can change while the shared suite hash remains unchanged.
 * @level l1
 * @consumer Headless probe cache and selected-run suite identity
 * @testonly none
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/ vendor/terminfo.dev/packages/probes/ vendor/terminfo.dev/packages/terminfo.dev/src/
 */
import { expect, test, vi } from "vitest"

const changed = vi.hoisted(() => ({ file: "" }))
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return {
    ...fs,
    readFileSync(path: string, encoding?: BufferEncoding) {
      if (encoding) return fs.readFileSync(path, encoding)
      const bytes = fs.readFileSync(path)
      return changed.file && path.endsWith(changed.file) ? Buffer.concat([bytes, Buffer.from("\n// changed")]) : bytes
    },
  }
})

import { probeHash, probeSuiteSnapshot } from "./versions.ts"

test("suite hash changes when either imported mode or extension definitions change", () => {
  const baseline = probeHash()
  for (const file of ["modes.ts", "extensions.ts"]) {
    changed.file = file
    expect(probeHash()).not.toBe(baseline)
  }
  changed.file = ""
})

test("suite identity changes with executable collection, ownership, capture and identity source", () => {
  const baseline = probeHash()
  for (const file of [
    "packages/probes/headless-batch.ts",
    "packages/terminfo.dev/src/probes/unified.ts",
    "packages/terminfo.dev/src/tty.ts",
    "packages/terminfo.dev/src/linux-clipboard.ts",
    "packages/terminfo.dev/src/owned-terminal.ts",
    "packages/terminfo.dev/src/linux-capture.ts",
    "packages/terminfo.dev/src/linux-input.ts",
    "packages/terminfo.dev/src/serve.ts",
    "packages/terminfo.dev/src/detect.ts",
    "packages/terminfo.dev/src/identity-guard.ts",
  ]) {
    changed.file = file
    expect(probeHash(), file).not.toBe(baseline)
  }
  changed.file = ""
  const snapshot = probeSuiteSnapshot()
  expect(snapshot.probes.app).toHaveLength(260)
  expect(snapshot.probes.headless).toHaveLength(249)
  expect(snapshot.probes.mux).toEqual(snapshot.probes.app)
  expect(snapshot.probes.app).toContain("extensions.kitty-keyboard")
  expect(snapshot.probes.app).toContain("input.xtest-key")
  expect(snapshot.probes.app).toEqual([...snapshot.probes.app].sort())
  expect(snapshot.sourcePaths).toContain("packages/terminfo.dev/src/tty.ts")
  expect(snapshot.sourcePaths).toContain("packages/terminfo.dev/src/linux-input.ts")
})

/**
 * 28786: the sourcePaths list must cover EVERY source the collector EXECUTES.
 * A change to an executed source that is omitted keeps the old probe hash, so an admitted run can cite a suite
 * that no longer describes the collector — the reverse of the falsification the hash exists for.
 */
test("28786: a collector-executed source omitted from the list lets the suite hash go stale", () => {
  const baseline = probeHash()
  for (const file of [
    "packages/terminfo.dev/src/disposable-receipt.ts",
    "packages/run-parser/src/index.ts",
    "packages/run-parser/src/app-launch.ts",
  ]) {
    changed.file = file
    expect(probeHash(), `${file} is executed by the collector and must move the suite hash`).not.toBe(baseline)
  }
  changed.file = ""
})

/**
 * 28786, negative control: a source the collector NEVER runs must not move the suite.
 * `terminal-app-window.ts` is imported only by packages/admin/src (app.ts, terminal-app-receipt.ts), never by a
 * collection path, so listing it lets a change move the suite without touching any observation.
 */
test("28786: a source the collector never runs does not move the suite hash", () => {
  const baseline = probeHash()
  changed.file = "packages/terminfo.dev/src/terminal-app-window.ts"
  expect(probeHash(), "terminal-app-window.ts is never executed by the collector").toBe(baseline)
  changed.file = ""
})
