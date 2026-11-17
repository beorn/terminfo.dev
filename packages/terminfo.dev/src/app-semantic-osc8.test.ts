/**
 * @failure The macOS WezTerm owner's OSC 8 rows never reach the shared OSC 8 sampler (the cell stays probe-todo),
 *   an App that only drops OSC 8 grades supported, or an unreviewed App or version reads through the port.
 * @level l1
 * @consumer The hosted-darwin WezTerm owner's readRows port -> readAppSemanticState -> the extensions.osc8 probe.
 * @testonly weztermHyperlinkText: also used by the Linux and macOS WezTerm owners, exported for this test's pane.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { extensionsProbes } from "@terminfo/probe-defs"
import { replayTermProbeSource } from "../../probe-defs/src/testing/group-harness.ts"
import { readAppSemanticState, weztermHyperlinkText } from "./app-semantic-state.ts"

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** The env a verified macOS owner launches its collector child with. */
function ownedLaunch(id: string, version: string) {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-osc8-"))
  directories.push(directory)
  vi.stubEnv("TERMINFO_RUN_ID", runId)
  vi.stubEnv("TERMINFO_MUX_KIND", "")
  vi.stubEnv("TERMINFO_CAPTURE_DIRECTORY", directory)
  vi.stubEnv("TERMINFO_TARGET_ID", id)
  vi.stubEnv("TERMINFO_TARGET_VERSION", version)
}

/**
 * A three-row WezTerm pane: CUP + EL then printed cells, each carrying the OSC 8 link open when it was printed.
 * Its escaped read is what `wezterm cli get-text --escapes` prints for that row: SGR around the text, OSC 8
 * opened and closed with ST; weztermHyperlinkText then keeps only the hyperlinks, as the owner does.
 */
function weztermPane(mode: "supported" | "ignores osc8") {
  const rows: Array<Array<{ ch: string; link: string }>> = [[], [], []]
  let row = 0
  let link = ""
  const write = (text: string) => {
    const tokens = /\x1b\[(\d+);1H|\x1b\[(2)[JK]|\x1b\[[0-9;?]*[A-Za-z]|\x1b\](\d+);([^\x07]*)\x07|([^\x1b]+)/g
    for (const [token, cup, erase, code, body, printed] of text.matchAll(tokens)) {
      if (cup !== undefined) row = Number(cup) - 1
      else if (erase !== undefined && token.endsWith("K")) rows[row]!.length = 0
      else if (erase !== undefined) for (const cells of rows) cells.length = 0
      else if (printed !== undefined) rows[row]?.push(...[...printed].map((ch) => ({ ch, link })))
      else if (code === "8" && body !== undefined && mode === "supported") {
        const [params, ...uri] = body.split(";")
        link = uri.join(";") === "" ? "" : `${params};${uri.join(";")}`
      }
    }
  }
  const render = (escapes: boolean) =>
    rows.map((cells) => {
      let out = escapes ? "\x1b[0m" : ""
      let open = ""
      for (const cell of cells) {
        if (escapes && cell.link !== open) {
          out += cell.link === "" ? "\x1b]8;;\x1b\\" : `\x1b]8;${cell.link}\x1b\\`
          open = cell.link
        }
        out += cell.ch
      }
      if (escapes && open !== "") out += "\x1b]8;;\x1b\\"
      return out
    })
  const reads: boolean[] = []
  return {
    reads,
    write,
    async readRows(escapes: boolean) {
      reads.push(escapes)
      return weztermHyperlinkText(render(escapes))
    },
  }
}

const runId = "e".repeat(32)
const executable = { path: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui", sha256: "d".repeat(64) }

// An App that ignores OSC 8 also fails the handled control (an OSC 8 control URI), so it reads controls-failed,
// never a false supported: the same contract the Linux rows grade under.
test.each([
  { mode: "supported" as const, outcome: "supported", status: undefined },
  { mode: "ignores osc8" as const, outcome: undefined, status: "probe-invalid" },
])("the macOS WezTerm owner's rows reach the OSC 8 probe: $mode", async ({ mode, outcome, status }) => {
  ownedLaunch("wezterm", "20240203-110809-5046fc22")
  const pane = weztermPane(mode)
  const reading = await readAppSemanticState({
    featureId: "extensions.osc8",
    runId,
    executable,
    write: pane.write,
    readRows: pane.readRows,
  })
  expect(reading.status, JSON.stringify(reading)).toBe("measured")
  expect(pane.reads).toContain(true)
  const source = replayTermProbeSource(new Map())
  source.readAppSemanticState = async () => reading
  const result = await extensionsProbes.find((probe) => probe.id === "extensions.osc8")!.term!(source)
  expect(result.observation?.outcome, JSON.stringify(result)).toBe(outcome)
  if (status !== undefined) expect(result.tests?.[0]?.status).toBe(status)
})

test.each([
  { id: "wezterm", version: "20240101-000000-00000000", featureId: "extensions.osc8" },
  { id: "ghostty", version: "1.4.0", featureId: "extensions.osc8" },
  // osc7-cwd reaches the port's own gate; osc1-icon would be answered by the icon branch before it (@dev/fixer).
  { id: "wezterm", version: "20240203-110809-5046fc22", featureId: "extensions.osc7-cwd" },
])("an unreviewed $id $version $featureId never reads through the port", async ({ id, version, featureId }) => {
  ownedLaunch(id, version)
  const pane = weztermPane("supported")
  const reading = await readAppSemanticState({
    featureId,
    runId,
    executable,
    write: pane.write,
    readRows: pane.readRows,
  })
  expect(reading).toMatchObject({ status: "unavailable", reason: "No reviewed owned row reader for this App/feature" })
  expect(pane.reads).toEqual([])
})
