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
  countVerdictWords,
  expectedVisualSpecimen,
  explainReplyCommand,
  shortTerminalName,
  truncateCode,
  vendorExtensionOrigin,
  whoLineParts,
} from "../docs/.vitepress/theme/card-explain.ts"
import { validateMeasuredCard, validateUntestableCard } from "./validate-style5-cards.ts"
import { formatControlBytes, readCellTrace } from "../docs/data/evidence-reader.ts"
import { parseRun, parseSuiteManifest } from "@terminfo/run-parser"
import { projectResults, readVerifiedArtifact } from "../docs/data/selected-results.ts"
import {
  classifyUntestableCause,
  currentTrace,
  extractAppLogLine,
  extractClipboardReadNonce,
} from "../docs/data/run-trace.ts"
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

describe("card-explain Style 5 — all 10 measured kinds + non-measured kinds (#38269, card-style5-rule-0010.md)", () => {
  it("formats DECRQM mouse card (passes: green): drops DA1 fence, Expected/Received reply bytes, 4-word verdict", () => {
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
    expect(model.measured).toBe(true)
    expect(model.steps).toEqual([{ num: 1, code: "ESC [ ?1003 $ p", words: "Ask: do you know mode 1003?" }])
    expect(model.expected).toEqual({
      code: "ESC [ ?1003;1|2 $ y",
      words: "“Yes, on” or “Yes, off”",
    })
    expect(model.received).toEqual({
      code: "ESC [ ?1003;2 $ y",
      words: "“Yes, it is off right now”",
    })
    expect(model.verdict).toEqual({ tone: "ok", text: "Alacritty knows this mode" })
    expect(validateMeasuredCard(model, "decrqm")).toEqual([])
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
      { num: 2, code: "ESC [ c", setup: true, words: "Terminal ID check (always answered)" },
    ])
    expect(model.expected).toEqual({
      code: "ESC ]776;<w>;<h> BEL",
      words: "Cell width and height",
    })
    expect(model.received).toEqual({
      code: "ESC [ ?62;4 c",
      words: "Answered only the terminal ID check",
    })
    expect(model.verdict).toEqual({ tone: "no", text: "Terminal ignored this query" })
    expect(validateMeasuredCard(model, "osc776")).toEqual([])
  })

  it("formats Kitty overline screen+DECRQSS card, pure screenshot cards without fake bytes, and Cut (a) non-SGR card", () => {
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
    // #38757: the screen decides a screenshot row, and Expected/Received describe the screen check the verdict names.
    // #38777: the DECRQSS style read is not part of that result, so it is not a step at all.
    expect(overline.steps).toEqual([{ num: 1, code: "ESC [ 53 m", words: "Turn on overline and draw text" }])
    expect(overline.replyFamily).toBeUndefined()
    expect(overline.expected).toEqual({ words: "Line drawn above the text" })
    expect(overline.received).toEqual({ words: "Plain text with no line above" })
    expect(overline.readout).toEqual({ label: "Reply", text: "“Style: plain”", code: "ESC P 1 $ r m ESC \\" })
    expect(overline.verdict).toEqual({ tone: "no", text: "Overline didn’t stick" })
    expect(validateMeasuredCard(overline, "overline")).toEqual([])
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
    expect(iterm2.expected?.code).toBeUndefined()
    expect(iterm2.received?.code).toBeUndefined()
    expect(iterm2.received?.words).toContain("stayed blank")
    expect(iterm2.verdict).toEqual({ tone: "no", text: "No image was drawn" })
    expect(validateMeasuredCard(iterm2, "iterm2-images")).toEqual([])

    const deccara = buildCardModel({
      status: "unsupported",
      featureId: "editing.deccara",
      featureName: "Change Attributes in Rectangular Area",
      assertionType: "screenshot",
      captures: fakeCap,
      hasExpectedPicture: false,
      expectedSentence: "DECCARA changes SGR attributes inside a rectangular region.",
    })
    expect(deccara.expected).toEqual({ words: "DECCARA changes SGR attributes inside a rectangular region" })
    expect(deccara.received?.code).toBeUndefined()
    expect(deccara.verdict).toEqual({ tone: "no", text: "Screen did not match" })
    expect(validateMeasuredCard(deccara, "deccara")).toEqual([])
  })

  it("formats cursor save/restore, library, process_environment, clipboard, notification, app-log, non-measured kinds, and validator", () => {
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
      { num: 2, code: "ESC [ 10;10 H", setup: true, words: "Move to 10;10" },
      { num: 3, code: "ESC 8", words: "Restore" },
      { num: 4, code: "ESC [ 6 n", words: "Ask where the cursor is" },
    ])
    expect(saveRestore.expected).toEqual({ code: "ESC [ 3;5 R", words: "“At 3;5”" })
    expect(saveRestore.received).toEqual({ code: "ESC [ 3;5 R", words: "“At 3;5”" })
    expect(saveRestore.verdict).toEqual({ tone: "ok", text: "Cursor returned to spot" })
    expect(validateMeasuredCard(saveRestore, "save-restore")).toEqual([])

    // Headless library: NO fake bytes in Expected/Received
    const libModel = buildCardModel({
      status: "supported",
      featureId: "sgr.bold",
      featureName: "Bold (SGR 1)",
      subjectKind: "lib",
      declaredSequence: "ESC [ 1 m",
      parserState: { char: "X", bold: true, fg: null, bg: null },
    })
    expect(libModel.expected?.code).toBeUndefined()
    expect(libModel.received?.code).toBeUndefined()
    expect(libModel.received?.codeMuted).toBeUndefined()
    expect(libModel.received?.words).toContain("bold")
    expect(libModel.verdict).toEqual({ tone: "ok", text: "Parser stored expected state" })
    expect(validateMeasuredCard(libModel, "lib")).toEqual([])

    // Headless library with CPR fence-only reply hides ESC [ 5;11 R fence on non-cursor probes
    const libFenceModel = buildCardModel({
      status: "unsupported",
      featureId: "device.xtversion",
      featureName: "XTVERSION",
      subjectKind: "lib",
      parserState: "\x1b[5;11R\x1b[7;13R",
      traceEvidence: ["The library sent back ESC [ 5;11 R ESC [ 7;13 R."],
    })
    expect(libFenceModel.received?.words).toBe("No reply (answered only the cursor fence)")
    expect(validateMeasuredCard(libFenceModel, "lib-fence", { featureId: "device.xtversion" })).toEqual([])

    // Process environment: NO fake bytes, verdict does not repeat Received verbatim (Rule 9)
    const envModel = buildCardModel({
      status: "unsupported",
      featureId: "device.term-features",
      featureName: "TERM_FEATURES",
      assertionType: "process_environment",
      traceEvidence: ["TERM_FEATURES was not set."],
    })
    expect(envModel.steps).toEqual([{ num: 1, code: "", codeMuted: "no bytes", words: "Read TERM_FEATURES at launch" }])
    expect(envModel.expected).toEqual({ words: "TERM_FEATURES environment variable set" })
    expect(envModel.received).toEqual({ words: "TERM_FEATURES was not set" })
    expect(envModel.verdict).toEqual({ tone: "no", text: "Not set" })
    expect(
      validateMeasuredCard(envModel, "env", {
        featureId: "device.term-features",
        assertionType: "process_environment",
      }),
    ).toEqual([])

    // #38699: the OSC 7577 token card reads OSC7577_TOKEN, never TERM_FEATURES, and never parses a value out of
    // its evidence text: set, not set, or set but not a valid token.
    const tokenCard = (status: "supported" | "unsupported", evidence: string) =>
      buildCardModel({
        status,
        featureId: "extensions.osc7577-token",
        featureName: "OSC 7577 program resume token",
        assertionType: "process_environment",
        traceEvidence: [evidence],
      })
    const absentToken = tokenCard("unsupported", "OSC7577_TOKEN was not set in the environment it gave the test.")
    expect(absentToken.steps).toEqual([
      { num: 1, code: "", codeMuted: "no bytes", words: "Read OSC7577_TOKEN at launch" },
    ])
    expect(absentToken.expected).toEqual({ words: "OSC7577_TOKEN environment variable set" })
    expect(absentToken.received).toEqual({ words: "OSC7577_TOKEN was not set" })
    const setToken = tokenCard(
      "supported",
      "it set OSC7577_TOKEN to a value we don't show (38 bytes, not text the test sent)",
    )
    expect(setToken.received).toEqual({ words: "OSC7577_TOKEN was set" })
    const badToken = tokenCard(
      "unsupported",
      "it set OSC7577_TOKEN to a value we don't show (10 bytes, not text the test sent)",
    )
    expect(badToken.received).toEqual({ words: "OSC7577_TOKEN was set, but not as a valid token" })
    for (const model of [absentToken, setToken, badToken]) {
      expect(JSON.stringify(model)).not.toContain("TERM_FEATURES")
      expect(
        validateMeasuredCard(model, "osc7577-token", {
          featureId: "extensions.osc7577-token",
          assertionType: "process_environment",
        }),
      ).toEqual([])
    }

    // Clipboard write with trailing CPR sync barrier (Rule 1): strips ESC [ 6 n, shows real clipboard read-back nonce
    const clipNonce = "terminfo-osc52-b676ab94-02be-42f1-abf2-0c7b78d082ed"
    const clipB64 = Buffer.from(clipNonce, "utf8").toString("base64")
    const clipModel = buildCardModel({
      status: "supported",
      featureId: "extensions.osc52-write",
      featureName: "Clipboard write (OSC 52)",
      assertionType: "clipboard",
      clipboardRead: clipNonce,
      traceEvidence: ["The terminal sent back ESC [ 1;1 R."],
      exchange: {
        events: [
          { kind: "write", sequence: `\x1b]52;c;${clipB64}\x07` },
          { kind: "query", sequence: "\x1b[6n", match: ["\x1b[1;1R"] },
        ],
      },
    })
    expect(clipModel.truncated).toBe(true)
    expect(clipModel.steps.some((s) => s.code.includes("6 n"))).toBe(false)
    expect(clipModel.steps[0]?.fullCode).toContain("dGVybWluZm8")
    expect(clipModel.expected).toEqual({ words: "Clipboard holds the test text" })
    expect(clipModel.received?.code).toBeUndefined()
    expect(clipModel.received?.words).toMatch(/^Clipboard: terminfo-osc52-/)
    expect(clipModel.received?.words).not.toContain("1;1 R")
    expect(clipModel.verdict).toEqual({ tone: "ok", text: "Clipboard received the text" })
    expect(
      validateMeasuredCard(clipModel, "clipboard", { featureId: "extensions.osc52-write", assertionType: "clipboard" }),
    ).toEqual([])
    expect(extractClipboardReadNonce([{ observed: clipNonce }], [`\x1b]52;c;${clipB64}\x07`])).toBe(clipNonce)
    expect(
      extractClipboardReadNonce([{ observed: "user secret clipboard" }], [`\x1b]52;c;${clipB64}\x07`]),
    ).toBeUndefined()
    expect(truncateCode("ESC ]52;c;aGVsbG8td29ybGQtdGhpcy1pcy1sb25n BEL").text).toContain("… BEL")
    expect(truncateCode("ESC [ 200 ~ terminfo-paste-e6f64d7b-2756-44f2-82f9-f2fbabd1720d ESC [ 201 ~").text).toMatch(
      /^ESC \[ 200 ~ terminfo-paste-.*… ESC \[ 201 ~$/,
    )

    // Semicolon-less OSC 776 query still produces exact expected reply bytes
    const osc776NoSemi = buildCardModel({
      status: "unsupported",
      featureId: "extensions.osc776-cell-size",
      featureName: "Cell size report (OSC 776)",
      assertionType: "query_reply",
      exchange: {
        events: [
          { kind: "query", sequence: "\x1b]776\x07", match: null },
          { kind: "query", sequence: "\x1b[c", match: ["\x1b[?62;4c"] },
        ],
      },
    })
    expect(osc776NoSemi.expected).toEqual({ code: "ESC ]776;<w>;<h> BEL", words: "Cell width and height" })
    expect(validateMeasuredCard(osc776NoSemi, "osc776-no-semi")).toEqual([])

    // #38743: OSC 7501 detection query card says "all five states" when states is absent and "all three kinds" when kinds is absent,
    // and the silent row renders its cursor read without throwing.
    const osc7501Full = buildCardModel({
      status: "supported",
      featureId: "extensions.osc7501-query",
      featureName: "Program status detection query (OSC 7501)",
      assertionType: "query_reply",
      declaredSequence: "ESC ] 7501 ; ? ST, then CSI c",
      exchange: {
        events: [
          {
            kind: "write",
            sequence:
              "\x1b]7501;state=working:id=terminfo-osc7501-nonce:title=dGVybWluZm8tb3NjNzUwMS1ub25jZQ==:msg=dGVybWluZm8tb3NjNzUwMS1ub25jZQ==\x1b\\",
          },
          { kind: "query", sequence: "\x1b]7501;?\x1b\\\x1b[c", match: ["\x1b]7501;?\x1b\\"] },
        ],
      },
    })
    expect(osc7501Full.received?.words).toContain("all five states")
    expect(osc7501Full.received?.words).toContain("all three kinds")
    expect(
      validateMeasuredCard(osc7501Full, "osc7501-full", {
        featureId: "extensions.osc7501-query",
        assertionType: "query_reply",
      }),
    ).toEqual([])

    const osc7501Subset = buildCardModel({
      status: "supported",
      featureId: "extensions.osc7501-query",
      featureName: "Program status detection query (OSC 7501)",
      assertionType: "query_reply",
      declaredSequence: "ESC ] 7501 ; ? ST, then CSI c",
      exchange: {
        events: [
          {
            kind: "query",
            sequence: "\x1b]7501;?\x1b\\\x1b[c",
            match: ["\x1b]7501;?:states=working,done,error:kinds=permission\x1b\\"],
          },
        ],
      },
    })
    expect(osc7501Subset.received?.words).toContain("states: working, done, error")
    expect(osc7501Subset.received?.words).toContain("kinds: permission")
    expect(
      validateMeasuredCard(osc7501Subset, "osc7501-subset", {
        featureId: "extensions.osc7501-query",
        assertionType: "query_reply",
      }),
    ).toEqual([])

    const osc7501Silent = buildCardModel({
      status: "supported",
      featureId: "extensions.osc7501-silent",
      featureName: "Program status reports print nothing (OSC 7501)",
      assertionType: "buffer_state",
      declaredSequence: "ESC ] 7501 ; state=… ST",
      traceEvidence: [
        "Printed two letters, which moved the cursor to row 1 col 3; then sent each OSC 7501 program-status report form, 4 reports in all.",
        "None of them moved the cursor, so none was shown on screen.",
      ],
    })
    expect(osc7501Silent.received?.words).toBe("None of them moved the cursor, so none was shown on screen")
    expect(
      validateMeasuredCard(osc7501Silent, "osc7501-silent", {
        featureId: "extensions.osc7501-silent",
        assertionType: "buffer_state",
      }),
    ).toEqual([])
    expect(vendorExtensionOrigin("extensions.osc7501-query", ["osc"])).toBeUndefined()
    expect(vendorExtensionOrigin("extensions.osc7501-silent", ["osc"])).toBeUndefined()

    // Rule 2: Pixel mouse 1016 (FAIL) explains cells vs pixels, puts 14t/16t/18t replies on setup rows, never in Received
    const pixelMouseFail = buildCardModel({
      status: "unsupported",
      featureId: "input.pixel-mouse",
      featureName: "SGR-Pixels Mouse Mode (1016)",
      assertionType: "input_bytes",
      traceEvidence: [
        "The terminal sent back 4 replies: ESC [<0;45;15M, ESC [ 4;588;792 t, ESC [ 8;28;88 t, ESC [<0;45;15M.",
      ],
      exchange: {
        events: [
          { kind: "write", sequence: "\x1b[?1000h\x1b[?1006h" },
          { kind: "query", sequence: "", match: ["\x1b[<0;45;15M"] },
          { kind: "query", sequence: "\x1b[16t\x1b[c", match: null },
          { kind: "query", sequence: "\x1b[14t\x1b[c", match: ["\x1b[4;588;792t"] },
          { kind: "query", sequence: "\x1b[18t\x1b[c", match: ["\x1b[8;28;88t"] },
          { kind: "write", sequence: "\x1b[?1016h" },
          { kind: "query", sequence: "", match: ["\x1b[<0;45;15M"] },
          { kind: "write", sequence: "\x1b[?1016l" },
        ],
      },
    })
    expect(pixelMouseFail.replyFamily).toBe(true)
    expect(pixelMouseFail.expected).toEqual({ code: "ESC [ <0;<x>;<y> M", words: "Mouse position in pixels" })
    expect(pixelMouseFail.received).toEqual({
      code: "ESC [<0;45;15M",
      words: "Position in cells (45,15), not pixels",
    })
    expect(pixelMouseFail.verdict).toEqual({ tone: "no", text: "Sent cell coords, not pixels" })
    expect(pixelMouseFail.steps.some((s) => s.setup && s.words.includes("792×588 px"))).toBe(true)
    expect(
      validateMeasuredCard(pixelMouseFail, "pixel-mouse-fail", {
        featureId: "input.pixel-mouse",
        assertionType: "input_bytes",
      }),
    ).toEqual([])

    // Rule 3: Bracketed paste shows ONLY the wrapped paste in bytes | words columns; setup DECRQM stays on setup row
    const pasteModel = buildCardModel({
      status: "supported",
      featureId: "extensions.clipboard-paste",
      featureName: "System clipboard paste",
      assertionType: "input_bytes",
      traceEvidence: [
        "The terminal sent back 6 replies: ESC [ ?2004;2 $ y, a, terminfo-paste-e6f64d7b-2756-44f2-82f9-f2fbabd1720d, ESC [ 200 ~ terminfo-paste-e6f64d7b-2756-44f2-82f9-f2fbabd1720d ESC [ 201 ~ and 2 more.",
      ],
      exchange: {
        events: [
          { kind: "query", sequence: "\x1b[?2004$p\x1b[c", match: ["\x1b[?2004;2$y"] },
          { kind: "query", sequence: "", match: ["a"] },
          { kind: "write", sequence: "\x1b[?2004l" },
          { kind: "query", sequence: "", match: ["terminfo-paste-e6f64d7b-2756-44f2-82f9-f2fbabd1720d"] },
          { kind: "write", sequence: "\x1b[?2004h" },
          {
            kind: "query",
            sequence: "",
            match: ["\x1b[200~terminfo-paste-e6f64d7b-2756-44f2-82f9-f2fbabd1720d\x1b[201~"],
          },
          { kind: "write", sequence: "\x1b[?2004l" },
          { kind: "query", sequence: "\x1b[?2004$p\x1b[c", match: ["\x1b[?2004;2$y"] },
        ],
      },
    })
    expect(pasteModel.replyFamily).toBe(true)
    expect(pasteModel.expected).toEqual({
      code: "ESC [ 200~ … ESC [ 201~",
      words: "Paste wrapped in the markers",
    })
    expect(pasteModel.received?.code).toMatch(/^ESC \[ 200~ terminfo.*… ESC \[ 201~$/)
    expect(pasteModel.received?.words).toBe("Paste wrapped in the markers")
    expect(pasteModel.steps.some((s) => s.setup && s.words.includes("off right now"))).toBe(true)
    expect(
      validateMeasuredCard(pasteModel, "input-paste", {
        featureId: "extensions.clipboard-paste",
        assertionType: "input_bytes",
      }),
    ).toEqual([])

    // Rule 4: App-log report (Kitty OSC 440): specific Expected ("Kitty plays the sound; no log line"), verbatim log Received
    const osc440Model = buildCardModel({
      status: "unsupported",
      featureId: "extensions.osc440-audio",
      featureName: "Audio bell (OSC 440)",
      shortSubjectName: "Kitty",
      assertionType: "buffer_state",
      logLine: "[PARSE ERROR] Ignoring OSC 440 used for audio by mintty",
      exchange: {
        events: [
          { kind: "write", sequence: "\x1b[1;1H\x1b[2K" },
          { kind: "write", sequence: "\x1b]440;bell.wav\x07" },
          { kind: "query", sequence: "\x1b[6n", match: ["\x1b[1;1R"] },
          { kind: "write", sequence: "\x1b]7654;8164fbbb\x07\x1b]7655;8164fbbb-0\x07" },
          { kind: "write", sequence: "\x1b]2;Q-8164fbbb\x07\x1b]7655;8164fbbb-1\x07" },
          { kind: "write", sequence: "\x1b]440;bell.wav\x07\x1b]7655;8164fbbb-2\x07" },
          { kind: "write", sequence: "\x1b]2;bun\x07" },
        ],
      },
    })
    expect(osc440Model.steps).toEqual([{ num: 1, code: "ESC ]440;bell.wav BEL", words: "Play audio bell (OSC 440)" }])
    expect(osc440Model.expected).toEqual({ words: "Kitty plays the sound; no log line" })
    expect(osc440Model.received).toEqual({
      words: "[PARSE ERROR] Ignoring OSC 440 used for audio by mintty",
      isLog: true,
    })
    expect(osc440Model.verdict).toEqual({ tone: "no", text: "Kitty ignored OSC 440" })
    expect(validateMeasuredCard(osc440Model, "osc440")).toEqual([])

    // Rule 5: DEC Line Drawing (Terminal.app): shows glyphs in Expected and observed text in Received, NEVER method prose
    const decLineModel = buildCardModel({
      status: "supported",
      featureId: "charsets.dec-line-drawing",
      featureName: "DEC Line Drawing",
      assertionType: "buffer_state",
      traceEvidence: [
        "Read row 1, columns 1–7 as text from the terminal's own text snapshot, not from its pixels.",
        "Those cells matched the expected result.",
      ],
      captures: { textCells: "┘┐┌└─│j", regionText: "row 1, columns 1–7" },
    })
    expect(decLineModel.expected).toEqual({ words: "Line-drawing glyphs: ┘┐┌└─│" })
    expect(decLineModel.received).toEqual({ words: "Row 1 shows ┘┐┌└─│ (plus ASCII “j” after reset)" })
    expect(expectedVisualSpecimen("charsets.dec-line-drawing")).toMatchObject({
      text: "┘┐┌└─│j",
      caption: "Box glyphs ┘┐┌└─│, then ASCII j after reset",
    })
    expect(
      validateMeasuredCard(decLineModel, "dec-line", {
        featureId: "charsets.dec-line-drawing",
        assertionType: "buffer_state",
      }),
    ).toEqual([])

    // Rule 6: Window title collapses calibration/control/negative/restore writes to one real step
    // and phrases Received as a result rather than method prose (#38585).
    const titleModel = buildCardModel({
      status: "supported",
      featureId: "extensions.osc2-title",
      featureName: "Window Title (OSC 2)",
      assertionType: "buffer_state",
      traceEvidence: ["Set the window title 4 times and read it back each time: 4 of 4 readings matched."],
      exchange: {
        events: [
          { kind: "write", sequence: "\x1b]2;terminfo-title-control-A\x07" },
          { kind: "write", sequence: "\x1b]2;terminfo-title-control-B\x07" },
          { kind: "write", sequence: "\x1b]2;terminfo-title-target-A\x07" },
          { kind: "write", sequence: "\x1b]2;terminfo-title-target-B\x07" },
          { kind: "write", sequence: "\x1b]7654;terminfo-title-negative\x07" },
          { kind: "write", sequence: "\x1b]2;Alacritty\x07" },
        ],
      },
    })
    expect(titleModel.steps).toHaveLength(1)
    expect(titleModel.steps[0]?.code).toContain("terminfo-title-target-A")
    expect(titleModel.steps[0]?.words).toBe("Set window title")
    expect(titleModel.received).toEqual({ words: "Window title matched 4 of 4 test titles" })
    expect(validateMeasuredCard(titleModel, "osc2-title")).toEqual([])

    // #38585 item 4: OSC 440 catalog "How this is tested" prose matches the log-based card.
    const features = JSON.parse(readFileSync(join(contentDir, "features.json"), "utf8")) as Record<
      string,
      { probe?: string }
    >
    expect(features["extensions.osc440-audio"]?.probe).toContain("unhandled")
    expect(features["extensions.osc440-audio"]?.probe).not.toContain("ask for the cursor position")

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
    expect(validateMeasuredCard(manyWrites, "decrqss")).toEqual([])

    // Rule 7: Non-measured Untestable cards MUST explain why; generic or missing reason FAILS validateUntestableCard
    const untestable = buildCardModel({
      status: "untestable",
      featureId: "extensions.osc555-flash",
      featureName: "Flash",
      untestableCause: classifyUntestableCause("extensions.osc555-flash", "term"),
    })
    expect(untestable.measured).toBe(false)
    expect(untestable.expected).toBeUndefined()
    expect(untestable.verdict).toBeUndefined()
    expect(untestable.closing).toBe("A screen flash lasts ~100 ms; our screenshots can’t catch it. Not a no.")
    expect(validateUntestableCard(untestable, "osc555-untestable")).toEqual([])

    const untestableMissingReason = buildCardModel({
      status: "untestable",
      featureId: "unknown.custom-feature",
      featureName: "Unknown",
    })
    expect(validateUntestableCard(untestableMissingReason, "untestable-empty").length).toBeGreaterThanOrEqual(1)
    expect(
      validateUntestableCard(
        {
          measured: false,
          steps: [],
          readouts: [],
          closing: "Could not be tested automatically here. Not a no.",
          truncated: false,
        },
        "untestable-generic",
      ).length,
    ).toBeGreaterThanOrEqual(1)

    const derived = buildCardModel({
      status: "unsupported",
      featureId: "sgr.underline.curly",
      featureName: "Curly underline",
      derived: true,
    })
    expect(derived.measured).toBe(false)
    expect(derived.expected).toBeUndefined()

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
    expect(differsModel.measured).toBe(false)
    expect(differsModel.expected).toBeUndefined()
    expect(differsModel.closing).toContain("Setting on: supported")
    expect(differsModel.closing).toContain("Default (off): unsupported")

    // Rule 8 build-check validator rejects: missing fields, bad verdict word count, internal text,
    // reply-family spanning sentence, fence/setup leaks, method prose, and duplicate verdict text
    expect(
      validateMeasuredCard(
        {
          measured: true,
          replyFamily: true,
          steps: [],
          expected: { words: "Read row 1 from the terminal's own text snapshot" },
          received: { words: "The terminal sent back ESC [ 1;1 R (PROBE TODO)" },
          verdict: { tone: "no", text: "Fail" },
          readouts: [],
          closing: "Fail",
          truncated: false,
        },
        "bad-card",
        { featureId: "extensions.osc52-write", assertionType: "input_bytes" },
      ).length,
    ).toBeGreaterThanOrEqual(6)
    expect(
      validateMeasuredCard(
        {
          measured: true,
          replyFamily: true,
          steps: [],
          expected: { code: "ESC [ <0;360;240 M", words: "Mouse position in pixels" },
          received: { code: "ESC [ 4;588;792 t", words: "window size" },
          verdict: { tone: "no", text: "window size" },
          readouts: [],
          closing: "window size",
          truncated: false,
        },
        "bad-setup-leak",
        { featureId: "input.pixel-mouse", assertionType: "input_bytes" },
      ).length,
    ).toBeGreaterThanOrEqual(2)
    expect(countVerdictWords("Overline didn’t stick")).toBe(3)

    expect(
      whoLineParts({ subjectName: "Kitty (lib)", subjectKind: "lib", osName: "Linux", measuredDate: "Nov 20, 2026" }),
    ).toEqual({ name: "Kitty", osName: "Linux", details: ["library (no window)", "tested Nov 20, 2026"] })
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
    expect(overlineCard.verdict).toEqual({ tone: "no", text: "Overline didn’t stick" })

    // Real Kitty 0.49.2 OSC 440 app-log line extracted verbatim into trace (no 7655 fence, no host paths)
    const osc440 = trace!.document.featureResults["extensions.osc440-audio"]
    expect(osc440?.logLine).toBe("[PARSE ERROR] Ignoring OSC 440 used for audio by mintty")
    const osc440Card = buildCardModel({
      status: "unsupported",
      featureId: "extensions.osc440-audio",
      featureName: "Audio bell (OSC 440)",
      shortSubjectName: "Kitty",
      assertionType: osc440?.assertionType,
      logLine: osc440?.logLine,
      exchange: { writes: osc440?.writes, queries: osc440?.queries, events: osc440?.events },
    })
    expect(osc440Card.steps).toEqual([{ num: 1, code: "ESC ]440;bell.wav BEL", words: "Play audio bell (OSC 440)" }])
    expect(osc440Card.received).toEqual({
      words: "[PARSE ERROR] Ignoring OSC 440 used for audio by mintty",
      isLog: true,
    })
    expect(osc440Card.verdict).toEqual({ tone: "no", text: "Kitty ignored OSC 440" })
    expect(validateMeasuredCard(osc440Card, "real-kitty-osc440")).toEqual([])
    expect(
      extractAppLogLine(
        [
          {
            observed: JSON.stringify({
              reader: "report",
              detail: {
                phases: [
                  {
                    name: "target",
                    appended: "/nix/store/abc/bin/kitty\n[90.1] [PARSE ERROR] Unknown OSC escape code: 7655;nonce\n",
                  },
                ],
              },
            }),
          },
        ],
        "extensions.osc440-audio",
      ),
    ).toBeUndefined()

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

/**
 * #38757: operator review of the Ghostty 1.4.0 Linux result cards (2.7.4 preview). Every card here is built from the
 * real recorded run the preview selected for that context (measured 2026-11-25), through the same trace projection
 * the page uses, so a regression in the card rules shows up against the evidence the operator actually read.
 */
describe("card-explain #38757 — true send order, named SGR replies, context queries (real Ghostty 1.4.0 Linux run)", () => {
  const ghosttyRunFile = "ghostty-1.4.0-linux-ae8dfd2fdc04b5aae4ddbf220049a4c3.json"
  const ghosttyCells = (() => {
    let cached: ReturnType<typeof currentTrace> | undefined
    return () => {
      if (cached) return cached
      const runPath = join(contentDir, "probes-apps", ghosttyRunFile)
      const runRaw = readFileSync(runPath, "utf8")
      const parsedProbeHash = (JSON.parse(runRaw) as { probeHash: string }).probeHash
      const suitePath = join(contentDir, "suites", `${parsedProbeHash}.json`)
      const manifest = parseSuiteManifest(suitePath, readFileSync(suitePath, "utf8"))
      const catalog = manifest.catalogIds!
      const run = parseRun(runPath, runRaw, catalog, new Map([[manifest.probeHash, manifest]]))
      const projection = projectResults(
        [run],
        catalog,
        { currentProbeHash: manifest.probeHash, workingRuns: [run] },
        [],
      )
      const ghostty = Object.values(projection.versions).flat()[0]!
      ghostty.readArtifact = (ref: string) => readVerifiedArtifact(contentDir, ref, runPath, "screenshot")
      cached = currentTrace(ghostty)
      expect(cached).toBeDefined()
      return cached
    }
  })()
  const ghosttyCard = (featureId: string, featureName: string) => {
    const cell = ghosttyCells()!.document.featureResults[featureId]
    expect(cell?.status).toBe("unsupported")
    return buildCardModel({
      status: "unsupported",
      featureId,
      featureName,
      shortSubjectName: "Ghostty",
      subjectKind: "term",
      assertionType: cell?.assertionType,
      traceEvidence: cell?.evidence,
      exchange: { writes: cell?.writes, queries: cell?.queries, events: cell?.events },
      captures: cell?.captures,
      hasExpectedPicture: Boolean(cell?.captures?.expected),
    })
  }

  // Finding 2: the recorded events are plain a, ESC =, KP_Add -> "+", ESC >, KP_Add -> "+". The restore went out
  // after the decisive key press, so the card must not show it before "Send test key press".
  it("keypad (DECKPAM): a mode restore after the decisive key press is teardown, never a grey setup row before it", () => {
    const events = ghosttyCells()!.document.featureResults["modes.application-keypad"]!.events!
    expect(events.map((e) => `${e.kind}:${e.sequence || e.match?.[0]}`)).toEqual([
      "query:a",
      "write:\x1b=",
      "query:+",
      "write:\x1b>",
      "query:+",
    ])
    const card = ghosttyCard("modes.application-keypad", "Application keypad (DECKPAM)")
    expect(card.steps).toEqual([
      { num: 1, code: "ESC =", words: "Turn on application keypad" },
      { num: 2, code: "", codeMuted: "no bytes", words: "Send test key press" },
    ])
    expect(card.received).toMatchObject({ code: "+", words: "Plain text “+”" })
    expect(validateMeasuredCard(card, "ghostty-keypad", { assertionType: "input_bytes" })).toEqual([])
  })

  // Finding 3: DECRQSS 0;5 means "reset, then blink" — blink is on. The row is decided by the screen (no blink seen in
  // 16 samples), so the reply is context and the card names the screen check as the one that failed.
  it("blink (SGR 5): names the DECRQSS reply's SGR parameters and says the screen check failed", () => {
    expect(explainReplyCommand("\x1bP1$r0;5m\x1b\\").words).toBe("“Style: blink (after a reset)”")
    expect(explainReplyCommand("\x1bP1$r5m\x1b\\").words).toBe("“Style: blink”")
    expect(explainReplyCommand("\x1bP1$r1;4:3m\x1b\\").words).toBe("“Style: bold, curly underline”")
    expect(explainReplyCommand("\x1bP1$r0;38;5;196m\x1b\\").words).toBe("“Style: text color 196 (after a reset)”")
    expect(explainReplyCommand("\x1bP1$r0m\x1b\\").words).toBe("“Style: plain”")

    const card = ghosttyCard("sgr.blink", "Blink (SGR 5)")
    const all = JSON.stringify(card)
    expect(all).not.toContain("0;5m”")
    // #38777: the style read does not decide a screenshot row, so it is not a step beside the screen check.
    expect(card.steps).toEqual([{ num: 1, code: "ESC [ 5 m", words: "Turn on blink and draw text" }])
    expect(card.replyFamily).toBeUndefined()
    expect(card.expected).toEqual({ words: "Text blinks on and off" })
    expect(card.received).toEqual({ words: "Screen cells never changed between samples (no blink)" })
    expect(card.verdict).toEqual({ tone: "no", text: "Screen did not match" })
    expect(validateMeasuredCard(card, "ghostty-blink", { featureId: "sgr.blink" })).toEqual([])
  })

  // Finding 5: DECSSCLS. The probe (packages/probe-defs/src/modes.ts DECSSCLS_JUMP / DECSSCLS_SLOW) runs a jump-scroll
  // control with CSI 9 SP p, then the target at 9 lines per second with CSI 0 SP p; the DECRQM ?4 read only records
  // the smooth-scroll mode to restore. The write under test is never hidden and the context query is styled as context.
  it("DECSSCLS: lists the scroll-speed write under test, drops the mode-4 question, says what the frames show", () => {
    expect(formatControlBytes("\x1b[0 p")).toBe("ESC [ 0 SP p")
    const card = ghosttyCard("modes.decsscls", "DECSSCLS — set scroll speed")
    const codes = card.steps.map((s) => s.code)
    expect(codes).not.toContain("CR")
    expect(codes).not.toContain("LF")
    // #38777: the mode-4 question does not decide the screenshot row, so it is not shown.
    expect(card.steps.find((s) => s.code === "ESC [ ?4 $ p")).toBeUndefined()
    const underTest = card.steps.find((s) => s.code === "ESC [ 0 SP p")
    expect(underTest).toEqual(expect.objectContaining({ words: "Set scroll speed: 9 lines per second (DECSSCLS 0)" }))
    expect(underTest?.setup).toBeUndefined()
    expect(card.steps.find((s) => s.code === "ESC [ 9 SP p")).toMatchObject({
      words: "Set scroll speed: jump (DECSSCLS 9)",
    })
    expect(codes.indexOf("ESC [ 9 SP p")).toBeLessThan(codes.indexOf("ESC [ 0 SP p"))
    expect(card.replyFamily).toBeUndefined()
    expect(card.expected?.words).toBe("Red marker still moving at the first check")
    expect(card.received?.words).toBe(
      "The content was already settled after 876 ms, inside the 3889 ms throttled window",
    )
    expect(card.verdict).toEqual({ tone: "no", text: "Screen did not match" })
    expect(validateMeasuredCard(card, "ghostty-decsscls", { featureId: "modes.decsscls" })).toEqual([])
  })
})

/**
 * #38777: the all-states card sweep (seven card-builder patterns, 1,421 audited cards). Every card here is built from a
 * real recorded run in content/, through the page's own projection (parseRun → projectResults → currentTrace) and the
 * feature's features.json metadata, the way ResultEvidenceCell.vue builds it.
 */
describe("card-explain #38777 — command under test, deciding values, library state, true reasons (real recorded runs)", () => {
  const features = JSON.parse(readFileSync(join(contentDir, "features.json"), "utf8")) as Record<
    string,
    { name?: string; sequence?: string }
  >
  const traces = new Map<string, NonNullable<ReturnType<typeof currentTrace>>>()
  const traceOf = (runRel: string) => {
    const known = traces.get(runRel)
    if (known) return known
    const runPath = join(contentDir, runRel)
    const runRaw = readFileSync(runPath, "utf8")
    const probeHash = (JSON.parse(runRaw) as { probeHash: string }).probeHash
    const suitePath = join(contentDir, "suites", `${probeHash}.json`)
    const manifest = parseSuiteManifest(suitePath, readFileSync(suitePath, "utf8"))
    const catalog = manifest.catalogIds!
    const run = parseRun(runPath, runRaw, catalog, new Map([[manifest.probeHash, manifest]]))
    const projection = projectResults([run], catalog, { currentProbeHash: manifest.probeHash, workingRuns: [run] }, [])
    const version = Object.values(projection.versions).flat()[0]!
    version.readArtifact = (ref: string) => readVerifiedArtifact(contentDir, ref, runPath, "screenshot")
    const trace = currentTrace(version)
    expect(trace).toBeDefined()
    traces.set(runRel, trace!)
    return trace!
  }
  const cardFor = (runRel: string, featureId: string, subjectKind: "term" | "lib" = "term") => {
    const cell = traceOf(runRel).document.featureResults[featureId]
    expect(cell).toBeDefined()
    const status = cell!.status as "supported" | "unsupported" | "untestable"
    return {
      cell: cell!,
      card: buildCardModel({
        status,
        featureId,
        featureName: features[featureId]?.name ?? featureId,
        shortSubjectName: "Test",
        subjectKind,
        assertionType: cell!.assertionType,
        declaredSequence: features[featureId]?.sequence,
        untestableCause: cell!.untestableCause,
        traceEvidence: cell!.evidence,
        exchange: cell!,
        parserState: cell!.parserState,
        captures: cell!.captures,
        hasExpectedPicture: Boolean(cell!.captures?.expected),
      }),
    }
  }
  const ALACRITTY = "probes-apps/alacritty-0.17.0-linux-e6e3df432db03bf7c07ff1d769a27e89.json"

  // Pattern 1. xterm 411's sgr.reset run paints numbered calibration frames; SGR 0 is sent in a late frame. The card
  // used to narrow to the first frame window and show only ESC 7 / ESC 8.
  it("1: always shows the command under test (SGR 0), never only the first calibration frame", () => {
    const { card } = cardFor("probes-apps/xterm-411-linux-9905a004f5250013a413d73fb7e5011a.json", "sgr.reset")
    const reset = card.steps.find((s) => s.code === "ESC [ 0 m")
    expect(reset).toEqual(expect.objectContaining({ words: "Reset text style" }))
    expect(reset?.setup).toBeUndefined()
    expect(card.steps.map((s) => s.code)).not.toEqual(["ESC 7", "ESC 8"])
    expect(card.steps.every((s) => s === reset || s.setup)).toBe(true)
    expect(validateMeasuredCard(card, "xterm-sgr-reset", { featureId: "sgr.reset" })).toEqual([])
  })

  // Pattern 1, harness write. DECTCEM hide is written on its own, like the collector's scaffolding hide.
  it("1: a harness-shaped write that is the command under test (ESC [ ?25 l on cursor.hide) is shown, not grey", () => {
    const { card } = cardFor(
      "probes-apps/wezterm-0-unstable-2026-11-20-linux-186b73311b6bc9ab7ef95bad6b055ac1.json",
      "cursor.hide",
    )
    expect(card.steps.at(-1)).toEqual({ num: card.steps.length, code: "ESC [ ?25 l", words: "Turn off visible cursor" })
    expect(card.steps.slice(0, -1).every((s) => s.setup)).toBe(true)
  })

  // Patterns 2 and 5. Alacritty 0.17 sgr.bg.256 is graded by the screen; the DECRQSS style read is context, and the
  // captured "expected" frame is SGR 48;5;67 painted a second time.
  it("2 + 5: screenshot row drops the style question; Expected names and pictures the requested color, not the repaint", () => {
    const { card, cell } = cardFor(ALACRITTY, "sgr.bg.256")
    expect(cell.captures?.expected?.sha256).toBe(cell.captures?.observed?.sha256)
    expect(card.steps.some((s) => /^Ask\b/.test(s.words))).toBe(false)
    expect(card.steps).toEqual([
      { num: 1, code: "ESC [ 3;3 H", setup: true, words: "Move to 3;3" },
      { num: 2, code: "ESC [ 48;5;67 m", words: "Set 256-color background and draw text" },
    ])
    expect(card.replyFamily).toBeUndefined()
    expect(card.expected).toEqual({ words: "Background color: palette color 67 (#5f87af)" })
    expect(card.expectedPicture).toMatchObject({ style: { background: "#5f87af" } })
    expect(card.received?.words).toBe("Screen cells matched the expected result")
    expect(validateMeasuredCard(card, "alacritty-bg256", { featureId: "sgr.bg.256" })).toEqual([])
  })

  // Pattern 3. vterm.js 0.10.1 DECERA stores a before/after grid; libvterm-family kitty 0.51.1 reports OSC 633 unhandled.
  it("3: library cards show the stored state value, or the library's own unhandled report", () => {
    const decera = cardFor(
      "probes-libs/vterm-0.10.1-linux-a83eee05-fe66-4ab9-913d-d08d16a74bc8.json",
      "editing.decera",
      "lib",
    ).card
    expect(decera.received).toEqual({ words: "Before “aaaaaZ”, after “Z”" })
    const osc633 = cardFor(
      "probes-libs/kitty-0.51.1-linux-cfb43019-776e-4ce6-b17c-99c8fc10b109.json",
      "extensions.osc-633-vscode",
      "lib",
    ).card
    expect(osc633.received).toEqual({ words: "The library reported OSC 633 as unhandled" })
    expect(osc633.steps).toEqual([
      { num: 1, code: "ESC ]633;A BEL", words: "Feed to the library: Send VS Code shell mark" },
    ])
    for (const card of [decera, osc633]) {
      expect(JSON.stringify(card)).not.toContain("State recorded in parser buffer")
      expect(JSON.stringify(card)).not.toContain("no bytes")
    }
  })

  // Pattern 4. Ghostty 1.4.0 Linux CPL: 6;10, CSI 2 F, read. The deciding read is 4;1.
  it("4: Expected prints the deciding cursor position, and Received is the read that decides it", () => {
    const { card } = cardFor("probes-apps/ghostty-1.4.0-linux-ae8dfd2fdc04b5aae4ddbf220049a4c3.json", "cursor.cpl")
    expect(card.expected).toEqual({ code: "ESC [ 4;1 R", words: "“At 4;1”" })
    expect(card.received).toEqual({ code: "ESC [ 4;1 R", words: "“At 4;1”" })
    expect(card.steps.find((s) => s.code === "ESC [ 2 F")?.setup).toBeUndefined()
    expect(card.steps.filter((s) => s.code === "ESC [ 6 n").map((s) => s.words)).toEqual([
      "Ask where the cursor is → “At 1;1”",
      "Ask where the cursor is → “At 6;10”",
      "Ask where the cursor is",
    ])
    expect(JSON.stringify(card)).not.toContain("<row>")
    expect(validateMeasuredCard(card, "ghostty-cpl", { featureId: "cursor.cpl" })).toEqual([])
  })

  // Pattern 6. Alacritty never answered the OSC 13 starting-color query; no color was set.
  it("6: an Untestable reason is true: the unanswered starting-color query, not 'setting the base color did not take effect'", () => {
    const { card, cell } = cardFor(ALACRITTY, "extensions.osc113-reset-pointer-fg")
    expect(cell.untestableCause).toBe("prereq-color-setup-absent")
    expect(card.measured).toBe(false)
    expect(card.closing).toContain("This terminal did not answer the OSC 13 color query")
    expect(card.closing).not.toContain("Setting the base color")
    expect(validateUntestableCard(card, "alacritty-osc113")).toEqual([])
  })

  // Pattern 7 and the @dev/15 reword: evidence sentences say what was observed, in reader words.
  it("7: no internal jargon; screen method sentences say the observed outcome", () => {
    const push = cardFor(ALACRITTY, "modes.xtpushcolors").card
    expect(push.received?.words).toBe(
      "Screen cells looked the same as when the command is ignored, not like the expected result",
    )
    expect(push.steps.some((s) => /^\d$/.test(s.code))).toBe(false)
    expect(cardFor(ALACRITTY, "extensions.font-ligatures").card.received?.words).toBe(
      "Ligature cells matched isolated single-character controls",
    )
    expect(cardFor(ALACRITTY, "extensions.osc22-pointer").card.received?.words).toBe(
      "Pointer cursor matched the baseline after OSC 22",
    )
    for (const id of ["modes.xtpushcolors", "extensions.font-ligatures", "extensions.osc22-pointer"]) {
      expect(JSON.stringify(cardFor(ALACRITTY, id).card)).not.toMatch(/ignored-command control|^Compared the/)
    }
  })
})
