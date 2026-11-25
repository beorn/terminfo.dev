/**
 * @failure Result card v12 formatting regresses to misleading test sequences, repeats terminal names in answers,
 *   leaks setup bytes / DA1 fences into the card, omits cropped screen/text-cell captures or leaks window chrome
 *   outside the calibrated terminal cell grid, leaves any uncovered kind blank, or misses invalid capture files
 *   in check-private-leak (#38269).
 * @level l1
 * @consumer terminfo.dev result cards, cropped screenshot & text-cell pipeline, check-private-leak
 * @testonly none
 */
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  cropDecodedPng,
  cropReadCellsFromDecoded,
  cropTerminalGridFromDecoded,
  decodePngBytes,
  describeCellRegion,
  encodeRgbaPng,
} from "../docs/data/crop-png.ts"
import {
  buildCardModel,
  expectedVisualSpecimen,
  formatWhoLine,
  shortTerminalName,
  truncateCode,
  vendorExtensionOrigin,
} from "../docs/.vitepress/theme/card-explain.ts"
import { readCellTrace } from "../docs/data/evidence-reader.ts"
import { parseRun, parseSuiteManifest } from "@terminfo/run-parser"
import { projectResults, readVerifiedArtifact } from "../docs/data/selected-results.ts"
import { currentTrace } from "../docs/data/run-trace.ts"
import { scanDist } from "./check-private-leak.ts"

const root = join(import.meta.dirname, "..")
const contentDir = join(root, "content")

describe("crop-png — pure-TS PNG cropping strictly inside calibrated terminal grid (#38269 item 5)", () => {
  it("round-trips RGBA PNGs and clamps read-cell crops strictly inside the terminal cell grid", () => {
    const w = 100
    const h = 80
    const rgba = Buffer.alloc(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        rgba[i] = x < 10 || y < 20 ? 255 : 10
        rgba[i + 1] = y >= 20 ? 120 : 0
        rgba[i + 2] = 40
        rgba[i + 3] = 255
      }
    }
    const encoded = encodeRgbaPng(w, h, rgba)
    const decoded = decodePngBytes(encoded)
    expect(decoded.width).toBe(w)
    expect(decoded.height).toBe(h)

    const cellCrop = { origin: { x: 10, y: 20 }, cell: { width: 10, height: 10 }, grid: { columns: 8, rows: 5 } }
    const readCrop = cropReadCellsFromDecoded(decoded, { x: 0, y: 5, width: 30, height: 25 }, cellCrop, 0)
    expect(readCrop.width).toBe(20)
    expect(readCrop.height).toBe(10)
    expect(decodePngBytes(readCrop.png).rgba[0]).toBe(10)

    const fullGrid = cropTerminalGridFromDecoded(decoded, cellCrop)
    expect(fullGrid.width).toBe(80)
    expect(fullGrid.height).toBe(50)
    expect(decodePngBytes(fullGrid.png).rgba[0]).toBe(10)

    expect(describeCellRegion({ x: 30, y: 40, width: 40, height: 10 }, cellCrop)).toBe("row 3, from column 3")
  })

  it("crops real Kitty 0.49.2 sgr.overline PNG artifact cleanly without external binaries", () => {
    const runPath = join(contentDir, "probes-apps", "kitty-0.49.2-linux-532e0773c813b92b4fc9f4843759e9dd.json")
    const parsed = JSON.parse(readFileSync(runPath, "utf8")) as {
      results: Array<{
        featureId: string
        frames?: Array<{
          role: string
          ref: string
          regionRectangle?: { x: number; y: number; width: number; height: number }
        }>
      }>
    }
    const overline = parsed.results.find((r) => r.featureId === "sgr.overline")
    const target = overline?.frames?.find((f) => f.role === "target")
    expect(target?.ref).toBeDefined()
    const sha = target!.ref.replace(/^sha256:/, "")
    const pngPath = join(contentDir, "artifacts", `${sha}.png`)
    const decoded = decodePngBytes(readFileSync(pngPath))
    const rect = target!.regionRectangle!
    const crop = cropDecodedPng(decoded, rect)
    expect(crop.width).toBe(rect.width)
    expect(crop.height).toBe(rect.height)
    expect(decodePngBytes(crop.png).width).toBe(rect.width)
  })
})

describe("card-explain v12 — all card cases (#38269, card-mock-v12.html)", () => {
  it("formats DECRQM mouse card: drops DA1 fence, blue Reply readout, explains reply 2 in closing sentence", () => {
    const model = buildCardModel({
      status: "supported",
      featureId: "input.mouse-any-event",
      featureName: "All-motion mouse (DECSET 1003)",
      shortSubjectName: "Alacritty",
      assertionType: "query_reply",
      exchange: {
        events: [
          { kind: "query", sequence: "\x1b[?1003$p\x1b[c", match: ["\x1b[?1003;2$y"] },
          { kind: "query", sequence: "\x1b[c", match: ["\x1b[?62;4c"] },
        ],
      },
    })
    expect(model.steps).toEqual([{ num: 1, code: "ESC [ ?1003 $ p", words: "Ask: do you know mode 1003?" }])
    expect(model.readout).toEqual({
      label: "Reply",
      text: "“Yes, it is off right now”",
      code: "ESC [ ?1003;2 $ y",
      mark: "ok",
    })
    expect(model.closing).toBe(
      "Alacritty knows mode 1003, so an app can turn it on (it is off until one does). We did not move the mouse.",
    )
  })

  it("formats no-reply with DA1 end marker (OSC 776 card)", () => {
    const model = buildCardModel({
      status: "unsupported",
      featureId: "extensions.osc776-cell-size",
      featureName: "Cell size report (OSC 776)",
      assertionType: "query_reply",
      exchange: {
        events: [
          { kind: "query", sequence: "\x1b]776;\x07", match: null },
          { kind: "query", sequence: "\x1b[c", match: ["\x1b[?62;4c"] },
        ],
      },
    })
    expect(model.steps).toEqual([
      { num: 1, code: "ESC ]776; BEL", words: "Ask: how big is a cell?" },
      { num: 2, code: "ESC [ c", words: "End marker (always answered)" },
    ])
    expect(model.readout).toEqual({
      label: "Reply",
      text: "answered only the end marker",
      code: "ESC [ ?62;4 c",
      mark: "no",
    })
    expect(model.closing).toBe(
      "ESC [ c always gets an answer, so it marks the end: only that answer came back, so the question was ignored. A supporting terminal answers ESC ] 776 ; <width> ; <height> BEL first.",
    )
  })

  it("formats Kitty overline screen+DECRQSS card, iTerm2 light-theme cell note, and Cut (a) single-screen non-SGR card", () => {
    const fakeCap = {
      observed: { url: `/api/v3/captures/${"a".repeat(64)}.png`, sha256: "a".repeat(64), width: 100, height: 24 },
    }
    const overline = buildCardModel({
      status: "unsupported",
      featureId: "sgr.overline",
      featureName: "Overline (SGR 53)",
      assertionType: "screenshot",
      captures: fakeCap,
      hasExpectedPicture: true,
      exchange: {
        events: [
          { kind: "write", sequence: "\x1b[53m" },
          { kind: "query", sequence: "\x1bP$qm\x1b\\\x1b[c", match: ["\x1bP1$rm\x1b\\"] },
          { kind: "write", sequence: "\x1b7\x1b[1;1H\x1b[0m\x1b[45m   \x1b[2;1H\x1b[45m   \x1b[0m\x1b8" },
          { kind: "write", sequence: "\x1b[2J\x1b[H" },
          {
            kind: "write",
            sequence: "\x1b[0m\x1b[3;3H\x1b[53mAaBb 0123456789 - terminal text\x1b[0m\x1b[2;1H\x1b[1;1H",
          },
        ],
      },
    })
    expect(overline.steps).toEqual([
      { num: 1, code: "ESC [ 53 m", words: "Turn on overline and draw text" },
      { num: 2, code: "ESC P $ q m ESC \\", words: "Ask current setting (DECRQSS)" },
    ])
    expect(overline.readout).toEqual({
      label: "Reply",
      text: "“Setting: plain (default)” (overline did not stick)",
      code: "ESC P 1 $ r m ESC \\",
    })
    expect(overline.closing).toBe("No line above the text.")
    expect(expectedVisualSpecimen("sgr.overline")?.style.textDecoration).toBe("overline")
    expect(expectedVisualSpecimen("sgr.overline")?.text).toBe("AaBb 0123456789 - terminal text")

    const iterm2 = buildCardModel({
      status: "unsupported",
      featureId: "extensions.iterm2-images",
      featureName: "iTerm2 Inline Images (OSC 1337)",
      assertionType: "screenshot",
      captures: fakeCap,
      hasExpectedPicture: true,
    })
    expect(iterm2.closing).toContain("stayed blank and did not change")
    expect(iterm2.closing).toContain("xterm")

    const deccara = buildCardModel({
      status: "unsupported",
      featureId: "editing.deccara",
      featureName: "Change Attributes in Rectangular Area",
      assertionType: "screenshot",
      captures: fakeCap,
      hasExpectedPicture: false,
      expectedSentence: "DECCARA changes SGR attributes inside a rectangular region.",
    })
    expect(deccara.closing).toBe(
      "Screen did not match. Expected: DECCARA changes SGR attributes inside a rectangular region.",
    )
  })

  it("formats cursor save/restore, library readout, process_environment, clipboard truncation, Untestable, No result yet, and vendor tags", () => {
    const saveRestore = buildCardModel({
      status: "supported",
      featureId: "cursor.save-restore",
      featureName: "Save and restore cursor",
      assertionType: "query_reply",
      exchange: {
        events: [
          { kind: "write", sequence: "\x1b[3;5H\x1b7\x1b[10;10H\x1b8" },
          { kind: "query", sequence: "\x1b[6n", match: ["\x1b[3;5R"] },
        ],
      },
    })
    expect(saveRestore.steps).toEqual([
      { num: 1, code: "ESC 7", words: "Save the cursor at 3;5" },
      { num: 2, code: "ESC [ 10;10 H", words: "Move to 10;10" },
      { num: 3, code: "ESC 8", words: "Restore" },
      { num: 4, code: "ESC [ 6 n", words: "Ask where the cursor is" },
    ])
    expect(saveRestore.readout).toEqual({ label: "Reply", text: "“At 3;5”", code: "ESC [ 3;5 R", mark: "ok" })
    expect(saveRestore.closing).toBe("The cursor came back. Saved colors were not checked.")

    const libModel = buildCardModel({
      status: "supported",
      featureId: "sgr.bold",
      featureName: "Bold (SGR 1)",
      subjectKind: "lib",
      declaredSequence: "ESC [ 1 m",
      parserState: { char: "X", bold: true, fg: null, bg: null },
    })
    expect(libModel.readout?.label).toBe("Library says")
    expect(libModel.readout?.codeMuted).toBe("read directly")
    expect(libModel.readout?.text).toContain("bold")
    expect(libModel.contextNote).toContain("library has no screen")

    const envModel = buildCardModel({
      status: "unsupported",
      featureId: "device.term-features",
      featureName: "TERM_FEATURES",
      assertionType: "process_environment",
      traceEvidence: ["TERM_FEATURES was not set."],
    })
    expect(envModel.steps).toEqual([{ num: 1, code: "", codeMuted: "no bytes", words: "Read TERM_FEATURES at launch" }])
    expect(envModel.readout?.label).toBe("TERM_FEATURES")
    expect(envModel.readout?.codeMuted).toBe("read directly")

    const clipModel = buildCardModel({
      status: "supported",
      featureId: "extensions.osc52-write",
      featureName: "Clipboard write (OSC 52)",
      assertionType: "clipboard",
      exchange: { writes: ["\x1b]52;c;dGVybWluZm8tY2xpcGJvYXJkLXBheWxvYWQ=\x07"] },
    })
    expect(clipModel.truncated).toBe(true)
    expect(clipModel.steps[0]?.fullCode).toContain("dGVybWluZm8")
    expect(clipModel.contextNote).toContain("Long data is shortened with …")
    expect(clipModel.readout?.label).toBe("Clipboard")
    expect(clipModel.readout?.codeMuted).toBe("read directly")
    expect(clipModel.steps[1]?.codeMuted).toBe("no bytes")
    expect(truncateCode("ESC ]52;c;aGVsbG8td29ybGQtdGhpcy1pcy1sb25n BEL").text).toContain("… BEL")

    // Risk #1: deciding query steps are NEVER dropped into Details even behind many writes.
    const manyWrites = buildCardModel({
      status: "supported",
      featureId: "device.decrqss",
      featureName: "DECRQSS",
      assertionType: "query_reply",
      exchange: {
        events: [
          { kind: "write", sequence: "\x1b[1m" },
          { kind: "write", sequence: "\x1b[3m" },
          { kind: "write", sequence: "\x1b[4m" },
          { kind: "write", sequence: "\x1b[7m" },
          { kind: "write", sequence: "\x1b[9m" },
          { kind: "write", sequence: "\x1b[53m" },
          { kind: "query", sequence: "\x1bP$qm\x1b\\", match: ["\x1bP1$r0m\x1b\\"] },
        ],
      },
    })
    expect(manyWrites.steps.some((s) => s.code.includes("$ q m"))).toBe(true)

    // Risk #2: multi-reply unsupported cell omits per-reply mark rather than guessing which reply failed.
    const multiReplyFail = buildCardModel({
      status: "unsupported",
      featureId: "cursor.position-report",
      featureName: "Cursor position report",
      assertionType: "query_reply",
      exchange: {
        events: [
          { kind: "query", sequence: "\x1b[6n", match: ["\x1b[1;1R"] },
          { kind: "query", sequence: "\x1b[6n", match: ["\x1b[1;2R"] },
        ],
      },
    })
    expect(multiReplyFail.readout?.mark).toBeUndefined()

    // v13/v15 Differs: one ← row per setting with its own ✓/✕ mark, never a single ≠ reply row.
    const differsModel = buildCardModel({
      status: "differs-by-context",
      featureId: "input.focus-events",
      featureName: "Focus reporting",
      assertionType: "input_bytes",
      joinedFrom: [
        { context: "Setting on", status: "supported" },
        { context: "Default (off)", status: "unsupported" },
      ],
    })
    expect(differsModel.readouts).toHaveLength(2)
    expect(differsModel.readouts[0]?.mark).toBe("ok")
    expect(differsModel.readouts[1]?.mark).toBe("no")
    expect(differsModel.readouts[1]?.codeMuted).toBe("nothing")

    expect(
      formatWhoLine({ subjectName: "Kitty (lib)", subjectKind: "lib", osName: "Linux", measuredDate: "Nov 20, 2026" }),
    ).toBe("Kitty · library (no window) · Linux · tested Nov 20, 2026")
    expect(shortTerminalName("Kitty (Linux)", "term")).toBe("Kitty")
    expect(vendorExtensionOrigin("extensions.osc776-cell-size")).toBe("rxvt-unicode extension")
    expect(vendorExtensionOrigin("extensions.osc776-cell-size", undefined, "WezTerm")).toBe(
      "rxvt-unicode's command, tested in WezTerm",
    )
    expect(vendorExtensionOrigin("extensions.iterm2-images", undefined, "iTerm2")).toBe("iTerm2 extension")
    expect(vendorExtensionOrigin("sgr.overline")).toBeUndefined()
  })
})

describe("run-trace captures (pixel + real expected frames + text-cells) & check-private-leak capture guard (#38269 item 5)", () => {
  it("emits cropped observed, terminal-grid full, and real expected-frame PNGs for real Kitty 0.49.2 cells and validates trace", () => {
    const runPath = join(contentDir, "probes-apps", "kitty-0.49.2-linux-532e0773c813b92b4fc9f4843759e9dd.json")
    const runRaw = readFileSync(runPath, "utf8")
    const parsedProbeHash = (JSON.parse(runRaw) as { probeHash: string }).probeHash
    const suitePath = join(contentDir, "suites", `${parsedProbeHash}.json`)
    const manifest = parseSuiteManifest(suitePath, readFileSync(suitePath, "utf8"))
    const catalog = manifest.catalogIds!
    const run = parseRun(runPath, runRaw, catalog, new Map([[manifest.probeHash, manifest]]))
    const projection = projectResults([run], catalog, { currentProbeHash: manifest.probeHash, workingRuns: [run] }, [])
    const kittyRun = Object.values(projection.versions).flat()[0]!
    kittyRun.readArtifact = (ref: string) => readVerifiedArtifact(contentDir, ref, runPath, "screenshot")
    const trace = currentTrace(kittyRun)
    expect(trace).toBeDefined()
    const overline = trace!.document.featureResults["sgr.overline"]
    expect(overline?.status).toBe("unsupported")
    expect(overline?.captures?.observed?.url).toMatch(/^\/api\/v3\/captures\/[0-9a-f]{64}\.png$/)
    expect(overline?.captures?.full?.url).toMatch(/^\/api\/v3\/captures\/[0-9a-f]{64}\.png$/)
    expect(overline?.captures?.regionText).toMatch(/^row \d+, (?:column|from column) \d+/)
    expect(trace!.captures.has(overline!.captures!.observed!.url)).toBe(true)
    expect(trace!.captures.has(overline!.captures!.full!.url)).toBe(true)

    // Risk #3: real expected-frame control PNG (NEVER the tiny paint witness!) is cropped into captures.expected.
    const deccara = trace!.document.featureResults["editing.deccara"]
    expect(deccara?.captures?.observed?.url).toMatch(/^\/api\/v3\/captures\/[0-9a-f]{64}\.png$/)
    expect(deccara?.captures?.expected?.url).toMatch(/^\/api\/v3\/captures\/[0-9a-f]{64}\.png$/)
    expect(deccara?.captures?.expected?.width).toBe(deccara?.captures?.observed?.width)
    expect(deccara?.captures?.expected?.height).toBe(deccara?.captures?.observed?.height)
    expect(trace!.captures.has(deccara!.captures!.expected!.url)).toBe(true)

    // Visual-probe step cleanliness: keep actual tested command, strip paint-witness seed/expected & SGR control frames.
    const deccaraCard = buildCardModel({
      status: "supported",
      featureId: "editing.deccara",
      featureName: "DECCARA",
      exchange: { writes: deccara?.writes, queries: deccara?.queries, events: deccara?.events },
      captures: deccara?.captures,
    })
    expect(deccaraCard.steps.some((s) => /inverse \(7\).*DECCARA/i.test(s.words))).toBe(true)
    expect(deccaraCard.steps.some((s) => s.words.includes("cccccX"))).toBe(true)
    expect(deccaraCard.truncated).toBe(false)
    expect(deccaraCard.contextNote).toBeUndefined()
    const overlineCard = buildCardModel({
      status: "unsupported",
      featureId: "sgr.overline",
      featureName: "Overline (SGR 53)",
      exchange: { writes: overline?.writes, queries: overline?.queries, events: overline?.events },
      captures: overline?.captures,
    })
    expect(overlineCard.steps.some((s) => /SGR 99|reverse video/i.test(s.words))).toBe(false)
    expect(overlineCard.steps.some((s) => /overline/i.test(s.words))).toBe(true)
    expect(overlineCard.readout?.code).toBe("ESC P 1 $ r m ESC \\")
    expect(overlineCard.readout?.text).toContain("plain")

    const loaded = readCellTrace(trace!.document, {
      schemaVersion: kittyRun.schemaVersion,
      runId: kittyRun.runId,
      runSha256: kittyRun.sha256,
      featureId: "sgr.overline",
    })
    expect(loaded.cell.captures?.observed?.sha256).toBe(overline!.captures!.observed!.sha256)

    const tampered = structuredClone(trace!.document)
    tampered.featureResults["sgr.overline"]!.captures!.observed!.url = "/artifacts/raw.png"
    expect(() =>
      readCellTrace(tampered, {
        schemaVersion: kittyRun.schemaVersion,
        runId: kittyRun.runId,
        runSha256: kittyRun.sha256,
        featureId: "sgr.overline",
      }),
    ).toThrow("Trace document identity or structure does not match this result")
  })

  it("extracts captured textCells slice for real Terminal.app macOS text-cells frame", () => {
    const runPath = join(contentDir, "probes-apps", "terminal-app-2.15-macos-2438af903918065e2d4588cdfd3f7b72.json")
    const runRaw = readFileSync(runPath, "utf8")
    const parsedProbeHash = (JSON.parse(runRaw) as { probeHash: string }).probeHash
    const suitePath = join(contentDir, "suites", `${parsedProbeHash}.json`)
    const manifest = parseSuiteManifest(suitePath, readFileSync(suitePath, "utf8"))
    const catalog = manifest.catalogIds!
    const run = parseRun(runPath, runRaw, catalog, new Map([[manifest.probeHash, manifest]]))
    const projection = projectResults([run], catalog, { currentProbeHash: manifest.probeHash, workingRuns: [run] }, [])
    const tappRun = Object.values(projection.versions).flat()[0]!
    tappRun.readTextArtifact = (ref: string) => readVerifiedArtifact(contentDir, ref, runPath, "text-snapshot")
    const trace = currentTrace(tappRun)
    const dec = trace?.document.featureResults["charsets.dec-line-drawing"]
    expect(dec?.captures?.textCells).toContain("┘┐┌└")
    expect(dec?.captures?.regionText).toBe("row 1, columns 1–7")
  })

  it("refuses forged or mismatched capture files in dist/api/v3/captures/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "terminfo-cap-leak-"))
    try {
      const capDir = join(tmp, "api", "v3", "captures")
      mkdirSync(capDir, { recursive: true })
      const validPng = encodeRgbaPng(4, 4, Buffer.alloc(64, 128))
      const sha = createHash("sha256").update(validPng).digest("hex")
      writeFileSync(join(capDir, `${sha}.png`), validPng)
      writeFileSync(
        join(tmp, "api", "v3", "evidence-files.json"),
        JSON.stringify({ version: 1, files: [{ path: `api/v3/captures/${sha}.png`, sha256: sha }] }),
      )
      expect(scanDist(tmp)).toEqual([])

      writeFileSync(join(capDir, `${"0".repeat(64)}.png`), validPng)
      const violations = scanDist(tmp)
      expect(violations.some((v) => v.reason.includes("filename digest"))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("createArtifactReader does not retain the parent LoadedRun object", async () => {
    const { createArtifactReader } = await import("../docs/data/selected-results.ts")
    let weakRun: WeakRef<object>
    let reader: (ref: string) => Buffer
    {
      let run: { path: string; payload: Uint8Array } | null = {
        path: "probes-apps/example.json",
        payload: new Uint8Array(1024 * 1024),
      }
      weakRun = new WeakRef(run)
      reader = createArtifactReader(contentDir, run.path, "screenshot")
      run = null
    }
    if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
      for (let i = 0; i < 5 && weakRun.deref() !== undefined; i++) {
        Bun.gc(true)
        await Promise.resolve()
      }
      expect(weakRun.deref()).toBeUndefined()
    }
    expect(typeof reader).toBe("function")
  })
})
