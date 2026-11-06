/**
 * @failure A state cell is graded Unsupported from the library's unhandled-sequence report without
 *   both same-run controls the ruling requires (@cto 2026-11-05 07:25 appendix, Case 1): a handled
 *   sequence must add no entry AND its own reader must show it applied, and the target must add
 *   exactly one entry carrying its code. Without both, the row keeps today's TODO naming what
 *   failed; a missing member keeps today's meaning and never becomes Supported.
 *
 * @failure The report is allowed to decide a delivery cell. OSC 7 / OSC 633 P / OSC 9 / OSC 777
 *   are Supported because their payload reaches the host, so the report must not touch them.
 *
 * @failure The report is allowed to decide an SGR cell outside the six the appendix names.
 * @level l2
 * @consumer 32362 unhandled-sequence consumer: Case 1 of @cto's 2026-11-05 07:25 appendix.
 * @testonly none
 */
import { describe, expect, test } from "vitest"

import { extensionsProbes } from "./extensions.ts"
import { sgrProbes } from "./sgr.ts"
import { ALL_PROBES, isDeclaredUntestable } from "./index.ts"
import { inertLibProbeSource } from "./testing/group-harness.ts"
import type { HeadlessRuntimeIdentity, LibProbeSource, UnhandledSequence } from "./types.ts"

const REASON = "library reported this sequence as unhandled"

const probe = (id: string) => extensionsProbes.find((entry) => entry.id === id)!
const sgr = (id: string) => sgrProbes.find((entry) => entry.id === id)!

/**
 * A library whose `feed` drives the two things the ruling's controls read: OSC 2 sets the title
 * reader, SGR 1 bolds the cell, and every sequence `records` matches is appended to the report in
 * the order it arrived. `records` is array order, so a control entry can be placed either way.
 */
function reportingSource(spec: {
  records?: readonly { readonly match: RegExp; readonly code: UnhandledSequence }[]
  titleApplies?: boolean
  boldApplies?: boolean
}): LibProbeSource {
  const report: UnhandledSequence[] = []
  let title = ""
  let bold = false
  const base = inertLibProbeSource()
  return {
    ...base,
    getUnhandledSequences: () => report.slice(),
    getTitle: () => title,
    getCell: () => ({ ...base.getCell(0, 0), bold }),
    feed: (text) => {
      const titleSet = /\x1b\]2;([^\x07]*)\x07/.exec(text)
      if (titleSet) {
        if (spec.titleApplies !== false) title = titleSet[1] ?? ""
      }
      if (text.includes("\x1b[0m")) bold = false
      if (text.includes("\x1b[1m") && spec.boldApplies !== false) bold = true
      for (const entry of spec.records ?? []) if (entry.match.test(text)) report.push(entry.code)
    },
  }
}

const recordsOsc = (code: string) => ({ match: new RegExp(`\\x1b\\]${code}`), code: { kind: "osc" as const, code } })
const recordsCsi = (code: string) => ({
  match: new RegExp(`\\x1b\\[${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  code: { kind: "csi" as const, code },
})

describe("the unhandled report decides only state cells, and only with both controls", () => {
  test.each([
    ["extensions.osc113-reset-pointer-fg", "113"],
    ["extensions.osc114-reset-pointer-bg", "114"],
    ["extensions.osc117-reset-highlight-bg", "117"],
    ["extensions.osc119-reset-highlight-fg", "119"],
  ])("a colour-reset cell the library reports unhandled becomes Unsupported: %s", (id, code) => {
    const source = reportingSource({ records: [recordsOsc(code)] })
    const result = probe(id).lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("a colour reset outside the four named cells keeps its own path", () => {
    // @cto names the ledger's colour-reset group (113/114/117/119); 104/110/111/112 belong to another
    // card group and must not move here even when the same report carries their number.
    for (const [id, code] of [
      ["extensions.osc104-reset-palette", "104"],
      ["extensions.osc110-reset-fg", "110"],
      ["extensions.osc111-reset-bg", "111"],
      ["extensions.osc112-reset-cursor", "112"],
    ] as const) {
      const source = reportingSource({ records: [recordsOsc(code)] })
      const result = probe(id).lib!(source)
      expect(result.observation?.outcome, id).not.toBe("unsupported")
      expect(JSON.stringify(result), id).not.toContain(REASON)
    }
  })

  test("the two umbrella shell cells reach the report arm too", () => {
    for (const [id, code] of [
      ["extensions.semantic-prompts", "133"],
      ["extensions.osc-633-vscode", "633"],
    ] as const) {
      const source = reportingSource({ records: [recordsOsc(code)] })
      const result = probe(id).lib!(source)
      expect(result.observation?.outcome, id).toBe("unsupported")
      expect(JSON.stringify(result), id).toContain(REASON)
    }
  })

  test("a shell-mark cell the library reports unhandled becomes Unsupported", () => {
    const source = reportingSource({ records: [recordsOsc("133")] })
    const result = probe("extensions.osc133-a").lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("a report without the target's code leaves the cell undecided", () => {
    const source = reportingSource({ records: [recordsOsc("111")] })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a report that also records the handled control leaves the cell undecided", () => {
    const source = reportingSource({ records: [recordsOsc("113"), recordsOsc("2")] })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a control whose own reader does not show it applied leaves the cell undecided", () => {
    const source = reportingSource({ records: [recordsOsc("113")], titleApplies: false })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a missing member keeps today's meaning", () => {
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(inertLibProbeSource())
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a delivery cell is never decided by the report", () => {
    const source = reportingSource({
      records: [recordsOsc("7"), recordsOsc("9"), recordsOsc("633"), recordsOsc("777")],
    })
    for (const id of [
      "extensions.osc7-cwd",
      "extensions.osc9-progress",
      "extensions.osc633-p",
      "extensions.osc777-notify",
    ]) {
      const result = probe(id).lib!(source)
      expect(JSON.stringify(result)).not.toContain(REASON)
    }
  })
})

describe("the SGR arm moves only the named cells, with SGR 1 as its control", () => {
  test.each([
    ["sgr.blink", "5m"],
    ["sgr.strikethrough", "9m"],
    ["sgr.underline.double", "21m"],
    ["sgr.underline.curly", "4:3m"],
    ["sgr.underline.dotted", "4:4m"],
    ["sgr.underline.dashed", "4:5m"],
  ])("%s becomes Unsupported when the library reports %s", (id, code) => {
    const source = reportingSource({ records: [recordsCsi(code)] })
    const result = sgr(id).lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("a report that also records SGR 1 leaves the cell undecided", () => {
    const source = reportingSource({ records: [recordsCsi("5m"), recordsCsi("1m")] })
    const result = sgr("sgr.blink").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a bold reader that never applies leaves the cell undecided", () => {
    const source = reportingSource({ records: [recordsCsi("5m")], boldApplies: false })
    const result = sgr("sgr.blink").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a private intermediate never matches the plain SGR code", () => {
    const source = reportingSource({ records: [recordsCsi("?5m")] })
    const result = sgr("sgr.blink").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })
})

/**
 * @failure Case 2 (@cto plan ruling 09:00, R1): on an engine that handles no OSC, the merged arm's OSC 2
 *   control can never qualify, so the engine's own report can never decide an OSC cell. The fallback may
 *   qualify an OSC target with SGR 1 and bold ONLY in the same run that shows the OSC 2 control added
 *   exactly one entry of kind osc code 2 while the title stayed unapplied, and it must read its own
 *   baseline. Any other shape keeps today's TODO.
 *
 * @failure Case 2 R2: sgr.italic (3m) and sgr.faint (2m) are inside the report arm's cell set, and a cell
 *   outside that set is still never decided by the report.
 *
 * @level l2
 * @consumer @si/terminfo/30211-terminfo-273/32369-dec-non-osc-control-consumer
 * @testonly none
 */
describe("an engine that handles no OSC may qualify with a handled non-OSC control", () => {
  /** An engine with no OSC handling: it reports OSC 2 and the target, never sets the title. */
  const decLike = (codes: readonly string[]) =>
    reportingSource({
      records: [recordsOsc("2"), ...codes.map((code) => recordsOsc(code))],
      titleApplies: false,
    })

  test.each([
    ["extensions.osc133-a", "133"],
    ["extensions.osc133-p", "133"],
    ["extensions.osc633-a", "633"],
    ["extensions.semantic-prompts", "133"],
    ["extensions.osc113-reset-pointer-fg", "113"],
    ["extensions.osc777-notify", "777"],
  ])("a cell the engine reports unhandled becomes Unsupported: %s", (id, code) => {
    const result = probe(id).lib!(decLike([code]))
    // osc777-notify is a delivery cell and must keep its own path even under the fallback.
    if (id === "extensions.osc777-notify") {
      expect(JSON.stringify(result)).not.toContain(REASON)
      return
    }
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("the OSC 2 control that stayed unapplied supplies the report entry the target delta rebases on", () => {
    // Without its own baseline read, the OSC 2 entry would make the target delta two and nothing would
    // fire. The positive case above is this assertion's proof; this one names the shape it depends on.
    const source = decLike(["113"])
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    const parsed = JSON.parse(result.response!) as { unhandled: { control: string } }
    expect(parsed.unhandled.control).toBe("\x1b[0m\x1b[1mC")
  })

  test("an OSC 2 control that adds no entry never reaches the fallback", () => {
    // A handled silent OSC 2 (no entry) proves nothing about the OSC path, so the fallback stays closed.
    const source = reportingSource({ records: [recordsOsc("113")], titleApplies: false })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("an OSC 2 control that adds two entries never reaches the fallback", () => {
    const source = reportingSource({
      records: [recordsOsc("2"), recordsOsc("2"), recordsOsc("113")],
      titleApplies: false,
    })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("a fallback control whose bold reader never applies leaves the cell undecided", () => {
    const source = reportingSource({
      records: [recordsOsc("2"), recordsOsc("113")],
      titleApplies: false,
      boldApplies: false,
    })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })

  test("the fallback never qualifies on an engine whose title reader answered", () => {
    // Case 1 by construction: the OSC 2 control qualifies normally, so the fallback is not consulted
    // and an unrecorded target stays undecided.
    const source = reportingSource({ records: [recordsOsc("2")] })
    const result = probe("extensions.osc113-reset-pointer-fg").lib!(source)
    expect(result.observation?.outcome).not.toBe("unsupported")
    expect(JSON.stringify(result)).not.toContain(REASON)
  })
})

describe("the report arm decides italic and faint as well, and nothing outside its set", () => {
  test.each([
    ["sgr.italic", "3m"],
    ["sgr.faint", "2m"],
  ])("%s becomes Unsupported when the library reports %s", (id, code) => {
    const source = reportingSource({ records: [recordsCsi(code)] })
    const result = sgr(id).lib!(source)
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
  })

  test("an SGR cell outside the eight keeps its own path", () => {
    const source = reportingSource({ records: [recordsCsi("53m"), recordsCsi("1m")] })
    const result = sgr("sgr.overline").lib!(source)
    expect(JSON.stringify(result)).not.toContain(REASON)
  })
})

// Accepted D2 cut (Chief 6ef3debd) plus M-1 (CTO f23f1197): 44 controlled negatives;
// the 12 proposed declarations remain on their prior paths pending policy wording.
// Independent input/code oracles were measured from the real addon before each
// consumer extension; these cases exercise the registered callback boundary.
describe("vt100-rust controlled reports at the ALL_PROBES consumer", () => {
  const identity: HeadlessRuntimeIdentity = {
    kind: "native",
    engineVersion: "0.16.2",
    adapterVersion: "0.10.2",
    termlessRevision: "39f7cd8336b01debdbbe775d1a40900195a7f91e",
    loadedBinary: {
      path: "vendor/termless/packages/vt100-rust/termless-vt100-rust.node",
      sha256: "72855b1d5462ac4c168d6c2f4a6252ab0bbfbd8682bcd68c732521ed1f4e661c",
    },
    provenance: {
      sha256: "72855b1d5462ac4c168d6c2f4a6252ab0bbfbd8682bcd68c732521ed1f4e661c",
      sourceCommit: "3a0bcc0f615cc22d64ea6b756026521d697f0c61",
      buildHash: "1384077ee447681a93471e6ee176b8bbdc4ae172e2f94ab3d7cc1f84a1f674eb",
      toolchain:
        "rustc 1.94.0 (4a4ef493e 2026-03-02) (built from a source tarball); cargo 1.94.0 (85eff7c80 2026-01-15)",
      lockSha256: "4cf037e4efa648ca41d08b30ef5c4ce7ada29ad61fcad45a7d1aa97bf55391c6",
    },
    adapterSources: [
      {
        path: "packages/vt100-rust/src/index.ts",
        blobOid: "3ddb74f3ae1f79bb356952103853232f69211268",
      },
      {
        path: "packages/vt100-rust/src/backend.ts",
        blobOid: "ddabecd4881be4f6b63f1c35f9c2265b53d35df4",
      },
    ],
  }
  const targets = [
    ["cursor.position-report", "\u001b[6n", "csi", "6n"],
    ["device.decrpm", "\u001b[?7$p", "csi", "?$7p"],
    ["device.dsr-996-color-scheme", "\u001b[?996n", "csi", "?996n"],
    ["device.primary-da", "\u001b[c", "csi", "0c"],
    ["device.secondary-da", "\u001b[>c", "csi", ">0c"],
    ["device.status-report", "\u001b[5n", "csi", "5n"],
    ["device.tertiary-da", "\u001b[=c", "csi", "=0c"],
    ["device.xtreportcolors", "\u001b[#R", "csi", "#0R"],
    ["device.xtversion", "\u001b[>0q", "csi", ">0q"],
    ["device.xtwinops-14", "\u001b[14t", "csi", "14t"],
    ["device.xtwinops-16", "\u001b[16t", "csi", "16t"],
    ["device.xtwinops-18", "\u001b[18t", "csi", "18t"],
    ["device.xtwinops-20", "\u001b[20t", "csi", "20t"],
    ["device.xtwinops-21", "\u001b[21t", "csi", "21t"],
    ["editing.decrqcra", "\u001b[1;1;1;1;1;5*y", "csi", "*1;1;1;1;1;5y"],
    ["extensions.sixel-da1", "\u001b[c", "csi", "0c"],
    ["extensions.sixel-geometry-report", "\u001b[?2;1;0S", "csi", "?2;1;0S"],
    ["modes.decsscls", "\u001b[9 p", "csi", " 9p"],
    // M-1 inputs/codes were measured independently on the exact native addon.
    ["modes.alt-scroll-1007", "\u001b[?1007h", "csi", "?1007h"],
    ["modes.color-scheme-reporting", "\u001b[?2031h", "csi", "?2031h"],
    ["modes.decsclm", "\u001b[?4h", "csi", "?4h"],
    ["modes.reverse-video", "\u001b[?5h", "csi", "?5h"],
    ["modes.synchronized-output", "\u001b[?2026h", "csi", "?2026h"],
    ["modes.xtpushcolors", "\u001b[#P", "csi", "#0P"],
    ["modes.xtpopcolors", "\u001b[#Q", "csi", "#0Q"],
    ["modes.xtrestore", "\u001b[?7r", "csi", "?7r"],
    ["modes.xtsave", "\u001b[?7s", "csi", "?7s"],
    ["modes.focus-tracking", "\u001b[?1004h", "csi", "?1004h"],
    ["extensions.osc10-fg-color", "\u001b]10;?\u0007", "osc", "10"],
    ["extensions.osc11-bg-color", "\u001b]11;?\u0007", "osc", "11"],
    ["extensions.osc12-cursor-color", "\u001b]12;?\u0007", "osc", "12"],
    ["extensions.osc1337-capabilities", "\u001b]1337;Capabilities\u0007", "osc", "1337"],
    ["extensions.osc1337-cellsize", "\u001b]1337;ReportCellSize\u0007", "osc", "1337"],
    ["extensions.osc17-highlight-bg", "\u001b]17;?\u0007", "osc", "17"],
    ["extensions.osc19-highlight-fg", "\u001b]19;?\u0007", "osc", "19"],
    ["extensions.osc21-kitty-color", "\u001b]21;foreground=?\u001b\\", "osc", "21"],
    ["extensions.osc4-palette", "\u001b]4;0;?\u0007", "osc", "4"],
    ["extensions.osc5-special-color", "\u001b]5;0;?\u0007", "osc", "5"],
    ["extensions.osc701-locale", "\u001b]701;?\u0007", "osc", "701"],
    ["extensions.osc702-version", "\u001b]702;?\u0007", "osc", "702"],
    ["extensions.osc776-cell-size", "\u001b]776\u0007", "osc", "776"],
    ["extensions.osc7770-font-size", "\u001b]7770;?\u0007", "osc", "7770"],
    ["extensions.osc7777-font-window-size", "\u001b]7777;?\u0007", "osc", "7777"],
    ["extensions.osc99-kitty-notify", "\u001b]99;i=dev4-census:p=?;\u001b\\", "osc", "99"],
  ] as const
  const declared = [
    "device.decrqss",
    "device.xtgettcap",
    "device.xtgetxres",
    "extensions.kitty-graphics",
    "extensions.kitty-graphics.transmit",
    "extensions.osc22-pointer",
    "extensions.osc176-app-id",
    "extensions.osc3008-context",
    "extensions.osc440-audio",
    "extensions.osc555-flash",
    "extensions.osc666-termprop",
    "extensions.osc710-font-normal",
  ] as const
  const definition = (id: string) => ALL_PROBES.find((p) => p.id === id)!
  const source = (feed: string, kind: "osc" | "csi", code: string, overrides: Partial<LibProbeSource> = {}) => ({
    ...reportingSource({
      records: [{ match: new RegExp(feed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), code: { kind, code } }],
    }),
    backendName: "vt100-rust",
    runtimeIdentity: identity,
    ...overrides,
  })

  test.each(targets)("%s uses the measured normalized code with both handled controls", (id, feed, kind, code) => {
    const result = definition(id).lib!(source(feed, kind, code))
    expect(result.observation?.outcome).toBe("unsupported")
    expect(JSON.stringify(result)).toContain(REASON)
    if (kind === "csi") {
      expect(JSON.stringify(result)).toContain("CSI " + code)
      expect(JSON.stringify(result)).not.toContain("SGR " + code)
    }
  })

  // The released twelve-cell D2 slice declares only this audited 0.16.2 subject.
  // Negative-only coverage could not prove the declaration or retain its versioned reason.
  test.each(declared)("%s declares Untestable only for the audited vt100 0.16.2 subject", (id) => {
    const lib = definition(id).lib!
    const result = lib({ ...inertLibProbeSource(), backendName: "vt100-rust", runtimeIdentity: identity })
    expect(isDeclaredUntestable(result)).toBe(true)
    expect(JSON.stringify(result)).toContain("vt100 0.16.2")
    expect(result.observation?.outcome).not.toBe("unsupported")
    for (const overrides of [
      { runtimeIdentity: undefined },
      { backendName: "libvterm" },
      { runtimeIdentity: { ...identity, engineVersion: "0.16.3" } },
      { runtimeIdentity: { ...identity, provenance: { ...identity.provenance, lockSha256: "0".repeat(64) } } },
    ]) {
      expect(
        isDeclaredUntestable(
          lib({ ...inertLibProbeSource(), backendName: "vt100-rust", runtimeIdentity: identity, ...overrides }),
        ),
      ).toBe(false)
    }
  })

  test("failed controls, mismatch, extra entry, missing member and changed identity keep the old path", () => {
    const [id, feed, kind, code] = targets[0]
    const lib = definition(id).lib!
    for (const ctx of [
      source(feed, kind, "other"),
      source(feed, kind, code, { getUnhandledSequences: undefined }),
      source(feed, kind, code, { backendName: "libvterm" }),
      source(feed, kind, code, { runtimeIdentity: { ...identity, engineVersion: "0.16.3" } }),
      source(feed, kind, code, {
        runtimeIdentity: { ...identity, loadedBinary: { ...identity.loadedBinary, sha256: "0".repeat(64) } },
      }),
      source(feed, kind, code, {
        runtimeIdentity: { ...identity, provenance: { ...identity.provenance, sourceCommit: "0".repeat(40) } },
      }),
      source(feed, kind, code, {
        runtimeIdentity: { ...identity, provenance: { ...identity.provenance, lockSha256: "0".repeat(64) } },
      }),
      source(feed, kind, code, {
        runtimeIdentity: {
          ...identity,
          adapterSources: identity.adapterSources?.map((s) => ({ ...s, blobOid: "0".repeat(40) })),
        },
      }),
      {
        ...source(feed, kind, code),
        ...reportingSource({ boldApplies: false, records: [{ match: /\x1b\[6n/, code: { kind, code } }] }),
        backendName: "vt100-rust",
      },
      {
        ...source(feed, kind, code),
        ...reportingSource({
          records: [
            { match: /\x1b\[6n/, code: { kind, code } },
            { match: /\x1b\[6n/, code: { kind, code } },
          ],
        }),
        backendName: "vt100-rust",
      },
    ]) {
      const result = lib(ctx)
      expect(result.observation?.outcome).not.toBe("unsupported")
      expect(JSON.stringify(result)).not.toContain(REASON)
    }
  })

  test("a decided reply survives the report and OSC52 read is neither declared nor negative", () => {
    const target = source("\x1b[6n", "csi", "6n", {
      feedCapture: () => "\x1b[3;5R",
      getCursor: () => ({ x: 4, y: 2, visible: true, style: null }),
    })
    expect(definition("cursor.position-report").lib!(target).observation?.outcome).toBe("supported")
    const result = definition("extensions.osc52-read").lib!(target)
    expect(isDeclaredUntestable(result)).toBe(false)
    expect(JSON.stringify(result)).not.toContain(REASON)
  })
})
