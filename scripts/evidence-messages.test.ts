/**
 * @failure A served Unsupported card words its evidence wrongly for its stored record: a placeholder, a sentence
 *   that is not its evidence kind template, or a value outside its feature declared shapes (#37341).
 * @level l2
 * @consumer docs/data/evidence-messages.ts, read through currentTrace, readCellTrace and describeTracePanes (the
 *   evidence pane of a card)
 * @reach fs-walk vendor/terminfo.dev/content/probes-apps/*.json vendor/terminfo.dev/content/probes-libs/*.json
 * @testonly none
 *
 * #37341: every served Unsupported card words its evidence in one or two plain sentences built from the
 * record's own values, from one module (docs/data/evidence-messages.ts; @cto b8e68da0, 0e2bbcf6).
 *
 * Every case here goes through the real producer and reader: a stored run record from content/ ->
 * currentTrace -> the trace bytes -> readCellTrace -> describeTracePanes, which is what the card prints.
 * Cases that need a value the corpus does not hold change one field of a real record and say which.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { runTraceFacts } from "@terminfo/run-parser"
import { describeTracePanes, readCellTrace } from "../docs/data/evidence-reader.ts"
import { currentTrace } from "../docs/data/run-trace.ts"
import type { CurrentSelectedVersion } from "../docs/data/selected-results.ts"

const CONTENT = join(import.meta.dirname, "../content")
const hash = (text: string) => createHash("sha256").update(text).digest("hex")

/** The card text every served cell used to fall back to; none may appear on a card again. */
const PLACEHOLDERS = [
  "Input bytes were not stored by this run",
  "Observed bytes not reviewed for publication",
  "Not kept:",
  "presentation not reviewed",
  "Recorded details have not been approved for publication.",
  "no trace stored for this cell",
  "Original evidence not reviewed for presentation",
  "no typed observation retained",
]

type RawRecord = {
  runId: string
  subject: { kind: string; os: string | null }
  results: Array<{
    featureId: string
    status: string
    reason?: string
    tests?: Array<{ status: string; reason?: string }>
  }>
  rawReplies: Record<string, string>
  [key: string]: unknown
}

function storedRun(dir: string, runId: string, edit?: (raw: RawRecord) => void) {
  const name = readdirSync(join(CONTENT, dir)).find((file) => file.endsWith(`-${runId}.json`))
  if (!name) throw new Error(`no stored run ${runId} in content/${dir}`)
  const bytes = readFileSync(join(CONTENT, dir, name), "utf8")
  const raw = JSON.parse(bytes) as RawRecord
  edit?.(raw)
  const version = {
    schemaVersion: 4,
    source: raw.source,
    runId: raw.runId,
    sha256: hash(bytes),
    subject: raw.subject,
    measuredAt: raw.measuredAt,
    sourceRevision: raw.sourceRevision,
    results: raw.results,
    readRaw: () => runTraceFacts(raw),
  } as unknown as CurrentSelectedVersion
  return { raw, version }
}

/** What the card prints for one stored result. */
function card(dir: string, runId: string, featureId: string, edit?: (raw: RawRecord) => void) {
  const { raw, version } = storedRun(dir, runId, edit)
  const trace = currentTrace(version)
  if (!trace) throw new Error(`run ${runId}: no trace`)
  const loaded = readCellTrace(JSON.parse(trace.bytes), {
    schemaVersion: 4,
    runId,
    runSha256: trace.document.runSha256,
    featureId,
    expectedSha256: trace.sha256,
    actualSha256: hash(trace.bytes),
  })
  const panes = describeTracePanes(loaded, { subjectKind: raw.subject.kind })
  const observed = panes.tested.items.find((item) => item.label === "Observed")
  return {
    raw,
    trace,
    cell: trace.document.featureResults[featureId]!,
    panes,
    observed: observed?.text,
    pre: observed?.pre,
  }
}

/** Change one stored JSON value of a real record (the exchange, a callback) in place. */
function editJson(raw: RawRecord, key: string, change: (value: Record<string, any>) => void) {
  const value = JSON.parse(raw.rawReplies[key]!) as Record<string, any>
  change(value)
  raw.rawReplies[key] = JSON.stringify(value)
}

/** Set one stored query's reply, in both the query list and the ordered events. */
function setReply(raw: RawRecord, key: string, index: number, match: string[]) {
  editJson(raw, key, (exchange) => {
    const query = exchange.queries[index]
    Object.assign(query, { match, reason: "reply" })
    const event = exchange.events?.filter((e: { kind: string }) => e.kind === "query")[index]
    if (event) Object.assign(event, { match, reason: "reply" })
  })
}

const KITTY = "865b253b5b4e5c2db50ca74ede4d9c45" // Kitty 0.49.2, Linux
const ALACRITTY = "730f063abacdd82c88b8b8c312f6f38d" // Alacritty 0.17.0, Linux
const TERMINAL_APP = "2438af903918065e2d4588cdfd3f7b72" // Terminal.app 2.15, macOS
const CMUX = "fc2a046eceaef0d264cb6c823cac555f" // cmux, macOS
const XTERM = "524cbe6f4f80add55354810f35fd57c7" // xterm 411, Linux
const ALACRITTY_CLIPBOARD = "d588d3c3204e4e3e71deba2176aaf361" // Alacritty, Linux
const KITTY_NOTIFY = "0f6a17be820e41ecf3404199ff00fbb7" // Kitty 0.49.2, Linux
const ALACRITTY_LIB = "30aa57b2-f889-4188-85f1-6ebab56568a2" // alacritty_terminal 0.26.0 library

describe("one real record per evidence kind (#37341)", () => {
  const table: Array<[kind: string, dir: string, runId: string, featureId: string, sentences: string]> = [
    ["byte reply", "probes-apps", KITTY, "modes.decsclm", "The terminal sent back ESC [ ?4;0 $ y."],
    [
      "no reply (device-check fence)",
      "probes-apps",
      KITTY,
      "device.tertiary-da",
      "No reply came back to the query. The terminal did answer the device check sent after it, and nothing else came within 250 ms.",
    ],
    [
      "environment read",
      "probes-apps",
      KITTY,
      "device.term-features",
      "The terminal was started fresh for this run, and TERM_FEATURES was not set in the environment it gave the test.",
    ],
    [
      "screen read",
      "probes-apps",
      KITTY,
      "editing.deccra",
      "Compared rows 1–6, columns 1–14 of the screen with the expected result. Those cells did not change.",
    ],
    [
      "text readback",
      "probes-apps",
      TERMINAL_APP,
      "editing.deccra",
      "Read rows 1–6, columns 1–14 as text from the terminal's own text snapshot, not from its pixels. Those cells did not change.",
    ],
    [
      "app-state read (app log)",
      "probes-apps",
      KITTY,
      "extensions.osc-633-vscode",
      "Read the app's own log of commands it does not handle. It listed OSC 633, and it also listed a made-up command we sent to compare.",
    ],
    [
      "app-state read (window title)",
      "probes-apps",
      KITTY,
      "extensions.osc2-title",
      'Set the window title 4 times and read it back each time: 4 of 4 readings matched. A made-up command then left it at "terminfo-title-target-B".',
    ],
    [
      "notification",
      "probes-apps",
      ALACRITTY,
      "extensions.notifications",
      'Sent a desktop notification with the text "terminfo-notify-743f7003-fa40-4761-b9f5-21685cc1a2ac". No notification with that text reached the desktop within 1000 ms.',
    ],
    [
      "untestable",
      "probes-apps",
      KITTY,
      "extensions.osc133-b",
      "This terminal could not be tested for this feature, so nothing was sent.",
    ],
    ["library state", "probes-libs", ALACRITTY_LIB, "device.tertiary-da", "The library sent back ESC [ ?6 c."],
  ]

  test.each(table)("%s: content/%s run %s, feature %s", (_kind, dir, runId, featureId, sentences) => {
    const { observed, panes } = card(dir, runId, featureId)
    expect(observed).toBe(sentences)
    for (const placeholder of PLACEHOLDERS) expect(panes.tested.text).not.toContain(placeholder)
  })

  test("XTVERSION reads its reply from the stored device.xtversion.trace exchange", () => {
    expect(card("probes-apps", KITTY, "device.xtversion").observed).toBe("The terminal sent back kitty(0.49.2).")
  })

  test("a live terminal's app-state read is not a headless parser: no parser-state pane, no input-bytes line", () => {
    const { panes, pre } = card("probes-apps", KITTY, "extensions.osc-633-vscode")
    expect(pre).toBeUndefined()
    expect(panes.tested.text).not.toContain("parser state")
  })

  test("a colour read whose frame equals plain text says so, not that it matched (Terminal.app sgr.underline.color)", () => {
    expect(card("probes-apps", TERMINAL_APP, "sgr.underline.color").observed).toBe(
      "Compared row 3, columns 3–6 of the screen with the expected result. Those cells looked the same as plain text with no attribute set.",
    )
  })

  test("a Windows text read names the console host's buffer (the Terminal.app record with its os set to windows)", () => {
    const edited = card("probes-apps", TERMINAL_APP, "editing.deccra", (raw) => {
      raw.subject.os = "windows"
    })
    expect(edited.observed).toBe(
      "Read rows 1–6, columns 1–14 as text from the console host's buffer, not from its pixels. Those cells did not change.",
    )
  })

  test("nested capture & fixture screen reads report the compared region and concrete mismatch (#37631)", () => {
    expect(card("probes-apps", KITTY, "sgr.overline").observed).toBe(
      "Compared row 3, columns 3–33 of the screen with the expected result. Those cells looked the same as plain text with no attribute set.",
    )
    expect(card("probes-apps", KITTY, "modes.xtpopsgr").observed).toBe(
      "Compared row 3, column 4 of the screen with the expected result. Those cells matched the ignored-command control rather than the expected result.",
    )
    expect(card("probes-apps", KITTY, "modes.decsscls").observed).toMatch(
      /^Checked row \d+ of the screen during a throttled scroll\. The content was already settled after \d+ ms, inside the \d+ ms throttled window\.$/,
    )
  })

  test("cursor save/restore replies say what the replies prove (#37631)", () => {
    expect(card("probes-apps", KITTY, "cursor.save-restore").observed).toBe(
      "Cursor saved at 3;5, moved to 10;10, restored: back at 3;5.",
    )
    expect(card("probes-apps", KITTY, "cursor.ansi-save").observed).toBe(
      "Cursor saved at 3;5, moved to 10;15, restored: back at 3;5.",
    )
  })

  test("headless reflow trace strips undecided probe-todo subchecks while keeping decided state (#37631)", () => {
    const reflow = card("probes-libs", "da6c3113-6bfb-4dbe-a765-b405c4d70090", "extensions.reflow")
    expect(reflow.trace.bytes).not.toMatch(/"probe-(?:todo|invalid|conflict)"/)
    expect(reflow.trace.bytes).toContain("main-grow")
    expect(reflow.trace.bytes).toContain("history-grow")
  })
})

describe("the Kitty Linux TERM_FEATURES card (#37341)", () => {
  test("says Kitty was started fresh and TERM_FEATURES was not set, and never shows its pid or tty", () => {
    const { observed, trace, cell, panes } = card("probes-apps", KITTY, "device.term-features")
    expect(observed).toBe(
      "The terminal was started fresh for this run, and TERM_FEATURES was not set in the environment it gave the test.",
    )
    // The probe sends no bytes, so the card has no Sent or Query line (operator via @cpo/term 961cbe05).
    expect(panes.tested.items.map((item) => item.label)).toEqual(["Observed"])
    const published = JSON.stringify(cell)
    for (const secret of ['"pid"', "165", "tty_nr", "launchMarker"]) expect(published).not.toContain(secret)
    expect(trace.bytes).not.toContain("tty_nr=34817")
  })
})

describe("what a card may show: positive per-feature shapes (@cto 0e2bbcf6)", () => {
  const described = (bytes: number) => `a value we don't show (${bytes} bytes, not text the test sent)`

  test("XTVERSION: a name and version is shown; anything else is described", () => {
    expect(card("probes-apps", CMUX, "device.xtversion").observed).toBe(
      "The terminal sent back ghostty 1.3.2-HEAD-+cb1ef70.",
    )
    const path = "\x1bP>|/Users/someone/bin/ghostty\x1b\\"
    const edited = card("probes-apps", CMUX, "device.xtversion", (raw) =>
      setReply(raw, "device.xtversion.trace", 0, [path]),
    )
    expect(edited.observed).toBe(`The terminal sent back ${described(path.length)}.`)
    expect(edited.trace.bytes).not.toContain("/Users/someone")
  })

  test("XTGETTCAP: the capability name and value are shown; a path value is described", () => {
    expect(card("probes-apps", CMUX, "device.xtgettcap").observed).toBe("The terminal sent back TN=xterm-ghostty.")
    const hex = (text: string) => Buffer.from(text, "latin1").toString("hex").toUpperCase()
    const reply = `\x1bP1+r${hex("TN")}=${hex("/usr/share/terminfo")}\x1b\\`
    const edited = card("probes-apps", CMUX, "device.xtgettcap", (raw) => setReply(raw, "device.xtgettcap", 0, [reply]))
    expect(edited.observed).toBe(`The terminal sent back ${described(reply.length)}.`)
  })

  test("XTGETXRES: the resource name and value are shown, never a path", () => {
    expect(card("probes-apps", XTERM, "device.xtgetxres").observed).toBe("The terminal sent back termName (not set).")
    const hex = (text: string) => Buffer.from(text, "latin1").toString("hex").toUpperCase()
    const reply = `\x1bP1+R${hex("termName")}=${hex("/home/someone/.Xresources")}\x1b\\`
    const edited = card("probes-apps", XTERM, "device.xtgetxres", (raw) =>
      setReply(raw, "device.xtgetxres", 0, [reply]),
    )
    expect(edited.observed).toBe(`The terminal sent back ${described(reply.length)}.`)
    expect(edited.trace.bytes).not.toContain(hex("/home/someone/.Xresources"))
  })

  test("OSC 52: our own nonce is shown; any other clipboard value is described", () => {
    const own = card("probes-apps", ALACRITTY_CLIPBOARD, "extensions.osc52-clipboard")
    expect(own.observed).toContain("terminfo-osc52-71e2164d-e467-4d29-81dc-09efd34b5e73")
    const theirs = `\x1b]52;c;${Buffer.from("someone's clipboard").toString("base64")}\x07`
    const edited = card("probes-apps", ALACRITTY_CLIPBOARD, "extensions.osc52-clipboard", (raw) =>
      editJson(raw, "extensions.osc52-clipboard", (exchange) => {
        const index = exchange.queries.findIndex((q: { match?: string[] }) => q.match?.[0]?.startsWith("\x1b]52"))
        exchange.queries[index].match = [theirs]
        delete exchange.events
      }),
    )
    expect(edited.observed).toContain(described(theirs.length))
    expect(edited.trace.bytes).not.toContain(Buffer.from("someone's clipboard").toString("base64"))
  })

  test("Kitty graphics: an OK acknowledgement is shown; error text is described", () => {
    expect(card("probes-apps", CMUX, "extensions.kitty-graphics").observed).toBe(
      "The terminal sent back ESC _Gi=31;OK ESC \\.",
    )
    const reply = "\x1b_Gi=31;ENOENT:/tmp/someone.png\x1b\\"
    const edited = card("probes-apps", CMUX, "extensions.kitty-graphics", (raw) =>
      editJson(raw, "extensions.kitty-graphics", (exchange) => {
        const index = exchange.queries.findIndex((q: { match?: string[] | null }) => q.match)
        exchange.queries[index].match = [reply]
        delete exchange.events
      }),
    )
    expect(edited.observed).toContain(described(reply.length))
  })

  test("a paste: our own clipboard nonce is shown; other pasted text is described", () => {
    const own = card("probes-apps", ALACRITTY, "extensions.clipboard-paste")
    expect(own.observed).toContain("terminfo-paste-e6f64d7b-2756-44f2-82f9-f2fbabd1720d")
    const pasted = "\x1b[200~someone's password\x1b[201~"
    const edited = card("probes-apps", ALACRITTY, "extensions.clipboard-paste", (raw) =>
      editJson(raw, "extensions.clipboard-paste", (exchange) => {
        for (const query of exchange.queries) if (query.match?.[0]?.includes("terminfo-paste-")) query.match = [pasted]
        delete exchange.events
      }),
    )
    expect(edited.observed).not.toContain("password")
    expect(edited.observed).toContain(described(pasted.length))
  })

  test("OSC 99: a capability report naming the id the test sent is shown; another id is described", () => {
    const own = card("probes-apps", KITTY_NOTIFY, "extensions.osc99-kitty-notify")
    expect(own.observed).toMatch(/^The terminal sent back ESC \]99;i=2a75fc9a-8057-4b90-bacf-3997cfd752e9:p=\?;/)
    const reply = "\x1b]99;i=00000000-0000-0000-0000-000000000000:p=?;a=focus\x1b\\"
    const edited = card("probes-apps", KITTY_NOTIFY, "extensions.osc99-kitty-notify", (raw) =>
      setReply(raw, "extensions.osc99-kitty-notify", 0, [reply]),
    )
    expect(edited.observed).toBe(`The terminal sent back ${described(reply.length)}.`)
  })

  test("a window-title report: the title the test set is shown; any other title is described", () => {
    const own = card("probes-apps", ALACRITTY, "device.xtwinops-21", (raw) =>
      setReply(raw, "device.xtwinops-21", 0, ["\x1b]ltest-title\x1b\\", "test-title"]),
    )
    expect(own.observed).toBe("The terminal sent back ESC ]ltest-title ESC \\.")
    const theirs = card("probes-apps", ALACRITTY, "device.xtwinops-21", (raw) =>
      setReply(raw, "device.xtwinops-21", 0, ["\x1b]lsomeone@laptop: ~/secret\x1b\\", "someone@laptop: ~/secret"]),
    )
    expect(theirs.observed).toBe(`The terminal sent back ${described("\x1b]lsomeone@laptop: ~/secret\x1b\\".length)}.`)
    expect(theirs.trace.bytes).not.toContain("someone@laptop")
  })

  test("a control reply: a numeric report is shown; free text after it is described", () => {
    const edited = card("probes-apps", KITTY, "modes.decsclm", (raw) =>
      setReply(raw, "modes.decsclm", 0, ["\x1b[?4;0$yhello world"]),
    )
    expect(edited.observed).toBe(`The terminal sent back ${described("\x1b[?4;0$yhello world".length)}.`)
    expect(edited.trace.bytes).not.toContain("hello world")
  })

  test("app-state reads: a title the test wrote is shown, an empty one is named, any other title is described", () => {
    const set = (negative: string) => (raw: RawRecord) =>
      editJson(raw, "extensions.osc2-title.callbackResponse", (callback) => {
        callback.negative = negative
      })
    expect(card("probes-apps", KITTY, "extensions.osc2-title", set("")).observed).toContain(
      "A made-up command then left it empty.",
    )
    expect(card("probes-apps", KITTY, "extensions.osc2-title", set("someone@laptop")).observed).toContain(
      `A made-up command then left it at ${described("someone@laptop".length)}.`,
    )
  })

  test("the reverse-wrap step table keeps its measured cursor reports; other live observations are not published", () => {
    const steps = card("probes-apps", ALACRITTY, "cursor.reverse-wrap").cell
    expect(steps.assertions.some((assertion) => assertion.observed?.includes('"measured"'))).toBe(true)
    const title = card("probes-apps", KITTY, "extensions.osc2-title").cell
    expect(title.assertions.every((assertion) => assertion.observed === undefined)).toBe(true)
  })

  // extensions.osc2-title declares no reply shape: its Kitty record is a decided title read that stores an exchange
  // with writes and no query, so a query with a reply is added to it.
  test("a reply on a feature that declares no reply shape fails the build, naming the probe and the kind", () => {
    expect(() =>
      card("probes-apps", KITTY, "extensions.osc2-title", (raw) =>
        editJson(raw, "extensions.osc2-title", (exchange) => {
          exchange.queries = [{ sequence: "\x1b[c", reason: "reply", match: ["\x1b[?62c"] }]
          delete exchange.events
        }),
      ),
    ).toThrow(`evidence for extensions.osc2-title (kind byte-reply) in run ${KITTY}`)
  })
})

describe("no fallback text: a missing field or an unknown kind fails the build (#37341)", () => {
  test("an environment read without its present field names the probe id and the kind", () => {
    expect(() =>
      card("probes-apps", KITTY, "device.term-features", (raw) =>
        editJson(raw, "device.term-features.callbackResponse", (callback) => {
          delete callback.present
        }),
      ),
    ).toThrow(`evidence for device.term-features (kind environment) in run ${KITTY}`)
  })

  test("a notification without its deadline names the probe id and the kind", () => {
    expect(() =>
      card("probes-apps", ALACRITTY, "extensions.notifications", (raw) =>
        editJson(raw, "extensions.notifications.callbackResponse", (callback) => {
          delete callback.deadlineMs
        }),
      ),
    ).toThrow(`evidence for extensions.notifications (kind notification) in run ${ALACRITTY}`)
  })

  test("a decided result that matches no evidence kind names the probe id", () => {
    expect(() =>
      card("probes-apps", KITTY, "modes.decsclm", (raw) =>
        editJson(raw, "modes.decsclm", (exchange) => {
          exchange.queries = []
          exchange.events = []
        }),
      ),
    ).toThrow(`evidence for modes.decsclm (kind none) in run ${KITTY}`)
  })

  test("a kind outside the closed set names the probe id and the kind", async () => {
    const { evidenceSentences } = await import("../docs/data/evidence-messages.ts")
    expect(() => evidenceSentences("modes.decsclm", { kind: "smell" } as never)).toThrow(
      "evidence for modes.decsclm (kind smell): unknown evidence kind",
    )
  })
})

describe("a public card never reads an undecided test's reason (#37341)", () => {
  test("no card in a run with PROBE TODO and PROBE INVALID results prints those reasons", () => {
    const { raw, version } = storedRun("probes-apps", ALACRITTY)
    const trace = currentTrace(version)!
    const undecided = raw.results.flatMap((result) => [
      ...(result.status === "probe-todo" || result.status === "probe-invalid" ? [result.reason] : []),
      ...(result.tests ?? [])
        .filter((t) => t.status === "probe-todo" || t.status === "probe-invalid")
        .map((t) => t.reason),
    ])
    const reasons = undecided.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
    expect(reasons.length).toBeGreaterThan(0)
    for (const featureId of Object.keys(trace.document.featureResults)) {
      const loaded = readCellTrace(JSON.parse(trace.bytes), {
        schemaVersion: 4,
        runId: ALACRITTY,
        runSha256: trace.document.runSha256,
        featureId,
        expectedSha256: trace.sha256,
        actualSha256: hash(trace.bytes),
      })
      const text = describeTracePanes(loaded, { subjectKind: "term" }).tested.text
      for (const reason of reasons) expect(text).not.toContain(reason)
    }
  })
})
