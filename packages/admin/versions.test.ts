/**
 * @failure Imported probe definitions can change while the shared suite hash remains unchanged.
 * @level l1
 * @consumer Headless probe cache and selected-run suite identity
 * @testonly none
 * @reach fs-walk vendor/terminfo.dev/packages/probe-defs/src/
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
      return path.endsWith(`/packages/probe-defs/src/${changed.file}`)
        ? Buffer.concat([bytes, Buffer.from("\n// changed")])
        : bytes
    },
  }
})

import { probeHash } from "./versions.ts"

test("suite hash changes when either imported mode or extension definitions change", () => {
  const baseline = probeHash()
  for (const file of ["modes.ts", "extensions.ts"]) {
    changed.file = file
    expect(probeHash()).not.toBe(baseline)
  }
  changed.file = ""
})
