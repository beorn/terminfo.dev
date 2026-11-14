import { finalizeCollectedDraft } from "../../terminfo.dev/src/capture-writer.ts"
/**
 * @failure A broken framed comparison is hidden as pending review, or an explicitly required unstarted review becomes FAILURE/support.
 * @level l1
 * @consumer Native/headless execution recording and pre-seal finalizer
 * @testonly none
 */
import { expect, it } from "vitest"
import { ALL_PROBES, resolveProbeIds } from "./index.ts"
import {
  sgrCaptureFrames,
  recordExecutedProbe,
  finalizeProbeResult,
  replyFailure,
  methodUnavailable,
  decrpmResult,
  unmeasuredCellResult,
  withReplyFailureEvidence,
  recordCollectionFailure,
  initializeRunDraft,
  utf8DecodingRefusal,
  sgrProbe,
  readCollectorSelection,
  readCollectorAttempt,
  recordCollectorSelection,
  recordCollectorAttempt,
  parserStateResult,
  NO_SAME_PATH_CONTROL,
} from "./helpers.ts"
import { extensionsProbes } from "./extensions.ts"
import { deviceProbes } from "./device.ts"
import { modesProbes } from "./modes.ts"
import { resetProbes } from "./reset.ts"
import { sgrProbes, finalizeVisualResult } from "./sgr.ts"
import { unicodeProbes } from "./unicode.ts"
import { editingProbes } from "./editing.ts"
import { textProbes } from "./text.ts"
import { cropPositionRefusal } from "./region-readback.ts"
import type {
  CollectorAttempt,
  LibProbeSource,
  NotTestedCoverageResult,
  ObservationFrame,
  ProbeCallbackResult,
  ProbeResult,
  TermProbeSource,
} from "./types.ts"
const attempt = { scope: "probe" as const, startedAt: "2026-10-21T05:00:00.000Z" }

it("demotes only the selected mux pixel test while preserving query, library and own-frame boundaries", () => {
  const frame: ObservationFrame = { role: "target", ref: "own-pixels.png", capturedAt: 1, label: "Own pixels" }
  for (const [featureId, criterionBranch, testId] of [
    ["sgr.bold", "sgr-attribute-same-run", "attribute"],
    ["cursor.shape", "cursor-shape-same-run", "review"],
    ["extensions.sixel", "sixel-advertised-unchanged", "criterion"],
    ["reset.sgr", "reset-saved-rendition", "reset"],
  ] as const) {
    for (const status of ["supported", "unsupported"] as const) {
      const recorded = finalizeProbeResult({
        featureId,
        criterionBranch,
        assertionType: "screenshot",
        attempt,
        reason: "Row-specific deciding observation",
        screenshotRef: frame.ref,
        tests: [
          { id: "capture", status: "supported", attempt, assertionRefs: [0] },
          { id: testId, status, attempt, assertionRefs: [1] },
        ],
      })
      expect(finalizeVisualResult(recorded, { kind: "term" }, [frame])).toEqual(recorded)
      expect(finalizeVisualResult(recorded, { kind: "lib" }, [])).toEqual(recorded)
      for (const captures of [[], [{ ...frame, ref: "foreign-pixels.png" }]]) {
        expect(finalizeVisualResult(recorded, { kind: "mux" }, captures).status).toBe("probe-todo")
      }
      for (const outerTerminal of ["Kitty", null]) {
        const target = { kind: "mux" as const, outerTerminal }
        const result = finalizeVisualResult(recorded, target, [frame])
        if (status === "supported") expect(result).toEqual(recorded)
        else {
          expect(result.status).toBe("probe-todo")
          expect(result.reason).toContain(outerTerminal ?? "Missing outer terminal identity")
          expect(result.reason).toContain(recorded.reason)
          expect(result.tests[0]).toEqual(recorded.tests[0])
          expect(result.tests[1]).toMatchObject({ id: testId, status: "probe-todo", assertionRefs: [] })
          expect(result.screenshotRef).toBe(frame.ref)
        }
      }
      if (featureId !== "sgr.bold") {
        const untagged = { ...recorded, criterionBranch: undefined }
        expect(finalizeVisualResult(untagged, { kind: "mux" }, [frame])).toEqual(untagged)
        const query = { ...recorded, assertionType: "query_reply" as const, criterionBranch: undefined }
        expect(finalizeVisualResult(query, { kind: "mux" }, [])).toEqual(query)
        const anotherFeature = { ...recorded, featureId: "modes.bracketed-paste" }
        expect(finalizeVisualResult(anotherFeature, { kind: "mux" }, [])).toEqual(anotherFeature)
      }
    }
  }
})

// Ask 2c: pixels through a mux do not attribute a negative to that mux.
it("keeps mux reverse-video pixel negatives pending without changing query or bare-App results", () => {
  const ref = `sha256:${"f".repeat(64)}`
  const frame: ObservationFrame = { kind: "pixels", role: "target", ref, capturedAt: 1, label: "Owned target pixels" }
  const result = (status: "supported" | "unsupported"): ProbeResult => ({
    featureId: "modes.reverse-video",
    status,
    attempt,
    tests: [{ id: "criterion", status, attempt }],
    screenshotRef: ref,
  })
  const negative = result("unsupported")
  const mux = finalizeVisualResult(negative, { kind: "mux" }, [frame])
  expect(mux).toMatchObject({ status: "probe-todo", reason: expect.stringContaining("outer") })
  expect(mux.reason).toContain("dump-commands")
  for (const kind of ["term", "lib"] as const) {
    expect(finalizeVisualResult(negative, { kind }, [frame])).toEqual(negative)
  }
  const positive = result("supported")
  expect(finalizeVisualResult(positive, { kind: "mux" }, [frame])).toEqual(positive)
  const query = { ...negative, screenshotRef: undefined }
  expect(finalizeVisualResult(query, { kind: "mux" }, [])).toEqual(query)
})

// #33036 (@cto case 3): on tmux, its own DECRPM 0 answers the attribution question the outer
// command trace was needed for, so 0 and the same-run no-change pixel read decide together.
it("decides tmux reverse video from its own DECRPM 0 beside the no-change pixels; an outer DA or no pixel read stays open", () => {
  const ref = `sha256:${"f".repeat(64)}`
  const frame: ObservationFrame = { kind: "pixels", role: "target", ref, capturedAt: 1, label: "Owned target pixels" }
  const witnessed = (da: string): ProbeResult => ({
    featureId: "modes.reverse-video",
    status: "unsupported",
    attempt,
    tests: [
      { id: "criterion", status: "unsupported", attempt },
      {
        id: "decrpm-zero-witness",
        status: "unsupported",
        attempt,
        reason: `DECRPM mode 5 returned Ps 0 with device attributes ?${da}c beside it`,
      },
    ],
    screenshotRef: ref,
  })
  const tmux = { kind: "mux", id: "tmux", outerTerminal: "kitty" } as const
  const decided = finalizeVisualResult(witnessed("1;2;4"), tmux, [frame])
  expect(decided.status).toBe("unsupported")
  expect(decided.reason).toBe(
    "tmux reports DEC mode 5 not recognized (DECRPM 0, its own reply) and the frame did not change when it was set.",
  )
  expect(decided.tests.some((entry) => entry.id === "outer-command-reader")).toBe(false)
  // The outer terminal's own device attributes attribute the 0 to the outer terminal, not tmux.
  const outer = finalizeVisualResult(witnessed("62;4;22"), tmux, [frame])
  expect(outer.status).toBe("probe-todo")
  expect(outer.tests.some((entry) => entry.id === "outer-command-reader")).toBe(true)
  // No pixel read in the run: the witness alone never decides here (the probe itself refuses a
  // Ps 0 without owned pixel readback as probe-invalid, covered in modes-observations).
  const noPixels = finalizeVisualResult({ ...witnessed("1;2;4"), screenshotRef: undefined }, tmux, [])
  expect(noPixels.reason).not.toBe(
    "tmux reports DEC mode 5 not recognized (DECRPM 0, its own reply) and the frame did not change when it was set.",
  )
})

// One shared owner covers the registry and status fold. Recorder failures after a callback need
// declared, not confirmed-sent wording; an unstarted row remains a generic collection diagnostic.
it("requires app and mux visual evidence while preserving library cell and non-SGR results", () => {
  const targets = [
    { target: { kind: "term", id: "fixture" }, pending: true },
    { target: { kind: "mux", id: "fixture" }, pending: true },
    { target: { kind: "lib", id: "fixture", rendering: "render-capable" }, pending: false },
    { target: { kind: "lib", id: "fixture", rendering: "parser-only" }, pending: false },
    { target: { kind: "lib", id: "fixture" }, pending: false },
  ] as const
  for (const featureId of [...sgrProbes.map(({ id }) => id), "extensions.truecolor", "modes.bracketed-paste"]) {
    const colour = featureId.includes("truecolor") || featureId.endsWith(".256") || featureId.includes("color")
    for (const status of ["supported", "unsupported", "probe-todo", "probe-invalid", "untestable"] as const) {
      const rowAttempt = status === "probe-todo" ? { scope: "none" as const } : attempt
      const recorded: ProbeResult = {
        featureId,
        status,
        attempt: rowAttempt,
        reason: "Recorded criterion cause",
        tests: [{ id: "criterion", status, attempt: rowAttempt, reason: "Recorded test cause" }],
        rawReplyRef: featureId,
      }
      for (const { target, pending } of targets) {
        const result = finalizeVisualResult(recorded, target, [])
        const conclusive = status === "supported" || status === "unsupported"
        const declaredColour = colour && rowAttempt.scope === "probe"
        if (declaredColour) {
          expect(result.reason).toContain("Recorded criterion cause")
          for (const reason of [result.reason, result.tests[0]!.reason]) {
            expect(reason).toMatch(/SGR (?:38|48|58)[;:]/)
            expect(reason).toMatch(/\((?:colon|semicolon) form\)/)
          }
          expect(result.tests[0]!.reason).toContain("Recorded test cause")
          expect(result.tests[0]).toMatchObject({ id: "criterion", status, attempt: rowAttempt })
          if (status === "probe-invalid") {
            expect(result.reason).toContain("declared, not confirmed sent")
            expect(result.tests[0]!.reason).toContain("declared, not confirmed sent")
          }
        }
        if (featureId !== "modes.bracketed-paste" && featureId !== "extensions.truecolor" && pending && conclusive) {
          expect(result.status).toBe("probe-todo")
          expect(result.reason).toContain("visual effect not observed in this run")
          if (!colour) {
            expect(result.reason).toBe("visual effect not observed in this run")
          }
          expect(result.rawReplyRef).toBe(recorded.rawReplyRef)
          if (!colour) expect(result.tests[0]).toEqual(recorded.tests[0])
        } else if (!declaredColour) {
          expect(result).toEqual(recorded)
        } else {
          expect(result).toMatchObject({ status, attempt: rowAttempt, rawReplyRef: recorded.rawReplyRef })
          expect(result.tests).toHaveLength(1)
        }
      }
    }
  }
})

// Pixel presence cannot promote TODO/failure, and text or another feature's frame is not this
// result's screenshot. The collector tests prove the frame list itself comes from the actual probe.
it("accepts only the recorded SGR screenshot in its own pixel captures without supplying a verdict", () => {
  const ref = `sha256:${"a".repeat(64)}`
  const frame: ObservationFrame = { role: "target", ref, capturedAt: 1, label: "Fixture pixels" }
  const textFrame: ObservationFrame = {
    role: "target",
    ref,
    capturedAt: 1,
    label: "Fixture cells",
    kind: "text-cells",
    cellDigest: "cells",
    frameDigest: "frame",
    cellRectangle: { top: 1, left: 1, bottom: 1, right: 1 },
  }
  for (const status of ["supported", "unsupported", "probe-todo", "probe-invalid"] as const) {
    const recorded: ProbeResult = {
      featureId: "sgr.bold",
      status,
      attempt,
      tests: [{ id: "criterion", status, attempt }],
      screenshotRef: ref,
    }
    const target = { kind: "term", id: "render-fixture" } as const
    expect(finalizeVisualResult(recorded, target, [frame])).toEqual(recorded)
    for (const captures of [[textFrame], [{ ...frame, ref: `sha256:${"b".repeat(64)}` }], []]) {
      expect(finalizeVisualResult(recorded, target, captures).status).toBe(
        status === "supported" || status === "unsupported" ? "probe-todo" : status,
      )
    }
  }
})

// Callback-only reply markers must never become stored evidence fields. Existing tests
// did not pass callback metadata through the public finalizer's structural boundary.
it("strips callback-only reply metadata from stored result and draft serialization", () => {
  const callback = withReplyFailureEvidence("sgr.bold", replyFailure("No cursor reply"), {
    producer: "TTY",
    attempts: [{ sequence: "\x1b[6n", received: "", timeoutMs: 37, match: null, reason: "timeout" }],
  })
  const input = {
    featureId: "sgr.bold",
    attempt,
    tests: callback.tests!.map((test) => ({
      ...test,
      attempt,
    })),
    replyFailureTestIds: ["criterion"],
  }
  const result = finalizeProbeResult(input)
  const draft = initializeRunDraft({
    runId: "reply-metadata",
    sourceRevision: "1".repeat(40),
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
    manifest: {
      schemaVersion: 4,
      probeHash: "reply-suite",
      adapterVersion: "3",
      catalogIds: ["sgr.bold"],
      probes: { term: ["sgr.bold"], lib: [], mux: [] },
    },
  })
  draft.results[0] = result
  expect(result.reason).toContain('sent "\\u001b[6n"; received ""; timeout 37 ms')
  expect(result).not.toHaveProperty("replyFailureTestIds")
  expect(JSON.stringify(draft)).not.toContain("replyFailureTestIds")
})

// One formatter owns the evidence template; unrelated failure reasons and grades stay untouched.
// Configured raw query callbacks must opt into evidence before the recorder stores their failure.
// Existing protocol fixtures pin grades, but did not pass these empty branches through the formatter.
it.each([
  ["lib", "cursor.position-report"],
  ["lib", "device.dsr-996-color-scheme"],
  ["term", "device.dsr-996-color-scheme"],
  ["lib", "device.status-report"],
  ["term", "device.status-report"],
  ["lib", "device.decrqss", "DECSTBM"],
  ["term", "device.decrqss", "DECSTBM"],
  ["lib", "device.decrqss", "DECSCL"],
  ["term", "device.decrqss", "DECSCL"],
  ["lib", "device.decrqss", "DECSCUSR"],
  ["term", "device.decrqss", "DECSCUSR"],
  ["lib", "editing.decrqcra"],
  ["term", "editing.decrqcra"],
  ["lib", "extensions.osc52-clipboard"],
  ["lib", "extensions.osc52-write"],
  ["lib", "extensions.osc52-read"],
  ["term", "extensions.osc52-clipboard"],
  ["term", "extensions.osc52-read"],
  // These registered emitters were absent from the original evidence table. Their
  // nonempty controls remain unmarked except OSC 0, which requires both target replies.
  ...(
    [
      ["lib", "extensions.osc5522-clipboard"],
      ["term", "extensions.osc5522-clipboard"],
      ["lib", "extensions.osc117-reset-highlight-bg"],
      ["term", "extensions.osc117-reset-highlight-bg"],
      ["lib", "extensions.osc119-reset-highlight-fg"],
      ["term", "extensions.osc119-reset-highlight-fg"],
      ["lib", "extensions.kitty-keyboard"],
      ["term", "extensions.kitty-keyboard"],
      ["lib", "extensions.kitty-graphics"],
      ["term", "extensions.kitty-graphics"],
      ["lib", "extensions.osc0-icon-title"],
      ["term", "extensions.osc0-icon-title"],
    ] as const
  ).flatMap(
    ([kind, id]) =>
      [
        [kind, id, undefined, undefined],
        [kind, id, undefined, "malformed"],
      ] as const,
  ),
] as const)("retains empty raw query evidence for %s %s %s", async (kind, id, refused?, rawOverride?) => {
  const definition = ALL_PROBES.find((entry) => entry.id === id)!
  const captures: { sequence: string; received: string }[] = []
  const capture = (sequence: string) => {
    const received =
      rawOverride ??
      (id === "device.decrqss" &&
      (sequence === "\x1bP$qm\x1b\\" ||
        ((refused === "DECSCL" || refused === "DECSCUSR") && sequence === "\x1bP$qr\x1b\\") ||
        (refused === "DECSCUSR" && sequence === '\x1bP$q"p\x1b\\'))
        ? "\x1bP0$r\x1b\\"
        : "")
    captures.push({ sequence, received })
    return received
  }
  const outcome = (sequence: string, pattern: RegExp) => {
    const raw = capture(sequence)
    return { raw, rawBase64: btoa(raw), match: pattern.exec(raw), reason: raw ? "reply" : "timeout" }
  }
  let clipboard = ""
  const callback =
    kind === "lib"
      ? definition.lib!({
          feed() {},
          feedCapture: capture,
          ...(id === "extensions.osc0-icon-title" && { getTitle: () => "" }),
          ...(id === "device.decrqss" && { queryWithSentinelOutcome: outcome }),
        } as unknown as LibProbeSource)
      : await definition.term!({
          write(sequence: string) {
            const frame = /\x1b\]52;c;([^\x07]+)\x07/.exec(sequence)
            if (frame) clipboard = atob(frame[1]!)
          },
          queryCursorPosition: async () => ({ row: 1, col: 1 }),
          withClipboardFixture: async (work: Parameters<NonNullable<TermProbeSource["withClipboardFixture"]>>[0]) =>
            work({
              readText: async () => clipboard,
              writeText: async (text: string) => {
                clipboard = text
              },
            }),
          queryOutcome: async (sequence: string, pattern: RegExp) => outcome(sequence, pattern),
          queryWithSentinelOutcome: async (sequence: string, pattern: RegExp) => outcome(sequence, pattern),
        } as unknown as TermProbeSource)
  expect(captures.length).toBeGreaterThan(0)
  // #32246: a library highlight reset whose initial query answered zero bytes has no same-path control in this run,
  // so it is a PROBE TODO coverage record, not a reply failure.
  const highlightZeroReply =
    kind === "lib" &&
    !rawOverride &&
    (id === "extensions.osc117-reset-highlight-bg" || id === "extensions.osc119-reset-highlight-fg")
  if (highlightZeroReply) {
    expect(callback.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
  }
  const missingOsc0State = kind === "lib" && id === "extensions.osc0-icon-title"
  // @cto 2026-11-13: a term OSC 52 read with no reply and no cited read-default is probe-todo,
  // not a reply failure. The cursor control answered, so silence is ungraded.
  const osc52ReadSilence = kind === "term" && id === "extensions.osc52-read" && !rawOverride
  const expectedReplyFailure =
    (!rawOverride || id === "extensions.osc0-icon-title") &&
    !highlightZeroReply &&
    !missingOsc0State &&
    !osc52ReadSilence
  if (osc52ReadSilence) {
    expect(callback.tests).toEqual([
      expect.objectContaining({
        id: "criterion",
        status: "probe-todo",
        reason: expect.stringContaining("default not established"),
      }),
    ])
    expect(callback.observation).toBeUndefined()
  }
  if (expectedReplyFailure) expect(callback).toHaveProperty("replyFailureTestIds", ["criterion"])
  else expect(callback).not.toHaveProperty("replyFailureTestIds")
  const result =
    kind === "lib"
      ? withReplyFailureEvidence(id, callback, {
          producer: "headless",
          attempts: captures.map((entry) => ({ ...entry, timeoutMs: null })),
        })
      : withReplyFailureEvidence(id, callback, {
          producer: "TTY",
          attempts: captures.map((entry) => ({ ...entry, timeoutMs: 37, match: null, reason: "timeout" as const })),
        })
  const stored = record(result)
  // #34012 slice 3 (@cto 1676cf8a Q3): on the term arm the OSC 0 target queries are the read-back instrument,
  // so a measured silence is an open row that still carries its attempt evidence, not a reply failure.
  const measuredSilenceOsc0Term = kind === "term" && id === "extensions.osc0-icon-title" && !rawOverride
  if (!expectedReplyFailure) {
    expect(result).toBe(callback)
    expect(stored).toEqual(record(callback))
    return
  }
  expect(stored.status).toBe(measuredSilenceOsc0Term ? "probe-todo" : "probe-invalid")
  for (const entry of captures) {
    expect(stored.reason).toContain(
      `sent ${JSON.stringify(entry.sequence)}; received ${JSON.stringify(entry.received)}`,
    )
  }
  expect(stored).not.toHaveProperty("replyFailureTestIds")
})

// These nullable CPR exits lost reply evidence after a public projection. Existing
// protocol tests pin measured outcomes, but never carry these failures through the recorder.
it.each([
  ["cursor.ansi-save", [null], undefined],
  ["cursor.ansi-save", [[3, 5], null], "\x1b[u"],
  ["cursor.ansi-save", [[3, 5], [10, 15], null], "\x1b[u"],
  ["cursor.ansi-restore", [[4, 6], [12, 18], null], "\x1b[u"],
  ["cursor.save-restore", [[3, 5], null], "\x1b8"],
  ["cursor.position-report", [null], undefined],
  ["cursor.reverse-wrap", [null], "\x1b[?45l"],
  ["cursor.cup-boundaries", [null], undefined],
  ["cursor.cup-boundaries", [[1, 1], null], undefined],
  ["cursor.cup-boundaries", [[1, 1], [24, 80], null], undefined],
  ["cursor.cup-boundaries", [[1, 1], [24, 80], [1, 1], null], undefined],
  ["cursor.cud-past-bottom", [null], undefined],
  ["cursor.cup-scroll-region", [null, [2, 1], [11, 1]], "\x1b[r"],
  ["reset.sgr", [null], undefined],
  ["reset.ris", [null], undefined],
  ["reset.ris", [[5, 5], null], undefined],
  ["scrollback.accumulate", [null], undefined],
  ["scrollback.total-lines", [null], undefined],
  ["unicode.wrap-boundary", [null], undefined],
  ["unicode.tab-stops", [null], undefined],
  ["sgr.underline-color-indexed", [null], "\u001b[0m"],
  ["sgr.underline-color-reset", [null], "\u001b[0m"],
  ["sgr.selective-reset.bold", [null], "\u001b[0m"],
  ["text.newline", [null, [4, 5]], undefined],
  ["text.newline", [[3, 5], null], undefined],
  ["text.cr", [null, [1, 1]], undefined],
  ["text.cr", [[1, 3], null], undefined],
  ["text.backspace", [null, [1, 4]], undefined],
  ["text.backspace", [[1, 5], null], undefined],
  ["text.index", [null, [4, 5]], undefined],
  ["text.index", [[3, 5], null], undefined],
  ["text.next-line", [null, [4, 1]], undefined],
  ["text.next-line", [[3, 5], null], undefined],
  ["text.wrap", [[1, 1], null], undefined],
  ["text.wrap", [[1, 1], [1, 80], null], undefined],
  ["text.tbc", [null, [1, 17], [1, 25], [1, 80]], undefined],
  ["text.tbc", [[1, 9], null, [1, 25], [1, 80]], undefined],
  ["text.tbc", [[1, 9], [1, 17], null, [1, 80]], undefined],
  ["text.tbc", [[1, 9], [1, 17], [1, 25], null], undefined],
  ["text.cht", [null], undefined],
  ["text.cht", [[1, 1], null], undefined],
  ["text.cbt", [null], undefined],
  ["text.cbt", [[1, 21], null], undefined],
  ["extensions.osc66-text-sizing", [null], undefined],
  ["extensions.osc66-text-sizing", [[1, 1], null, [1, 5]], undefined],
  ["extensions.osc66-text-sizing", [[1, 1], [1, 3], null], undefined],
  ["extensions.osc66-text-sizing", [[1, 1], null, null], undefined],
  ["cursor.move.back", [null], undefined],
  ["cursor.move.back", [[1, 1], null], undefined],
  ["cursor.move.back", [[1, 1], [1, 4], null], undefined],
  ["modes.altscreen-1048", [null], undefined],
  ["modes.altscreen-1048", [[5, 10], null], "\x1b[?1048l"],
] as const)("retains erased cursor evidence for %s with readings %j", async (id, readings, cleanup) => {
  const definition = ALL_PROBES.find((entry) => entry.id === id)!
  const writes: string[] = []
  const attempts: {
    sequence: string
    received: string
    timeoutMs: number
    match: string[] | null
    reason: "reply" | "timeout"
  }[] = []
  let cursorReads = 0
  const callback = await definition.term!({
    rows: 24,
    cols: 80,
    write: (sequence: string) => writes.push(sequence),
    ...((id === "reset.sgr" || id.startsWith("sgr.")) && {
      queryWithSentinelOutcome: async (sequence: string) => {
        attempts.push({ sequence, received: "", timeoutMs: 37, match: null, reason: "timeout" })
        return { raw: "", rawBase64: "", match: null, reason: "timeout" }
      },
    }),
    ...(id === "text.wrap" && {
      queryMode: async (mode: number) => {
        const received = `\x1b[?${mode};1$y`
        attempts.push({ sequence: `\x1b[?${mode}$p`, received, timeoutMs: 37, match: [received], reason: "reply" })
        return "set"
      },
    }),
    queryCursorPosition: async () => {
      if (cursorReads >= readings.length) throw new Error(`Unexpected extra CPR for ${id}`)
      const reading = readings[cursorReads++]!
      const received = reading ? `\x1b[${reading[0]};${reading[1]}R` : "\x1b?"
      attempts.push({
        sequence: "\x1b[6n",
        received,
        timeoutMs: 37,
        match: reading ? [received] : null,
        reason: reading ? "reply" : "timeout",
      })
      return reading ? { row: reading[0], col: reading[1] } : null
    },
  } as unknown as TermProbeSource)
  expect(cursorReads).toBe(readings.length)
  expect(attempts).toHaveLength(
    // The indexed underline witness never asks DECRQSS; its fallback retains only the actual CPR.
    readings.length +
      (id === "reset.sgr" || (id.startsWith("sgr.") && id !== "sgr.underline-color-indexed") || id === "text.wrap"
        ? 1
        : 0),
  )
  if (cleanup) expect(writes.at(-1)).toBe(cleanup)
  if (["unicode.tab-stops", "text.tbc", "text.cht", "text.cbt"].includes(id)) {
    expect(writes.at(-1)).toMatch(/^\x1b\[3g.*\x1b\[1;1H$/s)
  }
  expect(callback).toHaveProperty("replyFailureTestIds", ["criterion"])
  if (id === "cursor.move.back") {
    expect(callback.note).toBe(
      [
        "Cursor origin readback returned null",
        "Cursor setup readback returned null",
        "Cursor movement readback returned null",
      ][readings.length - 1],
    )
  }
  const stored = record(withReplyFailureEvidence(id, callback, { producer: "TTY", attempts }))
  expect(stored.status).toBe("probe-invalid")
  expect(stored.reason).toContain(
    "no parsable cursor position reply; the public projection returned null and retained no bytes",
  )
  for (const [index, entry] of attempts.entries()) {
    expect(stored.reason).toContain(
      `query ${index + 1}: sent ${JSON.stringify(entry.sequence)}; received ${JSON.stringify(entry.received)}`,
    )
  }
  expect(stored).not.toHaveProperty("replyFailureTestIds")
})

it("retains erased DECAWM evidence when wrap cursor controls cannot qualify", async () => {
  const writes: string[] = []
  const callback = await ALL_PROBES.find((entry) => entry.id === "text.wrap")!.term!({
    rows: 24,
    cols: 80,
    write: (sequence: string) => writes.push(sequence),
    queryMode: async () => null,
    queryCursorPosition: async () => null,
  } as unknown as TermProbeSource)
  expect(writes).toEqual(["\x1b[?7l\x1b[2J\x1b[H", "W".repeat(79), "\x1b[?7h"])
  expect(callback).toHaveProperty("replyFailureTestIds", ["criterion"])
  expect(JSON.parse(callback.response!)).toEqual({ decrpm: null, cols: 80, home: null, control: null })
  const stored = record(
    withReplyFailureEvidence("text.wrap", callback, {
      producer: "TTY",
      attempts: [{ sequence: "\x1b[?7$p", received: "\x1b?", timeoutMs: 37, match: null, reason: "timeout" }],
    }),
  )
  expect(stored.status).toBe("probe-todo")
  expect(stored.reason).toContain("Auto-wrap cursor control did not measure home and ordinary text")
  expect(stored.reason).toContain('query 1: sent "\\u001b[?7$p"; received "\\u001b?"')
  expect(stored).not.toHaveProperty("replyFailureTestIds")
})

// Mode2031's missing protocol facility is TODO. Soft reset can use input effects,
// but this context supplies no actuator; preserve the real reply failure only for null.
it.each([
  ["modes.color-scheme-reporting", 2031, null],
  ["reset.soft", 1, null],
  ["reset.soft", 1, 0],
] as const)("retains initial mode evidence for %s with Ps %s/%s", async (id, mode, ps) => {
  const writes: string[] = []
  const sequence = `\x1b[?${mode}$p`
  const received = ps === null ? "\x1b?" : `\x1b[?${mode};${ps}$y`
  const callback = await ALL_PROBES.find((entry) => entry.id === id)!.term!({
    rows: 24,
    cols: 80,
    write: (s: string) => writes.push(s),
    queryWithSentinel: async (sent: string, pattern: RegExp) => {
      expect(sent).toBe(sequence)
      return ps === null ? null : pattern.exec(received)
    },
  } as unknown as TermProbeSource)
  expect(writes).toEqual([])
  expect(callback.observation).toBeUndefined()
  expect(callback.assertions).toBeUndefined()
  if (id === "modes.color-scheme-reporting" || ps === 0) expect(callback).not.toHaveProperty("replyFailureTestIds")
  else expect(callback).toHaveProperty("replyFailureTestIds", ["criterion"])
  const stored = record(
    withReplyFailureEvidence(id, callback, {
      producer: "TTY",
      attempts: [
        {
          sequence,
          received,
          timeoutMs: 37,
          match: ps === null ? null : [received],
          reason: ps === null ? "timeout" : "reply",
        },
      ],
    }),
  )
  expect(stored.status).toBe(id === "modes.color-scheme-reporting" ? "probe-todo" : "probe-invalid")
  if (id === "modes.color-scheme-reporting") {
    expect(stored.reason).toBe("no DECRPM reply")
  } else if (ps === 0) {
    expect(stored.reason).toBe("Soft-reset effect needs owned key injection and input readback")
    expect(callback.note).toContain("DECRPM mode 1 returned Ps 0")
  } else {
    expect(stored.reason).toContain("Soft-reset effect needs owned key injection and input readback")
    expect(stored.reason).toContain(
      `sent ${JSON.stringify(sequence)}; received ${JSON.stringify(received)}; ${ps === null ? "timeout 37 ms" : "matched"}`,
    )
  }
  expect(stored).not.toHaveProperty("replyFailureTestIds")
})

// A refused DECRQSS reply becomes null without proving that the terminal emitted no bytes.
it("retains unusable cursor-style reply evidence without a pixel fallback", async () => {
  const writes: string[] = []
  const sequence = "\x1bP$q q\x1b\\"
  const received = "\x1bP0$r\x1b\\"
  const callback = await ALL_PROBES.find((entry) => entry.id === "cursor.shape")!.term!({
    write: (s: string) => writes.push(s),
    queryWithSentinelOutcome: async (sent: string) => {
      expect(sent).toBe(sequence)
      return { raw: received, rawBase64: btoa(received), match: null, reason: "timeout" }
    },
  } as unknown as TermProbeSource)
  expect(writes).toEqual(["\x1b[6 q", "\x1b[0 q"])
  expect(callback).toHaveProperty("replyFailureTestIds", ["criterion"])
  const stored = record(
    withReplyFailureEvidence("cursor.shape", callback, {
      producer: "TTY",
      attempts: [{ sequence, received, timeoutMs: 37, match: null, reason: "timeout" }],
    }),
  )
  expect(stored.status).toBe("probe-invalid")
  expect(stored.reason).toContain("no usable DECRQSS cursor-style reply")
  expect(stored.reason).toContain(
    `sent ${JSON.stringify(sequence)}; received ${JSON.stringify(received)}; timeout 37 ms`,
  )
  expect(stored).not.toHaveProperty("replyFailureTestIds")
})

it("retains each query's own state when a failed query is followed by a matching cleanup reply", () => {
  const result = withReplyFailureEvidence("cursor.fixture", replyFailure("no parsable cursor position reply"), {
    producer: "TTY",
    attempts: [
      { sequence: "\x1b[6n", received: "\x1b[1;1R", timeoutMs: 41, match: ["\x1b[1;1R", "1", "1"], reason: "reply" },
      { sequence: "\x1b[6n", received: "garbage", timeoutMs: 37, match: null, reason: "timeout" },
      { sequence: "\x1b[6n", received: "\x1b[2;3R", timeoutMs: 53, match: ["\x1b[2;3R", "2", "3"], reason: "reply" },
    ],
  })
  expect(result.tests?.[0]).toMatchObject({ id: "criterion", status: "probe-invalid" })
  expect(result.tests?.[0]?.reason).toBe(
    'no parsable cursor position reply; query 1: sent "\\u001b[6n"; received "\\u001b[1;1R"; matched | query 2: sent "\\u001b[6n"; received "garbage"; timeout 37 ms | query 3: sent "\\u001b[6n"; received "\\u001b[2;3R"; matched',
  )
})

it.each([
  {
    kind: "cursor",
    result: () => unmeasuredCellResult(null, "changed cells"),
    reason: "no parsable cursor position reply",
  },
  { kind: "DECRPM", result: () => decrpmResult(null, 7), reason: "no usable DECRPM reply" },
])("marks an erased $kind reading without asserting silence", ({ result, reason }) => {
  const callback = result()
  expect(callback).toHaveProperty("replyFailureTestIds", ["criterion"])
  expect(callback.tests?.[0]).toMatchObject({ status: "probe-invalid", reason: expect.stringContaining(reason) })
  expect(callback.tests?.[0]?.reason).toContain("the public projection returned null and retained no bytes")
})

it.each([
  {
    producer: "TTY" as const,
    attempts: [{ sequence: "\x1b[6n", received: "", timeoutMs: 37, match: null, reason: "timeout" as const }],
    expected: 'query 1: sent "\\u001b[6n"; received ""; timeout 37 ms',
  },
  {
    producer: "headless" as const,
    attempts: [{ sequence: "\x1b[6n", received: "\x1b?", timeoutMs: null }],
    expected: 'sent "\\u001b[6n"; received "\\u001b?"; synchronous feed and getCursor boundary; timeout not applicable',
  },
  {
    producer: "TTY" as const,
    attempts: [
      { sequence: "\x1b[6n", received: "\x1b[?1;2c", timeoutMs: 37, match: null, reason: "sentinel" as const },
    ],
    expected: 'query 1: sent "\\u001b[6n"; received "\\u001b[?1;2c"; no match',
  },
  { producer: "TTY" as const, attempts: [], expected: "no completed TTY trace for this query" },
  { producer: "headless" as const, attempts: [], expected: "no headless capture recorded" },
])("retains only explicitly marked $producer failure evidence", (evidence) => {
  const { expected } = evidence
  const callback = replyFailure("No cursor reply")
  const unrelated = { id: "setup", status: "probe-invalid" as const, reason: "Fixture not established" }
  callback.tests.push(unrelated)
  const result = withReplyFailureEvidence("cursor.position-report", callback, evidence)
  expect(result.tests?.[0]).toMatchObject({ id: "criterion", status: "probe-invalid" })
  expect(result.tests?.[0]?.reason).toBe(`No cursor reply; ${expected}`)
  expect(result.tests?.[1]).toBe(unrelated)
  const unmarked: ProbeCallbackResult = { pass: false, tests: [unrelated] }
  expect(withReplyFailureEvidence("cursor.position-report", unmarked, evidence)).toBe(unmarked)
  expect(callback.tests[0].reason).toBe("No cursor reply")
})

it("names a callback defect instead of ignoring an invalid reply marker", () => {
  // An execution-only callback can only name an open or invalid test, so the marker check is proved through a
  // measured result that carries no tests at all: the marker must name a row that exists.
  const measured = {
    pass: false,
    observation: { outcome: "inconclusive" as const, assertionType: "query_reply" as const },
    replyFailureTestIds: ["criterion"],
  }
  expect(() => withReplyFailureEvidence("device.geometry", measured, { producer: "TTY", attempts: [] })).toThrow(
    /device\.geometry.*criterion.*open or invalid/,
  )
  const markedCoverage = {
    pass: false,
    notTested: { reason: "no-semantic-observable" as const, noObservable: "test fixture" },
    replyFailureTestIds: ["criterion"],
  }
  // @ts-expect-error Coverage cannot carry failure-evidence intent, even via structural assignment.
  const forbiddenCoverage: NotTestedCoverageResult = markedCoverage
  void forbiddenCoverage
})

// An unavailable read method stays open (@cto 91ec1211): the probe ran and nothing was readable here, so the row
// must not count as a broken probe. The formatter still attaches the producer's evidence, and fixture breakage
// keeps probe-invalid, so the two classes never merge.
it("keeps a read-method gap open while a broken fixture stays invalid", () => {
  const gap = withReplyFailureEvidence(
    "input.mouse-1000",
    methodUnavailable("Mouse tracking effect needs owned click injection and input readback"),
    {
      producer: "TTY",
      attempts: [{ sequence: "\x1b[?1000h", received: "", timeoutMs: 37, match: null, reason: "timeout" }],
    },
  )
  const open = recordExecutedProbe({
    featureId: "input.mouse-1000",
    assertions: [],
    tests: gap.tests,
    attempt: { scope: "probe", startedAt: "2026-11-13T00:00:00.000Z" },
  })
  expect(open.status).toBe("probe-todo")
  expect(open.reason).toContain("needs owned click injection")
  expect(open.reason).toContain('sent "\\u001b[?1000h"; received ""; timeout 37 ms')
  const broken = recordExecutedProbe({
    featureId: "input.mouse-1000",
    assertions: [],
    tests: replyFailure("Cursor shape fixture CPR did not locate row 2 column 3").tests,
    attempt: { scope: "probe", startedAt: "2026-11-13T00:00:00.000Z" },
  })
  expect(broken.status).toBe("probe-invalid")
})

// CTO consolidation contract: the registry owns unknown/duplicate IDs and catalogue ordering.
// Existing collector tests prove dispatch; they cannot pin this shared typed boundary.
it("resolves explicit probe IDs once in catalogue order with typed invalid and empty outcomes", () => {
  const first = ALL_PROBES[0]!
  const second = ALL_PROBES[1]!
  expect(resolveProbeIds([second.id, first.id])).toEqual({ result: "resolved", probes: [first, second] })
  expect(resolveProbeIds([])).toEqual({ result: "empty", probes: [] })
  expect(resolveProbeIds([first.id, "unknown", first.id, "unknown"])).toEqual({
    result: "invalid",
    unknownIds: ["unknown"],
    duplicateIds: [first.id, "unknown"],
  })
})

// AC3: callbacks alone cannot preserve an empty/pre-start attempt or distinguish it from legacy absence.
it.each([
  { ids: [], result: "empty" },
  { ids: ["selected"], result: "failed", error: "original\ntransport error" },
  { ids: ["selected"], result: "cancelled", error: "SIGINT", startedAt: attempt.startedAt },
  { ids: ["selected"], result: "completed", startedAt: attempt.startedAt, hostInputs: { clipboard: "not-supplied" } },
] satisfies CollectorAttempt[])("retains selected intent and $result without inventing output", (collection) => {
  const draft = initializeRunDraft({
    runId: "selected-attempt",
    sourceRevision: "1".repeat(40),
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
    manifest: {
      schemaVersion: 4,
      probeHash: "subset-suite",
      adapterVersion: "3",
      catalogIds: ["selected", "untouched"],
      probes: { term: ["selected", "untouched"], lib: [], mux: [] },
    },
  })
  recordCollectorSelection(draft, collection.ids)
  recordCollectorAttempt(draft, collection)
  expect(readCollectorSelection(draft.rawReplies)?.ids).toEqual(collection.ids)
  expect(readCollectorAttempt(draft.rawReplies)).toEqual(collection)
  expect(draft.results.map((result) => result.attempt)).toEqual([{ scope: "none" }, { scope: "none" }])
  // Raw-row acceptance: run-level selection alone cannot explain an untouched row.
  for (const result of draft.results) {
    expect(result.reason).toMatch(
      collection.ids.some((id) => id === result.featureId) ? /has not started/i : /not selected/i,
    )
  }
  expect(draft.runId).toBe("selected-attempt")
  // The accepted raw contract must be stable when native dispatch records the same schedule again.
  const retained = JSON.stringify(draft)
  recordCollectorSelection(draft, collection.ids)
  expect(JSON.stringify(draft)).toBe(retained)
})

it("keeps legacy absence distinct from malformed or newly completed collection evidence", () => {
  expect(readCollectorSelection({})).toBeUndefined()
  expect(readCollectorAttempt({})).toBeUndefined()
  const legacy = { ids: ["selected"], startedAt: attempt.startedAt }
  expect(readCollectorAttempt({ "collector.collectionAttempt": JSON.stringify(legacy) })).toEqual(legacy)
  expect(() => readCollectorSelection({ "collector.selection": "broken JSON" })).toThrow("collector.selection")
  expect(() =>
    readCollectorAttempt({ "collector.collectionAttempt": JSON.stringify({ ids: [], result: "completed" }) }),
  ).toThrow("recorded start")
})
// Full-catalog drafts previously let a failed subset dispatch mark unscheduled capabilities failed.
it("records collection failure only for delegated unfinished IDs", () => {
  const draft = initializeRunDraft({
    runId: "subset",
    sourceRevision: "1".repeat(40),
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
    manifest: {
      schemaVersion: 4,
      probeHash: "subset-suite",
      adapterVersion: "3",
      catalogIds: ["selected", "unscheduled", "unimplemented", "decided"],
      probes: { term: ["selected", "unscheduled", "decided"], lib: [], mux: [] },
    },
  })
  const decided = {
    ...draft.results[3]!,
    status: "supported" as const,
    attempt,
    tests: [{ id: "criterion", status: "supported" as const, attempt }],
  }
  draft.results[3] = decided
  recordCollectionFailure(draft, attempt.startedAt, "transport broke", ["selected", "decided"])
  expect(draft.results.map((result) => result.status)).toEqual([
    "probe-invalid",
    "probe-todo",
    "probe-todo",
    "supported",
  ])
  expect(draft.results[0]?.attempt).toEqual({
    scope: "collection",
    startedAt: attempt.startedAt,
    diagnosticRef: "collector.failure",
  })
  expect(draft.results[1]?.attempt).toEqual({ scope: "none" })
  expect(draft.results[2]?.attempt).toEqual({ scope: "none" })
  expect(draft.results[3]).toBe(decided)
  // Raw selection must preserve attempted results while a still-unstarted native schedule changes.
  const failed = structuredClone(draft.results[0])
  recordCollectorSelection(draft, ["unscheduled"])
  expect(draft.results[0]).toEqual(failed)
  expect(draft.results[3]).toBe(decided)
  expect(draft.results[1]!.reason).toMatch(/has not started/i)
  expect(draft.results[2]!.reason).toMatch(/not selected/i)
  recordCollectorSelection(draft, ["unimplemented"])
  expect(draft.results[1]!.reason).toMatch(/not selected/i)
  expect(draft.results[2]!.reason).toMatch(/has not started/i)
})
const frames: ObservationFrame[] = [
  {
    role: "control",
    label: "normal glyph",
    ref: `sha256:${"a".repeat(64)}`,
    capturedAt: 1,
    regionRectangle: { x: 0, y: 0, width: 10, height: 20 },
  },
  {
    role: "target",
    label: "bold glyph",
    ref: `sha256:${"b".repeat(64)}`,
    capturedAt: 2,
    regionRectangle: { x: 0, y: 26, width: 10, height: 20 },
  },
]
const record = (callback: ProbeCallbackResult) =>
  recordExecutedProbe({
    featureId: "sgr.bold",
    attempt,
    rawReplyRef: "sgr.bold",
    ...(callback.observation && {
      observation: { ...callback.observation, featureId: "sgr.bold", rawReplyRef: "sgr.bold" },
    }),
    tests: callback.tests,
    criterionBranch: callback.criterionBranch,
    assertions: (callback.assertions ?? []).map((assertion) => ({
      ...assertion,
      featureId: "sgr.bold",
      rawReplyRef: "sgr.bold",
    })),
  })

// Existing callback tests checked statuses, but did not pass these native fallbacks through the
// recorder. Removing their consumed observations must preserve the old persisted reason exactly.
it("preserves producer-specific native geometry refusal reasons without appending to query failures", async () => {
  const rows = [
    sgrProbe("fixture.sgr", "\x1b[1m", () => true),
    ...sgrProbes,
    ...extensionsProbes,
    ...deviceProbes,
    ...modesProbes,
    ...resetProbes,
  ]
  const cases = [
    ["fixture.sgr", "Cursor advance does not verify SGR styling", 2],
    ["sgr.underline-color-indexed", "SGR 58:5:1 (colon form); Cursor advance does not verify SGR styling", 2],
    [
      "sgr.underline-color-reset",
      "SGR 59 after setup SGR 58:2::255:0:128 (colon form); Cursor advance does not verify the reset rendered",
      3,
    ],
    ["sgr.selective-reset.bold", "Cursor advance does not verify SGR reset", 3],
    [
      "extensions.truecolor",
      "extensions.truecolor: SGR 38;2;255;128;0 (semicolon form); SGR 38;2;17;97;201 (semicolon form) is the secondary contrasting library sample; SGR was consumed; RGB cell color was not measured",
      2,
    ],
    ["extensions.osc720-scroll-up", "Cursor answered; scrollback viewport was not measured", 2],
    ["extensions.osc8", "Cursor movement cannot verify OSC 8 link metadata or click behavior", 2],
    ...["xtpushsgr", "xtpopsgr", "xtsave", "xtrestore", "xtpushcolors", "xtpopcolors"].map(
      (name) => [`modes.${name}`, "Cursor responsiveness does not measure saved/restored state", 2] as const,
    ),
    ["reset.sgr", "Cursor advance does not measure SGR styling after reset", 2],
  ] as const
  for (const [id, priorNote, col] of cases) {
    const term = rows.find((row) => row.id === id)?.term
    if (!term) throw new Error(`Missing native callback ${id}`)
    for (const refusal of [undefined, "", "calibration G"]) {
      const callback = await term({
        rows: 24,
        cols: 80,
        write() {},
        captureGeometryRefusal: refusal,
        queryCursorPosition: async () => ({ row: 1, col }),
        queryWithSentinelOutcome: async () => ({ reason: "timeout", raw: "", match: null }),
      } as unknown as TermProbeSource)
      expect(record(callback).reason, `${id}: ${String(refusal)}`).toBe(
        `${priorNote}${refusal ? `; Pixel capture unavailable: ${refusal}` : ""}`,
      )
      expect(record(callback).status, id).toBe("probe-todo")
      expect(callback.observation, id).toBeUndefined()
    }
  }
  const term = sgrProbes.find((row) => row.id === "sgr.underline-color-indexed")!.term!
  const wrong = await term({
    rows: 24,
    cols: 80,
    write() {},
    captureGeometryRefusal: "calibration G",
    queryCursorPosition: async () => ({ row: 1, col: 9 }),
    queryWithSentinelOutcome: async () => ({ reason: "timeout", raw: "", match: null }),
  } as unknown as TermProbeSource)
  expect(record(wrong)).toMatchObject({
    status: "probe-invalid",
    reason: "SGR 58:5:1 (colon form); Cursor advance does not verify SGR styling",
  })
  for (const [id, col, reason] of [
    [
      "sgr.underline-color-reset",
      9,
      "SGR 59 after setup SGR 58:2::255:0:128 (colon form); Cursor advance does not verify the reset rendered",
    ],
    ["sgr.selective-reset.bold", 9, "Cursor did not reach the expected position"],
    [
      "fixture.sgr",
      null,
      "no parsable cursor position reply; the public projection returned null and retained no bytes",
    ],
    [
      "sgr.underline-color-indexed",
      null,
      "SGR 58:5:1 (colon form); no parsable cursor position reply; the public projection returned null and retained no bytes",
    ],
    [
      "sgr.underline-color-reset",
      null,
      "SGR 59 after setup SGR 58:2::255:0:128 (colon form); no parsable cursor position reply; the public projection returned null and retained no bytes",
    ],
    [
      "sgr.selective-reset.bold",
      null,
      "no parsable cursor position reply; the public projection returned null and retained no bytes",
    ],
    [
      "modes.xtpushsgr",
      null,
      "no parsable cursor position reply; the public projection returned null and retained no bytes",
    ],
    ["reset.sgr", null, "no parsable cursor position reply; the public projection returned null and retained no bytes"],
  ] as const) {
    const callback = await rows.find((row) => row.id === id)!.term!({
      rows: 24,
      cols: 80,
      write() {},
      captureGeometryRefusal: "calibration G",
      queryCursorPosition: async () => (col === null ? null : { row: 1, col }),
      queryWithSentinelOutcome: async () => ({ reason: "timeout", raw: "", match: null }),
    } as unknown as TermProbeSource)
    expect(record(callback), id).toMatchObject({ status: "probe-invalid", reason })
  }
  const helperWrong = await rows[0]!.term!({
    rows: 24,
    cols: 80,
    write() {},
    captureGeometryRefusal: "calibration G",
    queryCursorPosition: async () => ({ row: 1, col: 9 }),
  } as unknown as TermProbeSource)
  expect(helperWrong.pass).toBe(false)
  expect(record(helperWrong)).toMatchObject({
    status: "probe-todo",
    reason: "Cursor advance does not verify SGR styling; Pixel capture unavailable: calibration G",
  })
})

it("keeps native missing-observation note overrides and prompt consumption branches exact", async () => {
  for (const id of ["extensions.osc8", "device.xtwinops-22", "device.xtwinops-23"]) {
    const term = [...extensionsProbes, ...deviceProbes].find((row) => row.id === id)?.term
    if (!term) throw new Error(`Missing native callback ${id}`)
    for (const pos of [null, { row: 1, col: 2 }]) {
      // OSC8 has its own observation note when CPR is present; the title-stack callbacks never did.
      if (id === "extensions.osc8" && pos) continue
      for (const refusal of [undefined, "calibration G"]) {
        const callback = await term({
          rows: 24,
          cols: 80,
          write() {},
          captureGeometryRefusal: refusal,
          queryCursorPosition: async () => pos,
        } as unknown as TermProbeSource)
        expect(record(callback)).toMatchObject({
          status: "probe-todo",
          reason: refusal ? `Pixel capture unavailable: ${refusal}` : callback.note,
        })
      }
    }
  }
  const prompt = extensionsProbes.find((row) => row.id === "extensions.osc133-a")!.term!
  for (const pos of [null, { row: 1, col: 1 }]) {
    const callback = await prompt({
      write() {},
      captureGeometryRefusal: "calibration G",
      queryCursorPosition: async () => pos,
    } as unknown as TermProbeSource)
    expect(record(callback)).toMatchObject(
      pos
        ? {
            status: "probe-todo",
            reason:
              "Marker consumption was not confirmed; shell prompt integration was not observed; Pixel capture unavailable: calibration G",
          }
        : { status: "probe-invalid", reason: "No cursor reply after semantic prompt marker" },
    )
  }
  const libPrompt = extensionsProbes.find((row) => row.id === "extensions.osc133-a")!.lib!
  const libCallback = await libPrompt({
    feed() {},
    getCursor: () => ({ x: 0, y: 0 }),
    getCell: () => ({ char: "X" }),
    capabilities: { extensions: new Set<string>() },
    captureGeometryRefusal: "calibration G",
  } as unknown as LibProbeSource)
  expect(record(libCallback)).toMatchObject({
    status: "probe-todo",
    reason: "Marker was consumed; shell prompt integration was not observed",
  })
})

it("preserves native callback note fallback for unmeasured widths and TERM_FEATURES", async () => {
  // These native callbacks retained no deciding cells. Their final failure reason previously
  // came from callback.note; status-only fixtures miss that producer-to-recorder loss.
  // OSC22 uses selected-shape replies now; extensions-osc22-app.test.ts owns its silent cases.
  for (const id of ["editing.decsace"]) {
    const term = [...extensionsProbes, ...editingProbes].find((row) => row.id === id)?.term
    if (!term) throw new Error(`Missing native callback ${id}`)
    const missing = await term({
      write() {},
      queryCursorPosition: async () => null,
    } as unknown as TermProbeSource)
    expect(missing).toHaveProperty("replyFailureTestIds", ["criterion"])
    expect(record(missing)).toMatchObject({
      status: "probe-invalid",
      reason: expect.stringMatching(
        /^no parsable cursor position reply after .*; the public projection returned null and retained no bytes$/,
      ),
    })
  }
  for (const row of unicodeProbes) {
    if (!["unicode.east-asian-ambiguous", "unicode.grapheme-cursor"].includes(row.id)) continue
    if (!row.term) continue
    const callback = await row.term({
      cols: 80,
      measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    } as unknown as TermProbeSource)
    expect(record(callback)).toMatchObject({
      status: "probe-todo",
      reason: "sample width: no cursor-position readback at sample",
    })
  }
  const callback = await deviceProbes.find((row) => row.id === "device.term-features")!.term!({} as TermProbeSource)
  expect(callback.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: "terminal child environment",
  })
  expect(
    recordExecutedProbe({
      featureId: "device.term-features",
      attempt,
      rawReplyRef: "device.term-features",
      assertions: [],
      coverage: {
        featureId: "device.term-features",
        ...callback.notTested!,
        rawReplyRef: "device.term-features",
      },
    }),
  ).toMatchObject({ status: "probe-todo", reason: "terminal child environment" })
  for (const id of ["unicode.wrap-boundary", "unicode.tab-stops"]) {
    const term = unicodeProbes.find((row) => row.id === id)?.term
    if (!term) throw new Error(`Missing native callback ${id}`)
    const missing = await term({
      rows: 24,
      cols: 80,
      write() {},
      queryCursorPosition: async () => null,
    } as unknown as TermProbeSource)
    expect(record(missing)).toMatchObject({
      status: "probe-invalid",
      reason: "no parsable cursor position reply; the public projection returned null and retained no bytes",
    })
  }
})

// Tab and checksum replies publish
// explicit reply failures, so their reason is independent of the callback note.
it("preserves explicit tab and checksum reply failures", async () => {
  for (const [id, startCol] of [
    ["text.cht", 1],
    ["text.cbt", 21],
  ] as const) {
    const term = textProbes.find((row) => row.id === id)?.term
    if (!term) throw new Error(`Missing native callback ${id}`)
    let reads = 0
    const callback = await term({
      cols: 80,
      write() {},
      queryCursorPosition: async () => (++reads === 1 ? { row: 1, col: startCol } : null),
    } as unknown as TermProbeSource)
    expect(reads).toBe(2)
    expect(record(callback)).toMatchObject({
      status: "probe-invalid",
      reason: "no parsable cursor position reply; the public projection returned null and retained no bytes",
    })
  }
  const checksum = editingProbes.find((row) => row.id === "editing.decrqcra")!
  const native = await checksum.term!({
    write() {},
    queryWithSentinelOutcome: async () => ({ reason: "timeout", raw: "", match: null }),
  } as unknown as TermProbeSource)
  expect(record(native)).toMatchObject({
    status: "probe-invalid",
    reason: "no usable checksum reply",
  })
  const lib = await checksum.lib!({ feed() {}, feedCapture: () => "" } as unknown as LibProbeSource)
  expect(record(lib)).toMatchObject({ status: "probe-invalid", reason: "no usable checksum reply" })
})
// Prior tests only inspected the retained frames/inconclusive observation. These exercise both real
// callback branches through the production result recorder and seal boundary, where the bug lived.
it("records the actual unequal-crop comparison as PROBE INVALID despite two retained frames", () => {
  const callback = cropPositionRefusal({
    id: "sgr.bold",
    compared: frames.map((frame) => ({ role: frame.role, rectangle: frame.regionRectangle })),
    response: "measured unequal crop positions",
    frames,
    screenshotRef: frames[1]!.ref,
  })
  if (!callback) throw new Error("Expected actual crop-position refusal")
  const result = record(callback)
  expect(result.status).toBe("probe-invalid")
  expect(result.frames).toEqual(frames)
  expect(result.tests).toContainEqual(expect.objectContaining({ id: "comparison", status: "probe-invalid", attempt }))
})
it("keeps an explicit unattempted visual review TODO when the capture seals", async () => {
  let next = 0
  const callback = await sgrCaptureFrames(
    { write() {}, capture: async () => frames[next++]! } as unknown as TermProbeSource,
    "control",
    "target",
    "bold target",
    {},
    undefined,
    "normal control",
  )
  expect(callback.tests).toContainEqual(expect.objectContaining({ id: "review", status: "probe-todo" }))
  const result = record(callback)
  expect(result.status).toBe("probe-todo")
  expect(result.tests.find((check) => check.id === "review")?.attempt).toEqual({ scope: "none" })
  expect(callback.assertions?.[0]?.expected).toContain("bold target")
  expect(callback.assertions?.[0]?.observed).toContain(frames[1]!.ref)
  const draft = initializeRunDraft({
    runId: "pending-review",
    sourceRevision: "1".repeat(40),
    manifest: {
      schemaVersion: 4,
      probeHash: "explicit-check-suite",
      adapterVersion: "3",
      catalogIds: ["sgr.bold"],
      probes: { term: ["sgr.bold"], lib: [], mux: [] },
    },
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
  })
  draft.subject = {
    kind: "term",
    id: "kitty",
    version: "1",
    os: "macos",
    osVersion: null,
    outerTerminal: null,
    mux: null,
    config: null,
    permissions: null,
  }
  draft.identity = "unverified"
  draft.measuredAt = attempt.startedAt
  draft.origin = { kind: "collector" }
  draft.results = [result]
  expect(finalizeCollectedDraft(draft as Parameters<typeof finalizeCollectedDraft>[0]).results[0]!.status).toBe(
    "probe-todo",
  )
})

// #31740: row-emission tests cannot pin whose reason the writer synthesizes when a callback forgets its rows.
// #32060 (@cto 32ad122f rule 1): a note the writer supplied outranks that default; only a noteless row takes it.
it("keeps the writer's note, and names the writer default only without one, when a callback omits its test rows", async () => {
  let next = 0
  const aligned = frames.map((frame) => ({ ...frame, regionRectangle: frames[0]!.regionRectangle }))
  const callback = await sgrCaptureFrames(
    { write() {}, capture: async () => aligned[next++]! } as unknown as TermProbeSource,
    "control",
    "target",
    "bold target",
    {},
    undefined,
    "normal control",
  )
  if (!callback.observation) throw new Error("Expected the existing captured visual-review observation")
  expect(callback.observation?.outcome).toBe("inconclusive")
  const { tests: _omitted, ...rowless } = callback
  const note = callback.observation.note
  if (!note) throw new Error("Expected the captured visual-review observation to carry its writer note")
  const result = record(rowless)
  expect(result).toMatchObject({
    status: "probe-invalid",
    reason: note,
    tests: [{ id: "criterion", status: "probe-invalid", reason: note }],
  })
  expect(result.frames).toEqual(aligned)
  const { note: _dropped, ...noteless } = callback.observation
  expect(record({ ...rowless, observation: noteless })).toMatchObject({
    status: "probe-invalid",
    reason: "writer default: inconclusive observation without test rows; callback defect",
    tests: [
      {
        id: "criterion",
        status: "probe-invalid",
        reason: "writer default: inconclusive observation without test rows; callback defect",
      },
    ],
  })
})

// #32246: a former source-negative review site no longer grades or reviews from source; the record is the PROBE TODO
// coverage record with no observation and no review branch, whatever its stated reason.
it("keeps a former source-review parser-state result as a PROBE TODO coverage record with no observation", () => {
  const sentence = "DECCARA not honoured, extent unobservable"
  const callback = parserStateResult(false, "DECCARA applies bold", { cells: [] }, undefined, sentence)
  expect(callback.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
  expect(callback.observation).toBeUndefined()
  expect(callback.criterionBranch).toBeUndefined()
  expect(callback.tests).toBeUndefined()
})

// The existing visual-review fixture does not exercise the measured, repairable locale prerequisite.
it("keeps measured 8-bit decoding as unmet UTF-8 prerequisite TODO without inventing a review", async () => {
  const callback = await utf8DecodingRefusal(
    { utf8Decoding: async () => "8-bit" } as unknown as TermProbeSource,
    "sgr.bold",
  )
  if (!callback) throw new Error("Expected measured 8-bit prerequisite")
  const result = record(callback)
  expect(result.status).toBe("probe-todo")
  expect(result.criterionBranch).toBe("utf8-prerequisite")
  expect(result.tests).toEqual([
    expect.objectContaining({ id: "utf8-context", status: "probe-todo", attempt: { scope: "none" } }),
  ])
  expect(result.tests.some((check) => check.id === "review")).toBe(false)
})

it("records adapted C154 semantic-mark callback outcomes as TODO or FAILURE with rawReplyRef and no unreviewed Untestable", async () => {
  const osc133a = extensionsProbes.find((entry) => entry.id === "extensions.osc133-a")
  if (!osc133a?.term) throw new Error("Expected extensions.osc133-a app callback")
  const recordC154 = (callback: ProbeCallbackResult) =>
    recordExecutedProbe({
      featureId: osc133a.id,
      attempt,
      rawReplyRef: osc133a.id,
      ...(callback.observation && {
        observation: { ...callback.observation, featureId: osc133a.id, rawReplyRef: osc133a.id },
      }),
      ...(callback.notTested && {
        coverage: { featureId: osc133a.id, ...callback.notTested, rawReplyRef: osc133a.id },
      }),
      tests: callback.tests,
      criterionBranch: callback.criterionBranch,
      assertions: [],
    })

  // 1. Consumed-but-unqualified (home 1;1 -> target 1;2 -> control 1;2) stays PROBE TODO, never Unsupported or Untestable.
  const unqualifiedReads = [
    { row: 1, col: 1 },
    { row: 1, col: 2 },
    { row: 1, col: 2 },
  ]
  let unqualifiedIndex = 0
  const unqualifiedCallback = await osc133a.term({
    write() {},
    queryCursorPosition: async () => unqualifiedReads[unqualifiedIndex++] ?? null,
  } as unknown as TermProbeSource)
  const unqualifiedRecorded = recordC154(unqualifiedCallback)
  expect(unqualifiedRecorded.status).toBe("probe-todo")
  expect(unqualifiedRecorded.assertionType).toBeUndefined()
  expect(unqualifiedRecorded.rawReplyRef).toBe("extensions.osc133-a")
  expect(unqualifiedRecorded.tests).toEqual([
    expect.objectContaining({
      id: "criterion",
      status: "probe-todo",
      attempt: { scope: "none" },
      rawReplyRef: "extensions.osc133-a",
    }),
  ])

  // 2. Null CPR reply records PROBE INVALID with query evidence and rawReplyRef, never Unsupported or Untestable.
  const nullCallback = await osc133a.term({
    write() {},
    queryCursorPosition: async () => null,
  } as unknown as TermProbeSource)
  const nullRecorded = recordC154(nullCallback)
  expect(nullRecorded.status).toBe("probe-invalid")
  expect(nullRecorded.assertionType).toBeUndefined()
  expect(nullRecorded.rawReplyRef).toBe("extensions.osc133-a")
  expect(nullRecorded.reason).toBe("No cursor reply after semantic prompt marker")
  expect(nullRecorded.tests).toEqual([
    expect.objectContaining({
      id: "criterion",
      status: "probe-invalid",
      attempt,
      rawReplyRef: "extensions.osc133-a",
      reason: "No cursor reply after semantic prompt marker",
    }),
  ])

  // 3. Qualified home/target/control sequence emits no-semantic-observable coverage, which records as PROBE TODO
  // (never automatic Untestable without a downstream resolved reviewRef).
  const qualifiedReads = [
    { row: 1, col: 1 },
    { row: 1, col: 2 },
    { row: 1, col: 1 },
  ]
  let qualifiedIndex = 0
  const qualifiedCallback = await osc133a.term({
    write() {},
    queryCursorPosition: async () => qualifiedReads[qualifiedIndex++] ?? null,
  } as unknown as TermProbeSource)
  expect(qualifiedCallback.notTested).toEqual({
    reason: "no-semantic-observable",
    noObservable: "OSC 133;A prompt-start mark registration",
  })
  const qualifiedRecorded = recordC154(qualifiedCallback)
  expect(qualifiedRecorded.status).toBe("probe-todo")
  expect(qualifiedRecorded.rawReplyRef).toBe("extensions.osc133-a")
  expect(qualifiedRecorded.reason).toBe("OSC 133;A prompt-start mark registration")
  expect(qualifiedRecorded.tests).toEqual([
    expect.objectContaining({
      id: "criterion",
      status: "probe-todo",
      attempt: { scope: "none" },
      rawReplyRef: "extensions.osc133-a",
      reason: "OSC 133;A prompt-start mark registration",
    }),
  ])
})

// Existing tests all supplied an observation or coverage. Execution-only callbacks must preserve
// their criterion facts without manufacturing either. Forward legacy pass to the real recorder
// so this case catches a future pass-based promotion instead of dropping the contradictory input.
it("records execution-only TODO and FAILURE tests, ignoring legacy pass even when true", () => {
  for (const status of ["probe-todo", "probe-invalid"] as const) {
    const callback = {
      pass: true,
      response: "retained callback state",
      tests: [{ id: "criterion", status, reason: "No deciding observable was retained" }],
    } satisfies ProbeCallbackResult
    const result = recordExecutedProbe({
      ...callback,
      featureId: "sgr.bold",
      attempt,
      rawReplyRef: "sgr.bold",
      assertions: [],
    })
    expect(result.status).toBe(status)
    expect(result.tests).toEqual([
      {
        id: "criterion",
        status,
        reason: "No deciding observable was retained",
        attempt: status === "probe-todo" ? { scope: "none" } : attempt,
        assertionRefs: [],
        rawReplyRef: "sgr.bold",
      },
    ])
    expect(result).not.toHaveProperty("assertionType")
  }
})

// Source identity was previously absent. The writer must name it rather than infer live or
// accept a trace with no retained artifact and capture identity.
it("starts schema 4 drafts with explicit live source and rejects an unbound trace", () => {
  const input = {
    runId: "source-boundary",
    sourceRevision: "1".repeat(40),
    source: { kind: "live" as const },
    intendedSubject: { kind: "term" as const, id: "kitty" },
    manifest: {
      schemaVersion: 4 as const,
      probeHash: "source-suite",
      adapterVersion: "4",
      catalogIds: ["sgr.bold"],
      probes: { term: ["sgr.bold"], lib: [], mux: [] },
    },
  }
  expect(initializeRunDraft(input)).toMatchObject({
    schemaVersion: 4,
    source: { kind: "live" },
    intendedSubject: { kind: "term", id: "kitty" },
  })
  expect(() => initializeRunDraft({ ...input, source: { kind: "trace" } } as never)).toThrow(/trace/i)
})

// A wall cut off the callback, so the harness has no reading of the terminal; grading the row
// probe-invalid would name a terminal failure that nobody measured (#33431).
it("grades a callback abandoned at its wall as probe-todo with the wall as its reason", () => {
  const result = recordExecutedProbe({
    featureId: "reset.ris",
    attempt: { scope: "probe", startedAt: "2026-11-11T06:00:00.000Z" },
    harnessOutcome: "probe-exceeded",
    assertions: [],
  })
  expect(result).toMatchObject({
    status: "probe-todo",
    harnessOutcome: "probe-exceeded",
    reason: "The callback exceeded its wall; the harness abandoned it before it recorded a result",
  })
  expect(result.tests).toEqual([expect.objectContaining({ id: "criterion", status: "probe-todo" })])
})

it("records an IncompleteReplay diagnostic as unfinished-calls", () => {
  const result = recordExecutedProbe({
    featureId: "sgr.reset",
    attempt: { scope: "probe", startedAt: "2026-10-21T05:00:00.000Z" },
    diagnostic: {
      kind: "collector-error",
      name: "IncompleteReplay",
      message: "Incomplete: call log has unfinished asynchronous calls",
    },
    assertions: [],
  })
  expect(result.harnessOutcome).toBe("unfinished-calls")
})
