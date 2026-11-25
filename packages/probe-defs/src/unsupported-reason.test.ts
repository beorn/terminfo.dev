/**
 * @failure An Unsupported result is stored with no reason, so a reader cannot check what was sent and what came back (#33594).
 * @level l1
 * @consumer Every stored result: reasons.json, the site's reason line, run-parser admission
 * @reach fs-walk vendor/terminfo.dev/content/probes-apps/*.json vendor/terminfo.dev/content/probes-libs/*.json
 * @reach fs-walk vendor/terminfo.dev/content/probes-mux/*.json
 * @testonly none
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { escapeControlBytes, observedSummary, recordExecutedProbe } from "./helpers.ts"
import type { ProbeAssertion } from "./types.ts"

const attempt = { scope: "probe" as const, startedAt: "2026-11-25T00:00:00.000Z" }
const negative = (featureId: string, expected: string, observed: string): ProbeAssertion => ({
  featureId,
  kind: "negative",
  assertionType: "query_reply",
  expected,
  observed,
})

it("derives an Unsupported reason from the deciding negative assertion, with control bytes escaped", () => {
  const result = recordExecutedProbe({
    featureId: "extensions.sixel-da1",
    attempt,
    observation: { outcome: "unsupported", assertionType: "query_reply" },
    assertions: [negative("extensions.sixel-da1", "Complete DA1 advertises Sixel attribute 4", "\x1b[?64;1;2;6c")],
  })
  const reason = "Expected: Complete DA1 advertises Sixel attribute 4. Observed: \\e[?64;1;2;6c"
  expect(result).toMatchObject({ status: "unsupported", reason, tests: [{ id: "criterion", reason }] })
})

it("escapes serialized and raw control bytes, says empty is no reply, and names what a cut dropped", () => {
  expect(escapeControlBytes(JSON.stringify({ report: "\x1b[<0;31;11M\x07" }))).toBe('{"report":"\\e[<0;31;11M^G"}')
  expect(escapeControlBytes("a\x01\x7f\x9bz")).toBe("a^A\\x7f\\x9bz")
  expect(observedSummary("")).toBe("no reply")
  expect(observedSummary(`${"x".repeat(160)}yz\x1b`)).toBe(`${"x".repeat(160)}… (4 more bytes)`)
})

it("keeps a named reason, and leaves Supported rows alone", () => {
  const assertions = [negative("modes.altscreen-1048", "?1048 restores cursor", "{}")]
  const named = recordExecutedProbe({
    featureId: "modes.altscreen-1048",
    attempt,
    observation: { outcome: "unsupported", assertionType: "buffer_state", note: "probe note" },
    assertions,
  })
  expect(named.reason).toBe("probe note")
  const supported = recordExecutedProbe({
    featureId: "modes.altscreen-1048",
    attempt,
    observation: { outcome: "supported", assertionType: "buffer_state" },
    assertions,
  })
  expect(supported.reason).toBeUndefined()
})

it("names the defect, never an empty reason, and says so on stderr once per probe", () => {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const record = () =>
      recordExecutedProbe({
        featureId: "text.reasonless-fixture",
        attempt,
        observation: { outcome: "unsupported", assertionType: "buffer_state" },
        assertions: [],
      })
    expect(record().reason).toBe("writer default: unsupported without a reason or negative assertion; callback defect")
    record()
    const lines = write.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("reasonless-fixture"))
    expect(lines).toHaveLength(1)
  } finally {
    write.mockRestore()
  }
})

// @cto d03af07e: a record measured after this writer landed carries no Unsupported row without a reason.
// Records measured before it keep their historical rows (about 1,400 on 2026-11-25) until re-measured.
const WRITER_LANDED = Date.parse("2026-11-26T08:00:00.000Z")
const CONTENT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "content")

/** The corpus is gigabytes; a record keeps measuredAt in its last few KB, so only newer records (or one whose tail misses it) are parsed. */
function measuredAtOf(path: string): string | undefined {
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    const tail = Buffer.alloc(Math.min(size, 65536))
    readSync(fd, tail, 0, tail.length, size - tail.length)
    const found = /"measuredAt":\s*"([^"]+)"/.exec(tail.toString("utf8"))?.[1]
    return found ?? (JSON.parse(readFileSync(path, "utf8")) as { measuredAt?: string }).measuredAt
  } finally {
    closeSync(fd)
  }
}

it("stores no Unsupported row without a reason in any record measured after the writer landed", () => {
  const missing: string[] = []
  const undated: string[] = []
  let files = 0
  let checked = 0
  for (const dir of ["probes-apps", "probes-libs", "probes-mux"]) {
    for (const name of readdirSync(join(CONTENT, dir)).filter((file) => file.endsWith(".json"))) {
      files += 1
      const path = join(CONTENT, dir, name)
      const measuredAt = measuredAtOf(path)
      if (measuredAt === undefined || Number.isNaN(Date.parse(measuredAt))) {
        undated.push(`${dir}/${name}`)
        continue
      }
      if (Date.parse(measuredAt) < WRITER_LANDED) continue
      checked += 1
      const record = JSON.parse(readFileSync(path, "utf8")) as {
        results?: { featureId: string; status: string; reason?: string }[]
      }
      for (const result of record.results ?? []) {
        if (result.status === "unsupported" && !result.reason?.trim()) missing.push(`${dir}/${name}: ${result.featureId}`)
      }
    }
  }
  expect(files, "records read under content/probes-{apps,libs,mux}").toBeGreaterThan(0)
  expect(undated, "records with no readable measuredAt").toEqual([])
  expect(missing, `${checked} records measured after the writer landed`).toEqual([])
})
