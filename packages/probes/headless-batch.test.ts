/**
 * @failure Headless exceptions borrow an app marker, mismarked observations enter a graded batch, or a missing worker artifact is hidden by a stack line.
 * @level l1
 * @consumer Production headless batch collector
 * @reach imports headless-batch.ts and collect-headless.ts at the production backend/worker boundary
 * @testonly none
 */
/* oxlint-disable typescript/no-deprecated -- Exercise the production TerminalBackend adapter boundary. */
import { createXtermBackend } from "@termless/xtermjs"
import { createVtermBackend } from "@termless/vterm"
import { createWeztermBackend, loadWeztermNative } from "@termless/wezterm"
import { resolve as resolveLibvterm } from "@termless/libvterm"
import { resolve as resolveGhosttyWasm } from "@termless/ghostty"
import { resolve as resolveVt100 } from "@termless/vt100"
import { resolve as resolveVt220 } from "@termless/vt220"
import { createKittyBackend, isKittyAvailable } from "@termless/kitty"
import { createGhosttyNativeBackend, isGhosttyNativeAvailable } from "@termless/ghostty-native"
import { hasExtension, type EmulatorWarning, type OscMetadataExtension } from "@termless/core"
import {
  ALL_PROBES,
  SEMANTIC_PROMPT_SOURCE_REVIEW,
  HARNESS_INCOMPLETE_TEST,
  HEADLESS_OBSERVABLE_REVIEW,
  initializeRunDraft,
  type CapturedRunDraft,
  type ProbeCallbackResult,
  type ProbeDefinition,
  type LibProbeSource,
} from "@terminfo/probe-defs"
import { fakeProbeResult } from "@terminfo/probe-defs/testing/fake-probe-result"
import { regradeRow, satisfiesContract, type GroupContract } from "../probe-defs/src/testing/group-harness.ts"
import { validateObservation, parseRun } from "@terminfo/run-parser"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { collectBatch, createLibProbeSource, feedCapture } from "./headless-batch.ts"
import * as headlessIdentity from "./headless-identity.ts"
import { finalizeCollectedDraft } from "../terminfo.dev/src/capture-writer.ts"
import { cellWidthTransition } from "../probe-defs/src/helpers.ts"
import { ADAPTER_SOURCE_AUDITS, NO_SAME_PATH_CONTROL, replyFailure } from "../probe-defs/src/helpers.ts"
import retainedDeccolm from "./fixtures/deccolm-retained.json"

/** Feature captures only; collector qualification metadata is asserted in sentinel-member.test.ts. */
function probeReplies(batch: Awaited<ReturnType<typeof collectBatch>>) {
  const { "collector.replyPath": _qualification, ...replies } = batch.rawReplies
  return replies
}

async function backend() {
  return createXtermBackend()
}

// The collector must apply the registered library product declaration before its final checkpoint.
// Callback-only tests cannot catch losing that fact between the manifest and the recorded result.
// Kitty uses an explicitly labelled xterm parser fixture: this tests undeclared-target recording,
// not a Kitty execution, identity, rendering claim or capture.
test.each([
  { name: "xtermjs", create: backend, expected: "test-todo", reason: "visual effect not observed in this run" },
  { name: "vterm", create: async () => createVtermBackend(), expected: "supported", reason: undefined },
  {
    name: "kitty",
    create: backend,
    expected: "test-todo",
    reason: "rendering declaration missing for library kitty in @termless/core/backends.json",
  },
] as const)(
  "records $name SGR with its rendering declaration before checkpoint",
  async ({ name, create, expected, reason }) => {
    const definition = registryDefinitions(["sgr.bold"])[0]!
    const draft = {
      runId: "library-rendering-declaration-fixture",
      rawReplies: {},
      results: [
        { featureId: definition.id, status: "test-todo" as const, attempt: { scope: "none" as const }, tests: [] },
      ],
    }
    const checkpoints: string[] = []
    const batch = await collectBatch(create, name, [definition], draft, (value) => {
      checkpoints.push(value.results[0]!.status)
    })
    expect(batch.ungradedDiagnostics).toEqual({})
    expect(batch.results[0]!.status).toBe(expected)
    if (reason) expect(batch.results[0]!.reason).toBe(reason)
    expect(draft.results[0]!.status).toBe(expected)
    expect(checkpoints.at(-1)).toBe(expected)
    expect(batch.observations[0]).toMatchObject({
      featureId: definition.id,
      outcome: "supported",
      assertionType: "buffer_state",
    })
  },
)

// @failure A real collector source drops backend.name and turns the adapter-binding TODO into an undefined label.
// @consumer The registered six-mode callback through createLibProbeSource and canonical batch recording.
test("adapter-binding TODO names the initialized backend", async () => {
  const definition = registryDefinitions(["modes.synchronized-output"])[0]!
  const batch = await collectBatch(
    async () => {
      const value = createXtermBackend()
      vi.spyOn(value, "getMode").mockReturnValue(null)
      return value
    },
    "xtermjs",
    [definition],
  )
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.results).toMatchObject([
    { status: "test-todo", tests: [{ id: "criterion", reason: "adapter binding xterm syncOutput" }] },
  ])
  expect(batch.assertions).toEqual([])
})

function reflowEvidence(batch: Awaited<ReturnType<typeof collectBatch>>) {
  // F4: the real collector's mixed-polarity evidence must also survive the canonical reader.
  // This is explicitly unverified unit metadata, as in the existing DECCOLM reader fixture below;
  // it grants no engine attestation, captured-cut identity, admission or publication.
  const id = "extensions.reflow"
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "reflow-reader-fixture",
    adapterVersion: "fixture",
    catalogIds: [id],
    probes: { term: [], mux: [], lib: [id] },
  }
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "reflow-reader-fixture",
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "xtermjs" },
    manifest,
  })
  const captured: CapturedRunDraft = {
    ...draft,
    subject: {
      kind: "lib",
      id: "xtermjs",
      version: "fixture",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    runtimeIdentity: {
      kind: "js",
      engineVersion: "fixture",
      adapterVersion: "fixture",
      termlessRevision: "fixture",
      resolvedPath: "fixture/xtermjs",
      integrity: { kind: "registry", lockIntegrity: "fixture" },
      runtimeFormat: "js",
    },
    measuredAt: "2026-11-01T13:00:00.000Z",
    origin: { kind: "collector" },
    rawReplies: batch.rawReplies,
    results: batch.results,
    assertions: batch.assertions,
  }
  const parsed = parseRun(
    "reflow.capture.json",
    JSON.stringify(captured),
    manifest.catalogIds,
    new Map([[manifest.probeHash, manifest]]),
  )
  expect(parsed.results).toEqual(batch.results)
  return JSON.parse(batch.rawReplies["extensions.reflow"]!) as {
    declaredReflow: boolean
    phases: Array<{ outcome: string }>
    historyPhases: Array<{ id: string; status: string; outcome: string; reason: string }>
    alternatePhases: Array<{ id: string; status: string; outcome: string; reason: string }>
    alternateRoundtrips: Record<string, { roundtrip: { pass: boolean }; identity: Record<string, boolean | null> }>
    actions: Array<{ kind: string; text?: string; name?: string }>
    reads: Record<string, { cells: string[][]; scrollback: { totalLines: number; screenLines: number } }>
  }
}

function mainAndHistoryAssertions(batch: Awaited<ReturnType<typeof collectBatch>>) {
  return batch.assertions.filter(({ expected }) => expected.startsWith("main-") || expected.startsWith("history-"))
}

// @failure Four qualified main/history phases stay pending or an alternate negative vetoes ASCII reflow.
// CTO F4a/g: existing evidence-only assertions missed feature promotion and history-row reference ownership.
// @level l1
// @consumer Registered reflow callback through the real headless source and canonical batch result.
test.each([false, true])("production reflow controls ignore the capability declaration (%s)", async (declared) => {
  const definition = registryDefinitions(["extensions.reflow"])[0]!
  const batch = await collectBatch(
    async () => {
      const value = createXtermBackend()
      // Vary metadata alone; the actual engine keeps its default configuration.
      const capabilities = { ...value.capabilities, reflow: declared }
      Object.defineProperty(value, "capabilities", { get: () => capabilities })
      return value
    },
    "xtermjs",
    [
      {
        ...definition,
        lib(ctx: LibProbeSource) {
          // Every production source uses this factory, independently of declared feature support.
          expect(ctx).toHaveProperty("resize", expect.any(Function))
          return definition.lib!(ctx)
        },
      },
    ],
  )
  expect(batch.ungradedDiagnostics).toEqual({})
  // @failure Alternate reflow measurements never reach the real collector; existing main/history checks cannot detect that gap.
  // @consumer CTO-approved alternate-only evidence, kept outside the required-test fold.
  expect(reflowEvidence(batch).alternatePhases).toMatchObject([
    { id: "alternate-grow", status: "unsupported", outcome: "preserved-wraps" },
    { id: "alternate-shrink", status: "unsupported", outcome: "truncated" },
  ])
  expect(batch.assertions.filter(({ expected }) => expected.startsWith("alternate-")).map(({ kind }) => kind)).toEqual([
    "negative",
    "negative",
  ])
  const alternate = reflowEvidence(batch)
  for (const { id } of alternate.alternatePhases) {
    expect(alternate.alternateRoundtrips[id]).toMatchObject({
      roundtrip: { pass: true },
      identity: { before: false, entered: true, target: true, control: true, restored: false, after: false },
    })
    const target = alternate.actions.findIndex((action) => action.kind === "read" && action.name === `${id}.after`)
    const control = alternate.actions.findIndex(
      (action) => action.kind === "read" && action.name === `${id}.control-after`,
    )
    expect(target).toBeGreaterThanOrEqual(0)
    expect(control).toBeGreaterThan(target)
    const sameState = alternate.actions.slice(target + 1, control)
    expect(sameState.some((action) => action.kind === "reset" || action.kind === "resize")).toBe(false)
    expect(sameState.some((action) => /\x1b\[\?1049[hl]/.test(action.text ?? ""))).toBe(false)
  }
  expect(batch.results).toMatchObject([
    {
      featureId: "extensions.reflow",
      status: "supported",
      reason: expect.stringContaining(
        "ASCII reflow measured on main screen and retained history; wide characters, cursor on a wrapped line and terminal-app resize unmeasured",
      ),
      assertionType: "buffer_state",
      tests: expect.arrayContaining([
        expect.objectContaining({ id: "main-grow", status: "supported" }),
        expect.objectContaining({ id: "main-shrink", status: "supported" }),
        expect.objectContaining({ id: "history-grow", status: "supported" }),
        expect.objectContaining({ id: "history-shrink", status: "supported" }),
      ]),
    },
  ])
  expect(batch.results[0]!.reason).toContain("reported, not graded")
  // F4g: checking status alone misses default-all references and references borrowed from another phase.
  expect(batch.results[0]!.tests.map(({ id }) => id)).toEqual([
    "main-grow",
    "main-shrink",
    "history-grow",
    "history-shrink",
  ])
  for (const row of batch.results[0]!.tests) {
    expect(row.assertionRefs).toHaveLength(1)
    expect(row.assertionRefs!.map((index) => batch.assertions[index]!.expected.split(":")[0])).toEqual([row.id])
  }
  expect(mainAndHistoryAssertions(batch)).toMatchObject([
    { kind: "positive", assertionType: "buffer_state", observed: batch.rawReplies["extensions.reflow"] },
    { kind: "positive", assertionType: "buffer_state", observed: batch.rawReplies["extensions.reflow"] },
    { kind: "positive", assertionType: "buffer_state", observed: batch.rawReplies["extensions.reflow"] },
    { kind: "positive", assertionType: "buffer_state", observed: batch.rawReplies["extensions.reflow"] },
  ])
  const observed = reflowEvidence(batch)
  expect(observed).toMatchObject({ declaredReflow: declared, phases: [{ outcome: "reflow" }, { outcome: "reflow" }] })
  // Main-only coverage cannot detect lost history or hard-line boundaries. Check the actual full
  // buffer, including every hard witness, independently of the required-test fold.
  expect(observed.historyPhases).toMatchObject([
    { id: "history-grow", outcome: "reflow", status: "supported" },
    { id: "history-shrink", outcome: "reflow", status: "supported" },
  ])
  for (const id of ["history-grow", "history-shrink"]) {
    const before = observed.reads[`${id}.before`]!
    const after = observed.reads[`${id}.after`]!
    expect(before.scrollback.totalLines - before.scrollback.screenLines).toBeGreaterThan(4)
    expect(after.cells).toHaveLength(after.scrollback.totalLines)
    const lines = after.cells.map((row: string[]) => row.join("").trimEnd())
    expect(lines.slice(0, id === "history-grow" ? 3 : 4)).toEqual(
      id === "history-grow"
        ? ["ABCDEFGHIJKLMNOPQR", "HARD-a", "HARD-b"]
        : ["ABCDEFGHIJKL", "MNOPQR", "HARD-a", "HARD-b"],
    )
    expect(lines.slice(-48)).toEqual(Array.from({ length: 48 }, (_, i) => `R${String(i).padStart(3, "0")}`))
  }
})

// @failure A genuine non-reflowing engine truncates on shrink and is mislabeled as a broken probe.
// @level l1
// @consumer Real collector phase rows and the required-test fold; xterm-only cases miss this negative.
// CTO F4d: a measured main negative cannot skip missing history; the old placeholders hid that precedence.
test.each([
  ["vt100", resolveVt100],
  ["libvterm", resolveLibvterm],
] as const)("reflow retains measured truncation on %s without failing the feature", async (name, producer) => {
  const batch = await collectBatch(producer, name, registryDefinitions(["extensions.reflow"]))
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.results).toMatchObject([
    {
      featureId: "extensions.reflow",
      status: name === "libvterm" ? "test-todo" : "unsupported",
      reason: expect.stringContaining("main-grow"),
      tests: expect.arrayContaining([
        // libvterm keeps its default reflow option off; these are internal observations, not a final grade.
        expect.objectContaining({ id: "main-grow", status: "unsupported" }),
        expect.objectContaining({ id: "main-shrink", status: "unsupported" }),
        ...["history-grow", "history-shrink"].map((id) =>
          expect.objectContaining({
            id,
            status: name === "libvterm" ? "test-todo" : "unsupported",
            ...(name === "libvterm" && { reason: "engine retained no history", assertionRefs: [] }),
          }),
        ),
      ]),
    },
  ])
  expect(batch.results[0]!.reason).toContain("main-shrink")
  expect(reflowEvidence(batch)).toMatchObject({
    phases: [{ outcome: "preserved-wraps" }, { outcome: "truncated" }],
  })
  expect(
    batch.assertions.filter((assertion) => assertion.expected.startsWith("main-")).map((assertion) => assertion.kind),
  ).toEqual(["negative", "negative"])
  const history = reflowEvidence(batch).historyPhases
  if (name === "libvterm") {
    expect(history).toMatchObject([
      { status: "test-todo", reason: "engine retained no history" },
      { status: "test-todo", reason: "engine retained no history" },
    ])
    expect(mainAndHistoryAssertions(batch)).toHaveLength(2)
  } else {
    expect(history).toMatchObject([
      { outcome: "preserved-wraps", status: "unsupported" },
      { outcome: "truncated", status: "unsupported" },
    ])
    expect(batch.assertions.map((assertion) => assertion.kind)).toEqual([
      "negative",
      "negative",
      "negative",
      "negative",
    ])
    const observed = reflowEvidence(batch)
    for (const id of ["history-grow", "history-shrink"]) {
      const after = observed.reads[`${id}.after`]!
      const lines = after.cells.map((row: string[]) => row.join("").trimEnd())
      expect(lines.slice(0, id === "history-grow" ? 4 : 3)).toEqual(
        id === "history-grow" ? ["ABCDEFGHIJKL", "MNOPQR", "HARD-a", "HARD-b"] : ["ABCDEFGHIJKL", "HARD-a", "HARD-b"],
      )
      expect(lines.slice(-48)).toEqual(Array.from({ length: 48 }, (_, i) => `R${String(i).padStart(3, "0")}`))
    }
  }
})

// @failure A bounded retention limit is called Unsupported instead of naming unavailable target rows.
// @level l1
// @consumer Real xterm retained-buffer limits through the canonical collector.
// CTO F4c: a corrupt short tail must fail the feature; existing coverage only checked its raw phase failure.
test.each([
  { limit: 2, corrupt: false },
  { limit: 8, corrupt: false },
  { limit: 8, corrupt: true },
])("reflow names only a coherent partially retained target as unavailable (%j)", async ({ limit, corrupt }) => {
  const definition = registryDefinitions(["extensions.reflow"])[0]!
  const batch = await collectBatch(
    async () => {
      const value = createXtermBackend()
      const init = value.init.bind(value)
      value.init = (options) => init({ ...options, scrollbackLimit: limit })
      return value
    },
    "xtermjs",
    [
      {
        ...definition,
        lib(ctx) {
          if (corrupt) {
            const cell = ctx.getCell.bind(ctx)
            ctx.getCell = (row, col) => {
              const value = cell(row, col)
              return col === 0 && value.char === "R" ? { ...value, char: "X" } : value
            }
          }
          return definition.lib!(ctx)
        },
      },
    ],
  )
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.results[0]!.status).toBe(corrupt ? "test-failure" : "test-todo")
  expect(mainAndHistoryAssertions(batch)).toHaveLength(2)
  expect(reflowEvidence(batch).historyPhases).toMatchObject(
    corrupt
      ? [
          { status: "test-failure", reason: expect.stringContaining("does not match the fed tail") },
          { status: "test-failure", reason: expect.stringContaining("does not match the fed tail") },
        ]
      : [
          { status: "test-todo", reason: `target not fully retained (H=${limit}, need 28)` },
          { status: "test-todo", reason: `target not fully retained (H=${limit}, need 27)` },
        ],
  )
})

// @failure History corruption or an invalid control becomes a negative; huge counts trigger unbounded reads;
// a viewport position prevents an otherwise complete absolute-buffer measurement.
// @level l1
// @consumer Registered callback with real xterm effects and source-boundary faults.
// CTO F4c: required history failures beat positive main phases; the prior test required aggregate TODO.
test.each(["witness-loss", "width-control", "bad-counts", "control-counts", "viewport"] as const)(
  "history reflow folds qualified required evidence for %s",
  async (fault) => {
    const definition = registryDefinitions(["extensions.reflow"])[0]!
    const batch = await collectBatch(backend, "xtermjs", [
      {
        ...definition,
        lib(ctx) {
          const feed = ctx.feed.bind(ctx)
          const resize = ctx.resize!.bind(ctx)
          const reset = ctx.reset.bind(ctx)
          const cell = ctx.getCell.bind(ctx)
          const scrollback = ctx.getScrollback.bind(ctx)
          let seeded = false
          let resized = false
          let control = false
          ctx.feed = (text) => {
            if (text.includes("\r\nR000")) seeded = true
            if (seeded && resized && text.startsWith("W")) {
              control = true
              if (fault === "width-control") text = text.slice(0, -1)
            }
            feed(text)
          }
          ctx.resize = (cols, rows) => {
            resize(cols, rows)
            if (seeded) resized = true
          }
          ctx.reset = () => {
            reset()
            seeded = false
            resized = false
            control = false
          }
          ctx.getScrollback = () => {
            const value = scrollback()
            if (seeded && (fault === "bad-counts" || (fault === "control-counts" && control))) {
              return { ...value, totalLines: Number.MAX_SAFE_INTEGER }
            }
            if (seeded && fault === "viewport") return { ...value, viewportOffset: 1, viewportTop: 1 }
            return value
          }
          ctx.getCell = (row, col) => {
            if (seeded && fault === "bad-counts") throw new Error("Unbounded history read attempted")
            const value = cell(row, col)
            return seeded && resized && !control && fault === "witness-loss" && value.char === "R" && col === 0
              ? { ...value, char: "X" }
              : value
          }
          return definition.lib!(ctx)
        },
      },
    ])
    expect(batch.ungradedDiagnostics).toEqual({})
    expect(batch.results[0]!.status).toBe(fault === "viewport" ? "supported" : "test-failure")
    const observed = reflowEvidence(batch)
    expect(observed.historyPhases.map((phase: { status: string }) => phase.status)).toEqual(
      fault === "viewport" ? ["supported", "supported"] : ["test-failure", "test-failure"],
    )
    expect(mainAndHistoryAssertions(batch)).toHaveLength(fault === "viewport" ? 4 : 2)
    if (fault === "bad-counts" || fault === "control-counts") {
      expect(observed.historyPhases[0]!.reason).toContain("totalLines=9007199254740991")
      expect(
        observed.reads[fault === "bad-counts" ? "history-grow.before" : "history-grow.control-after"]!.cells,
      ).toEqual([])
    }
    if (fault === "witness-loss") {
      expect(observed.historyPhases[0]!.reason).toContain("neither complete retained layout")
    }
    if (fault === "width-control") {
      expect(observed.historyPhases[0]!.reason).toContain("Post-resize width control")
    }
  },
)

// @failure Engines whose primary-screen ED 2 (\x1b[2J) scrolls cleared rows into scrollback (alacritty_terminal 0.26)
// fail main-screen width controls, exceed the history-shrink post-resize readBound, and fail alternate 1049 isolation.
// @level l1
// @consumer Registered reflow callback through an ED 2 scrollback-retaining engine.
test("reflow qualifies main, history, and alternate phases when primary ED 2 scrolls into scrollback unless ED 3 follows", async () => {
  const definition = registryDefinitions(["extensions.reflow"])[0]!
  const batch = await collectBatch(backend, "xtermjs", [
    {
      ...definition,
      lib(ctx) {
        const feed = ctx.feed.bind(ctx)
        const resize = ctx.resize!.bind(ctx)
        const scrollback = ctx.getScrollback.bind(ctx)
        const cell = ctx.getCell.bind(ctx)
        let mainShrinkAfter = false
        ctx.feed = (text) => {
          mainShrinkAfter = false
          const entersAlt = text.includes("\x1b[?1049h")
          const leavesAlt = text.includes("\x1b[?1049l")
          const onPrimary = !entersAlt && (leavesAlt || !ctx.getMode("altScreen"))
          if (onPrimary && text.includes("\x1b[2J")) {
            const { y, x } = ctx.getCursor()
            const { screenLines } = scrollback()
            const scroll = `\x1b[${screenLines};1H${"\n".repeat(y + 1)}\x1b[${y + 1};${x + 1}H\x1b[2J`
            feed(text.replace("\x1b[2J", scroll))
            return
          }
          feed(text)
        }
        ctx.resize = (cols, rows) => {
          const before = scrollback()
          resize(cols, rows)
          if (!ctx.getMode("altScreen") && cols === 12 && before.totalLines === rows) {
            mainShrinkAfter = true
          }
        }
        ctx.getScrollback = () => {
          const state = scrollback()
          if (mainShrinkAfter && state.totalLines === state.screenLines && cell(0, 0).char === "A") {
            return { ...state, totalLines: state.screenLines + 1, viewportOffset: 1 }
          }
          return state
        }
        ctx.getCell = (row, col) => {
          if (mainShrinkAfter && row === scrollback().screenLines) {
            return { ...cell(0, 0), char: " ", wide: false }
          }
          return cell(row, col)
        }
        return definition.lib!(ctx)
      },
    },
  ])
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.results).toMatchObject([
    {
      featureId: "extensions.reflow",
      status: "supported",
      tests: [
        expect.objectContaining({ id: "main-grow", status: "supported" }),
        expect.objectContaining({ id: "main-shrink", status: "supported" }),
        expect.objectContaining({ id: "history-grow", status: "supported" }),
        expect.objectContaining({ id: "history-shrink", status: "supported" }),
      ],
    },
  ])
  expect(reflowEvidence(batch).alternatePhases).toMatchObject([
    { id: "alternate-grow", status: "unsupported", outcome: "preserved-wraps" },
    { id: "alternate-shrink", status: "unsupported", outcome: "truncated" },
  ])
})

// @failure Qualified alternate positives are omitted, or their polarity is folded against another buffer.
// @level l1
// @consumer Actual vterm alternate resize/readback; the xterm case above supplies complete physical negatives.
// CTO F4b: main positive/history negative is an engine limit, not a cross-buffer failure or perpetual TODO.
test("alternate reflow records real vterm logical layouts without cross-buffer grading", async () => {
  const batch = await collectBatch(
    async () => createVtermBackend(),
    "vterm",
    registryDefinitions(["extensions.reflow"]),
  )
  expect(batch.ungradedDiagnostics).toEqual({})
  const observed = reflowEvidence(batch)
  expect(observed.alternatePhases).toMatchObject([
    { id: "alternate-grow", status: "supported", outcome: "reflow" },
    { id: "alternate-shrink", status: "supported", outcome: "reflow" },
  ])
  const rows = (name: string, count: number) =>
    observed.reads[name]!.cells.slice(0, count).map((row) => row.join("").trimEnd())
  expect(rows("alternate-grow.before", 4)).toEqual(["ABCDEFGHIJKL", "MNOPQR", "HARD-a", "HARD-b"])
  expect(rows("alternate-grow.after", 3)).toEqual(["ABCDEFGHIJKLMNOPQR", "HARD-a", "HARD-b"])
  expect(rows("alternate-shrink.before", 3)).toEqual(["ABCDEFGHIJKLMNOPQR", "HARD-a", "HARD-b"])
  expect(rows("alternate-shrink.after", 4)).toEqual(["ABCDEFGHIJKL", "MNOPQR", "HARD-a", "HARD-b"])
  expect(batch.assertions.filter(({ expected }) => expected.startsWith("alternate-")).map(({ kind }) => kind)).toEqual([
    "positive",
    "positive",
  ])
  expect(batch.assertions.filter(({ expected }) => expected.startsWith("history-")).map(({ kind }) => kind)).toEqual([
    "negative",
    "negative",
  ])
  expect(batch.results[0]!.status).toBe("unsupported")
  expect(batch.results[0]!.reason).toContain("history-grow")
  expect(batch.results[0]!.reason).toContain("history-shrink")
  expect(batch.results[0]!.tests.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: "main-grow", status: "supported" },
    { id: "main-shrink", status: "supported" },
    { id: "history-grow", status: "unsupported" },
    { id: "history-shrink", status: "unsupported" },
  ])
})

// @failure An unqualified alternate buffer or corrupt target/control becomes a reflow assertion.
// @level l1
// @consumer Alternate-only raw evidence through the registered callback and production source.
// Existing main/history tests never enter alternate; mode tests never resize its target.
// CTO F4e: invalid alternate evidence remains reported but cannot veto four qualified graded phases.
// Prior aggregate TODO assertions could not detect an accidental alternate-failure fold.
// F2/F3: require the deciding reason; setup failures must stay invalid even when mode identity
// is false or unavailable. Status-only cases miss a removed identity check or the wrong failing control.
test.each([
  { fault: "missing-mode", status: "test-todo", reason: "alternate buffer identity unavailable" },
  { fault: "target-mode-missing", status: "test-todo", reason: "alternate buffer identity unavailable" },
  { fault: "no-entry", status: "test-todo", reason: "alternate buffer not entered" },
  {
    fault: "bogus-mode",
    status: "test-failure",
    reason: expect.stringContaining("did not clear the seeded primary spans"),
  },
  {
    fault: "hard-row",
    status: "test-failure",
    reason: "Alternate resize matched neither complete layout, including hard rows and blank tails",
  },
  {
    fault: "blank-tail",
    status: "test-failure",
    reason: "Alternate resize matched neither complete layout, including hard rows and blank tails",
  },
  {
    fault: "control-switch",
    status: "test-failure",
    reason: "Post-resize alternate width control did not wrap at the requested column",
  },
  {
    fault: "control-identity",
    status: "test-failure",
    reason: "Alternate buffer identity changed during target or width-control readback",
  },
  { fault: "slot-read", status: "test-failure", reason: "Alternate measurement failed: alternate slot read failed" },
  { fault: "restore", status: "test-failure", reason: expect.stringContaining("PRIMARY-A not restored") },
  {
    fault: "marker-missing-false",
    status: "test-failure",
    reason: "Alternate isolation did not qualify: Alternate marker was not measured",
  },
  {
    fault: "marker-readback-false",
    status: "test-failure",
    reason: "Alternate isolation did not qualify: Alternate-marker readback failed",
  },
  {
    fault: "marker-missing-null",
    status: "test-failure",
    reason: "Alternate isolation did not qualify: Alternate marker was not measured",
  },
  {
    fault: "marker-readback-null",
    status: "test-failure",
    reason: "Alternate isolation did not qualify: Alternate-marker readback failed",
  },
] as const)(
  "alternate reflow qualifies identity and complete target evidence (%s)",
  async ({ fault, status, ...row }) => {
    const definition = registryDefinitions(["extensions.reflow"])[0]!
    const batch = await collectBatch(backend, "xtermjs", [
      {
        ...definition,
        lib(ctx) {
          const feed = ctx.feed.bind(ctx)
          const resize = ctx.resize!.bind(ctx)
          const reset = ctx.reset.bind(ctx)
          const mode = ctx.getMode.bind(ctx)
          const cell = ctx.getCell.bind(ctx)
          let entered = false
          let seeded = false
          let resized = false
          let control = false
          let marker = false
          ctx.getMode = (name) => {
            if (name === "altScreen" && fault.endsWith("-false")) return false
            if (name === "altScreen" && fault.endsWith("-null")) return null
            if (name === "altScreen" && fault === "missing-mode") return null
            if (name === "altScreen" && fault === "target-mode-missing" && seeded && resized && !control) return null
            if (name === "altScreen" && fault === "bogus-mode") return entered
            if (name === "altScreen" && fault === "control-identity" && control) return false
            return mode(name)
          }
          ctx.feed = (text) => {
            if (text.includes("ALT-MARK")) marker = true
            if (text.includes("\x1b[?1049h")) {
              entered = true
              if (fault === "no-entry" || fault === "bogus-mode") return
            }
            if (mode("altScreen") === true && text.includes("ABCDEFGHIJKLMNOPQR")) seeded = true
            if (seeded && resized && text.startsWith("W")) {
              control = true
              if (fault === "control-switch") feed("\x1b[?1049l")
            }
            feed(text)
          }
          ctx.resize = (cols, rows) => {
            resize(cols, rows)
            if (seeded && mode("altScreen") === true) resized = true
          }
          ctx.reset = () => {
            reset()
            entered = seeded = resized = control = marker = false
          }
          ctx.getCell = (r, c) => {
            if (marker && fault.startsWith("marker-readback-")) throw new Error("alternate marker readback failed")
            if (seeded && mode("altScreen") === true && fault === "slot-read") {
              throw new Error("alternate slot read failed")
            }
            const value = cell(r, c)
            if (marker && fault.startsWith("marker-missing-") && r === 0 && c === 0) return { ...value, char: "X" }
            if (fault === "restore" && entered && seeded && mode("altScreen") === false && r === 0 && c === 0) {
              return { ...value, char: "X" }
            }
            const corrupt =
              seeded &&
              resized &&
              !control &&
              mode("altScreen") === true &&
              c === 0 &&
              ((fault === "hard-row" && r === 2) || (fault === "blank-tail" && r === 23))
            return corrupt ? { ...value, char: "X" } : value
          }
          return definition.lib!(ctx)
        },
      },
    ])
    expect(batch.ungradedDiagnostics).toEqual({})
    expect(batch.results[0]!.status).toBe("supported")
    expect(batch.results[0]!.reason).toContain("reported, not graded")
    expect(batch.results[0]!.tests.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "main-grow", status: "supported" },
      { id: "main-shrink", status: "supported" },
      { id: "history-grow", status: "supported" },
      { id: "history-shrink", status: "supported" },
    ])
    const phases = reflowEvidence(batch).alternatePhases
    expect(phases.map((phase) => phase.status)).toEqual([status, status])
    expect(phases.map((phase) => phase.reason)).toEqual([row.reason, row.reason])
    expect(batch.assertions.filter(({ expected }) => expected.startsWith("alternate-"))).toEqual([])
    expect(mainAndHistoryAssertions(batch)).toHaveLength(4)
  },
)

// @failure A no-op resize, discarded wrap boundaries or lost characters become reflow support.
// @level l1
// @consumer Reflow criterion and canonical required-test fold.
test.each(["no-op", "hard-boundary", "content-loss", "cursor-on-target"] as const)(
  "reflow retains a named failure for %s",
  async (fault) => {
    const batch = await collectBatch(
      async () => {
        const value = createXtermBackend()
        const resize = value.resize.bind(value)
        if (fault === "cursor-on-target") {
          const getCursor = value.getCursor.bind(value)
          value.getCursor = () => ({ ...getCursor(), x: 0, y: 0 })
        }
        value.resize = (cols, rows) => {
          if (fault === "no-op") return
          // Fault injection at the engine boundary: LF removes the old continuation without changing
          // its characters; ECH instead removes a target character. Neither is a test-only emulator.
          if (fault === "hard-boundary" && cols === 20) value.feed(new TextEncoder().encode("\x1b[H\n"))
          resize(cols, rows)
          if (fault === "content-loss" && cols === 20) value.feed(new TextEncoder().encode("\x1b[H\x1b[X"))
        }
        return value
      },
      "xtermjs",
      registryDefinitions(["extensions.reflow"]),
    )
    expect(batch.ungradedDiagnostics).toEqual({})
    expect(batch.results[0]!.status).toBe("test-failure")
    expect(batch.results[0]!.reason).toContain("main-grow:")
    const observed = reflowEvidence(batch)
    if (fault === "hard-boundary") {
      expect(observed).toMatchObject({ phases: [{ outcome: "preserved-wraps" }, { outcome: "reflow" }] })
      expect(
        batch.assertions
          .filter((assertion) => assertion.expected.startsWith("main-"))
          .map((assertion) => assertion.kind),
      ).toEqual(["negative", "positive"])
      expect(batch.results[0]!.tests).toContainEqual(
        expect.objectContaining({ id: "criterion", status: "test-failure", assertionRefs: [0, 1] }),
      )
    } else {
      expect(observed).toMatchObject({
        phases:
          fault === "no-op" || fault === "cursor-on-target"
            ? [{ outcome: "invalid" }, { outcome: "invalid" }]
            : [{ outcome: "invalid" }, { outcome: "reflow" }],
      })
      expect(mainAndHistoryAssertions(batch).every((assertion) => assertion.kind === "positive")).toBe(true)
      if (fault === "no-op" || fault === "cursor-on-target") {
        // Invalid main phases have no own assertion; history/alternate evidence cannot stand in for one.
        expect(batch.results[0]!.tests.slice(0, 2).map((row) => row.assertionRefs)).toEqual([[], []])
      }
    }
  },
)

// @failure A slot error is lost when measured/final leaves or later geometry/reset cleanup also fail.
// @level l1
// @consumer Approved shared alternate lifetime plus outer reflow cleanup; earlier tests cover only main/history errors.
test.each([false, true])("alternate reflow retains slot and cleanup causes (leave fails=%s)", (failExit) => {
  const value = createXtermBackend()
  value.init({ cols: 80, rows: 24 })
  const source = createLibProbeSource(value, undefined, undefined, undefined)
  const slotError = new Error("alternate slot read failed")
  const widthError = new Error("alternate width restoration failed")
  const resetError = new Error("alternate reset failed")
  const exitErrors: Error[] = []
  const feed = source.feed.bind(source)
  const cell = source.getCell.bind(source)
  const resize = source.resize!.bind(source)
  const reset = source.reset.bind(source)
  let seeded = false
  let poisoned = false
  let restoring = false
  let resetAttempted = false
  source.feed = (text) => {
    if (poisoned && failExit && text.includes("\x1b[?1049l")) {
      const error = new Error(`alternate exit failure ${exitErrors.length + 1}`)
      exitErrors.push(error)
      throw error
    }
    if (value.getMode("altScreen") === true && text.includes("ABCDEFGHIJKLMNOPQR")) seeded = true
    feed(text)
  }
  source.getCell = (row, col) => {
    if (seeded && value.getMode("altScreen") === true) {
      poisoned = true
      throw slotError
    }
    return cell(row, col)
  }
  source.resize = (cols, rows) => {
    if (cols === 80) {
      restoring = true
      throw widthError
    }
    resize(cols, rows)
  }
  source.reset = () => {
    if (restoring) {
      resetAttempted = true
      throw resetError
    }
    reset()
    seeded = false
  }
  try {
    let caught: unknown
    try {
      registryDefinitions(["extensions.reflow"])[0]!.lib!(source)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect(restoring).toBe(true)
    expect(resetAttempted).toBe(true)
    if (failExit) expect(exitErrors.length).toBeGreaterThanOrEqual(3)
    const retained = new Set<unknown>()
    const visit = (error: unknown) => {
      if (retained.has(error)) return
      retained.add(error)
      if (error instanceof AggregateError) for (const nested of error.errors) visit(nested)
      if (error instanceof Error && error.cause !== undefined) visit(error.cause)
    }
    visit(caught)
    for (const error of [slotError, ...exitErrors, widthError, resetError]) {
      expect(retained.has(error), error.message).toBe(true)
    }
  } finally {
    value.destroy()
  }
})

// @failure A failed cell read leaks resized state, or restoration failure skips reset and masks causes.
// @level l1
// @consumer Disposable reflow source lifetime, including diagnostic callers.
test.each([
  { failCleanup: false, history: false },
  { failCleanup: true, history: false },
  { failCleanup: false, history: true },
  { failCleanup: true, history: true },
])("reflow restores geometry and attempts reset after a read error (%j)", ({ failCleanup, history }) => {
  const value = createXtermBackend()
  value.init({ cols: 80, rows: 24 })
  const source = createLibProbeSource(value, undefined, undefined, undefined)
  const readError = new Error("cell read failed")
  const resizeError = new Error("geometry restoration failed")
  const resetError = new Error("source reset failed")
  const resize = source.resize!.bind(source)
  const reset = source.reset.bind(source)
  const feed = source.feed.bind(source)
  const cell = source.getCell.bind(source)
  let historySeeded = false
  let cleaning = false
  let resetAttempted = false
  source.feed = (text) => {
    if (text.includes("\r\nR000")) historySeeded = true
    feed(text)
  }
  source.getCell = (row, col) => {
    if (!history || historySeeded) throw readError
    return cell(row, col)
  }
  source.resize = (cols, rows) => {
    if (cols === 80) cleaning = true
    if (failCleanup && cols === 80) throw resizeError
    resize(cols, rows)
  }
  source.reset = () => {
    if (cleaning) resetAttempted = true
    if (failCleanup && cleaning) throw resetError
    reset()
    historySeeded = false
  }
  try {
    let caught: unknown
    try {
      registryDefinitions(["extensions.reflow"])[0]!.lib!(source)
    } catch (error) {
      caught = error
    }
    expect(resetAttempted).toBe(true)
    if (failCleanup) {
      expect(caught).toBeInstanceOf(AggregateError)
      expect((caught as AggregateError).errors).toEqual([readError, resizeError, resetError])
    } else {
      expect(caught).toBe(readError)
      expect(value.getRow(0)).toHaveLength(80)
      expect(value.getText().trim()).toBe("")
    }
  } finally {
    value.destroy()
  }
})

// @failure Engine metadata is lost between the real adapter, source constructor and registered callbacks.
// @level l1
// @consumer Private headless OSC7 cwd and OSC9 notification measurements.
test("real vterm metadata reaches both registered callbacks and the batch producer", async (context) => {
  const sibling = fileURLToPath(new URL("../../../termless/packages/vterm/src/backend.ts", import.meta.url))
  if (!existsSync(sibling)) context.skip(`Real-vterm metadata producer requires missing sibling ${sibling}`)
  const ids = ["extensions.osc7-cwd", "extensions.notifications"]
  const value = createVtermBackend({ cols: 80, rows: 24 })
  try {
    expect(hasExtension(value, "osc-metadata")).toBe(true)
    if (!hasExtension<OscMetadataExtension>(value, "osc-metadata")) throw new Error("missing OSC metadata")
    value.feed(new TextEncoder().encode("\x1b]7;file://localhost/original\x07\x1b]9;previous notice\x07"))
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    for (const id of ids) {
      const result = registryDefinitions([id])[0]!.lib!(source)
      expect(result.observation, id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
      expect(result.assertions, id).toMatchObject([{ kind: "positive", observed: result.response }])
      const observed = JSON.parse(result.response!)
      if (id === "extensions.osc7-cwd") {
        expect(observed).toMatchObject({
          before: "file://localhost/original",
          first: "file://localhost/terminfo-cwd-A",
          second: "file://localhost/terminfo-cwd-B",
          restored: "file://localhost/original",
        })
        expect(value.getCwd?.()).toBe("file://localhost/original")
      } else {
        expect(observed).toMatchObject({
          before: ["previous notice"],
          first: ["previous notice", "terminfo-notification-A"],
          second: ["previous notice", "terminfo-notification-A", "terminfo-notification-B"],
        })
      }
    }
  } finally {
    value.destroy()
  }
  const batch = await collectBatch(async () => createVtermBackend(), "vterm", registryDefinitions(ids))
  expect(batch.results).toMatchObject(
    ids.map((featureId) => ({ featureId, status: "supported", assertionType: "buffer_state" })),
  )
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.observations).toHaveLength(2)
  for (const id of ids) {
    expect(batch.assertions.filter((assertion) => assertion.featureId === id)).toMatchObject([
      { kind: "positive", assertionType: "buffer_state", observed: batch.rawReplies[id] },
    ])
  }
})

test.for(["extensions.osc7-cwd", "extensions.notifications"])(
  "%s distinguishes stale exposed metadata from an absent reader",
  async (id, context) => {
    const sibling = fileURLToPath(new URL("../../../termless/packages/vterm/src/backend.ts", import.meta.url))
    if (!existsSync(sibling)) context.skip(`Real-vterm metadata controls require missing sibling ${sibling}`)
    const value = createVtermBackend({ cols: 80, rows: 24 })
    try {
      expect(hasExtension(value, "osc-metadata")).toBe(true)
      const definition = registryDefinitions([id])[0]!
      const source = createLibProbeSource(value, undefined, undefined, undefined)
      if (id === "extensions.osc7-cwd") vi.spyOn(source, "getCwd").mockReturnValue("file://localhost/stale")
      else vi.spyOn(source, "getNotifications").mockReturnValue(["stale notice"])
      const stale = definition.lib!(source)
      if (id === "extensions.osc7-cwd") {
        // A stale Cwd reader cannot qualify the independent control either. The qualified no-op negative is
        // covered by the existing real callback contract suite; this native fixture must remain undecided.
        expect(stale.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
        expect(stale.observation).toBeUndefined()
        expect(stale.assertions).toBeUndefined()
      } else {
        expect(stale.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
        expect(stale.assertions).toMatchObject([{ kind: "negative", observed: stale.response }])
      }
      if (id === "extensions.notifications") {
        vi.mocked(source.getNotifications!).mockRestore()
        const delivery = vi.spyOn(source, "feed").mockImplementation(() => {})
        expect(definition.lib!(source).observation?.outcome).toBe("unsupported")
        delivery.mockRestore()
        expect(definition.lib!(source).observation?.outcome).toBe("supported")
      }

      value.capabilities.extensions.delete("osc-metadata")
      const absent = createLibProbeSource(value, undefined, undefined, undefined)
      expect(absent.getCwd).toBeUndefined()
      expect(absent.getNotifications).toBeUndefined()
      const feed = vi.spyOn(value, "feed")
      const missing = definition.lib!(absent)
      expect(missing.criterionBranch).toBe("headless-observable-review")
      expect(missing.tests).toMatchObject([{ id: "review", status: "test-todo" }])
      expect(missing.observation).toBeUndefined()
      expect(missing.assertions).toBeUndefined()
      expect(feed).not.toHaveBeenCalled()
    } finally {
      value.destroy()
    }
  },
)

// @failure #32053: an engine declaring osc-metadata for notifications only (kitty) has no cwd reader; the OSC 7
// criterion must read that as missing evidence, never as an engine that reports no working directory.
// @level l1
// @consumer extensions.osc7-cwd through the actual LibProbeSource
test("an osc-metadata engine without getCwd leaves the OSC 7 criterion a test-todo, never unsupported", async (context) => {
  const sibling = fileURLToPath(new URL("../../../termless/packages/vterm/src/backend.ts", import.meta.url))
  if (!existsSync(sibling)) context.skip(`Real-vterm metadata controls require missing sibling ${sibling}`)
  const value = createVtermBackend({ cols: 80, rows: 24 })
  try {
    delete (value as { getCwd?: unknown }).getCwd
    expect(hasExtension(value, "osc-metadata")).toBe(true)
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    expect(source.getCwd).toBeUndefined()
    expect(source.getNotifications).toBeTypeOf("function")
    const feed = vi.spyOn(value, "feed")
    const cwd = registryDefinitions(["extensions.osc7-cwd"])[0]!.lib!(source)
    expect(cwd.criterionBranch).toBe("headless-observable-review")
    expect(cwd.tests).toMatchObject([{ id: "review", status: "test-todo" }])
    expect(cwd.observation).toBeUndefined()
    expect(cwd.assertions).toBeUndefined()
    expect(feed).not.toHaveBeenCalled()
    feed.mockRestore()
    const notifications = registryDefinitions(["extensions.notifications"])[0]!.lib!(source)
    expect(notifications.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
  } finally {
    value.destroy()
  }
})

// @failure #32053: Kitty receives every OSC 777 payload but its binding dropped them, so OSC 777 notify stayed a
// grid-only test-todo; a stale or inert reader stays TEST TODO, and an absent reader keeps the old route.
// @level l1
// @consumer extensions.osc777-notify through the actual LibProbeSource on the real Kitty bridge
test.skipIf(!isKittyAvailable())("Kitty OSC 777 notify payloads reach the probe through the raw reader", () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "terminfo-kitty-config-"))
  vi.stubEnv("KITTY_CONFIG_DIRECTORY", configDirectory)
  const value = createKittyBackend({ cols: 80, rows: 24 })
  try {
    expect(hasExtension(value, "osc-metadata")).toBe(true)
    const definition = registryDefinitions(["extensions.osc777-notify"])[0]!
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    // A non-notify payload is engine evidence too, but not this criterion's.
    source.feed("\x1b]777;preexec\x07")
    const result = definition.lib!(source)
    expect(result.notTested).toBeUndefined()
    expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect((JSON.parse(result.response!) as { second: string[] }).second).toEqual([
      "preexec",
      "terminfo-777-control",
      "notify;terminfo-777-title-A;terminfo-777-body-A",
      "notify;terminfo-777-title-B;terminfo-777-body-B",
    ])
    expect(source.getOsc777Payloads!()[0]).toBe("preexec")

    // A stale or inert reader records no control, so it stays TEST TODO, never Unsupported (@cto cd6b67d9).
    const stale = vi.spyOn(source, "getOsc777Payloads").mockReturnValue(["notify;stale;notice"])
    expect(definition.lib!(source).notTested).toMatchObject({ reason: "no-semantic-observable" })
    stale.mockRestore()
    const inert = vi.spyOn(source, "feed").mockImplementation(() => {})
    expect(definition.lib!(source).notTested).toMatchObject({ reason: "no-semantic-observable" })
    inert.mockRestore()

    const absent = createLibProbeSource(value, undefined, undefined, undefined)
    delete (absent as { getOsc777Payloads?: unknown }).getOsc777Payloads
    const missing = definition.lib!(absent)
    expect(missing.notTested).toMatchObject({ reason: "no-semantic-observable" })
    expect(missing.observation).toBeUndefined()
    expect(missing.assertions).toBeUndefined()
  } finally {
    value.destroy()
    vi.unstubAllEnvs()
    rmSync(configDirectory, { recursive: true, force: true })
  }
})

// @failure #32053: engine stores parsed toasts only; OSC 9 and 777;notify;X arrive identical. WezTerm
// (performer.rs:904-933) and Ghostty (osc.zig:94-98) keep {title, body} toasts, so no raw reader can attribute the
// code or rebuild the payload, and a reader declared on them would grade a guess. Their OSC 9 and OSC 777 cells
// must stay TEST TODO with no reader, never Unsupported (@cto 94631c52, 91f6fd75).
// @level l1
// @consumer extensions.notifications and extensions.osc777-notify through the actual LibProbeSource
function weztermNativeAvailable(): boolean {
  try {
    loadWeztermNative()
    return true
  } catch {
    return false
  }
}

test.for([
  ["wezterm", weztermNativeAvailable(), false, async () => createWeztermBackend()],
  ["ghostty-native", isGhosttyNativeAvailable(), true, async () => createGhosttyNativeBackend()],
  ["ghostty wasm", true, false, () => resolveGhosttyWasm()],
] as const)(
  "%s parsed-toast engine keeps OSC 9 and OSC 777 TEST TODO with no reader",
  async ([name, available, oscMetadata, create], context) => {
    if (!available) context.skip(`${name} native addon unavailable (NOT MEASURED)`)
    const value = await create()
    value.init({ cols: 80, rows: 24 })
    try {
      // Ghostty native declares osc-metadata for its OSC 9;4 reader only (#32271); no toast engine has a toast reader.
      expect(hasExtension(value, "osc-metadata")).toBe(oscMetadata)
      const source = createLibProbeSource(value, undefined, undefined, undefined)
      expect(source.getNotifications).toBeUndefined()
      expect(source.getOsc777Payloads).toBeUndefined()
      const [notifications, osc777] = registryDefinitions(["extensions.notifications", "extensions.osc777-notify"]).map(
        (definition) => definition.lib!(source),
      )
      expect(notifications!.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
      expect(notifications!.tests).toMatchObject([{ id: "review", status: "test-todo" }])
      expect(osc777!.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
      for (const result of [notifications!, osc777!]) {
        expect(result.observation).toBeUndefined()
        expect(result.assertions).toBeUndefined()
      }
    } finally {
      value.destroy()
    }
  },
)

// @failure #32271: Kitty and Ghostty native store the last OSC 9;4 report, but no binding read it, so the progress
// criterion stayed grid-only. Named gaps keep the other two undeclared: WezTerm's stored Progress::None covers
// never-reported, 9;4;0 and paused (tattoy-wezterm-term fork.5 performer.rs:1080-1085, terminal.rs:37-43), and
// ghostty-web's WASM API exposes no progress reader (@cto 3636f1ee).
// @level l1
// @consumer extensions.osc9-progress through the actual LibProbeSource
test.for([
  ["kitty", isKittyAvailable(), true, async () => createKittyBackend()],
  ["ghostty-native", isGhosttyNativeAvailable(), true, async () => createGhosttyNativeBackend()],
  ["wezterm", weztermNativeAvailable(), false, async () => createWeztermBackend()],
  ["ghostty wasm", true, false, () => resolveGhosttyWasm()],
] as const)(
  "%s OSC 9;4 progress grades through the stored-report reader only where the engine stores one",
  async ([name, available, reader, create], context) => {
    if (!available) context.skip(`${name} engine unavailable (NOT MEASURED)`)
    const configDirectory = name === "kitty" ? mkdtempSync(join(tmpdir(), "terminfo-kitty-config-")) : undefined
    if (configDirectory) vi.stubEnv("KITTY_CONFIG_DIRECTORY", configDirectory)
    const value = await create()
    value.init({ cols: 80, rows: 24 })
    try {
      const source = createLibProbeSource(value, undefined, undefined, undefined)
      const result = registryDefinitions(["extensions.osc9-progress"])[0]!.lib!(source)
      if (reader) {
        expect(result.notTested).toBeUndefined()
        expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
        // Clearing last restores the engine: a state-0 report, never "never reported".
        expect(source.getProgress!()).toMatchObject({ state: 0 })
      } else {
        expect(source.getProgress).toBeUndefined()
        expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
        expect(result.observation).toBeUndefined()
      }
    } finally {
      value.destroy()
      if (configDirectory) {
        vi.unstubAllEnvs()
        rmSync(configDirectory, { recursive: true, force: true })
      }
    }
  },
)

// @failure Declared native readers are lost at the collector binding, or undeclared/non-callable readers are exposed.
// @level l1
// @consumer Semantic-mark and Sixel storage callbacks through the actual LibProbeSource.
test.for(["semantic-marks", "sixel-storage"] as const)(
  "real vterm %s readback is forwarded only when declared and callable",
  async (extension, context) => {
    const sibling = fileURLToPath(new URL("../../../termless/packages/vterm/src/backend.ts", import.meta.url))
    if (!existsSync(sibling)) context.skip(`Real-vterm reader binding requires missing sibling ${sibling}`)
    const value = createVtermBackend({ cols: 80, rows: 24 })
    const method = extension === "semantic-marks" ? "getSemanticMarks" : "getSixelImages"
    try {
      const source = createLibProbeSource(value, undefined, undefined, undefined)
      expect(source[method]).toBeTypeOf("function")
      if (extension === "semantic-marks") {
        expect(source.getSemanticMarks!()).toEqual([])
        source.feed("\x1b[2;3H\x1b]133;B\x07")
        expect(source.getSemanticMarks!()).toEqual([{ type: "command", startRow: 1, startCol: 2 }])
      } else {
        expect(source.getSixelImages!()).toEqual([])
        source.feed("\x1b[2;3H\x1bPq#1;2;100;0;0~\x1b\\")
        expect(source.getSixelImages!()).toEqual([{ data: "#1;2;100;0;0~", row: 1, col: 2 }])
      }
      value.capabilities.extensions.delete(extension)
      expect(createLibProbeSource(value, undefined, undefined, undefined)[method]).toBeUndefined()
      value.capabilities.extensions.add(extension)
      expect(Reflect.deleteProperty(value, method)).toBe(true)
      expect(createLibProbeSource(value, undefined, undefined, undefined)[method]).toBeUndefined()
    } finally {
      value.destroy()
    }
  },
)

const VTERM_MARK_CASES = [
  ["extensions.osc133-a", 133, "prompt"],
  ["extensions.osc133-b", 133, "command"],
  ["extensions.osc133-c", 133, "output"],
  ["extensions.osc633-a", 633, "prompt"],
  ["extensions.osc633-b", 633, "command"],
  ["extensions.osc633-c", 633, "output"],
] as const

// @failure The native Kitty icon callback is dropped before the registered probe can observe it; cached labels can
// survive later input or reset and impersonate fresh icon state. Existing Kitty tests only read window titles.
// @level l5
// @consumer Registered OSC1/OSC0 callbacks through Kitty's real native bridge and production collector source.
test.skipIf(!isKittyAvailable())(
  "Kitty icon observations retain independent titles across OSC1, OSC0 and reset",
  () => {
    const value = createKittyBackend({ cols: 80, rows: 24 })
    const feed = (text: string) => value.feed(new TextEncoder().encode(text))
    try {
      feed("\x1b]2;original-window\x07")
      expect(value.getTitle()).toBe("original-window")
      const source = createLibProbeSource(value, undefined, undefined, undefined)
      for (const id of ["extensions.osc1-icon", "extensions.osc0-icon-title"]) {
        const result = registryDefinitions([id])[0]!.lib!(source)
        expect(result.observation, id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
        expect(value.getTitle(), id).toBe("original-window")
      }
      feed("\x1b]1;previous-icon\x07")
      value.reset()
      const result = registryDefinitions(["extensions.osc1-icon"])[0]!.lib!(source)
      expect(result.observation).toMatchObject({ outcome: "supported" })
      const observed = JSON.parse(result.response!) as {
        requested: string
        control: string
        after: { icon: string; title: string }
      }
      expect(observed.after).toEqual({ icon: observed.requested, title: observed.control })
      expect(observed.after.icon).not.toBe("previous-icon")
      value.init({ cols: 80, rows: 24 })
      const fresh = registryDefinitions(["extensions.osc1-icon"])[0]!.lib!(
        createLibProbeSource(value, undefined, undefined, undefined),
      )
      expect(JSON.parse(fresh.response!)).toMatchObject({ before: { icon: "", title: "" } })
      expect(fresh.observation).toMatchObject({ outcome: "supported" })
    } finally {
      value.destroy()
    }
  },
)

// @failure A command-end-only native reader misgrades A/C or accepts cached/wrong raw status as a new D event.
// @level l1
// @consumer Registered OSC133D and start callbacks through the actual Kitty collector source.
// Existing private callback tests cannot observe the public reader binding or the deciding callback route.
test.skipIf(!isKittyAvailable())(
  "Kitty command-end reader preserves start review and witnesses fresh raw D statuses",
  () => {
    const value = createKittyBackend({ cols: 80, rows: 24 })
    try {
      const source = createLibProbeSource(value, undefined, undefined, undefined)
      const definition = registryDefinitions(["extensions.osc133-d"])[0]!
      const result = definition.lib!(source)
      expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
      const observed = JSON.parse(result.response!) as { first: unknown[]; second: unknown[] }
      expect(observed.first.at(-1)).toEqual({ type: "command-end", rawStatus: "0" })
      expect(observed.second.at(-1)).toEqual({ type: "command-end", rawStatus: "17" })
      for (const id of ["extensions.osc133-a", "extensions.osc133-c"]) {
        const start = registryDefinitions([id])[0]!.lib!(source)
        expect(start.criterionBranch, id).toBe(SEMANTIC_PROMPT_SOURCE_REVIEW)
        expect(start.observation, id).toBeUndefined()
      }
      // The umbrella callbacks stay TEST TODO until a full-lifecycle reader exists (b5fecd017, #32247).
      for (const id of ["extensions.semantic-prompts", "extensions.osc-633-vscode"]) {
        const umbrella = registryDefinitions([id])[0]!.lib!(source)
        expect(umbrella.tests, id).toEqual([
          { id: "criterion", status: "test-todo", reason: "no full-lifecycle observable on this reader" },
        ])
        expect(umbrella.observation, id).toBeUndefined()
      }
      const cached = source.getSemanticMarks!()
      const reader = vi.spyOn(source, "getSemanticMarks").mockReturnValue(cached)
      const inert = definition.lib!(source)
      expect(inert.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
      expect(inert.observation).toBeUndefined()
      expect(inert.assertions).toBeUndefined()
      reader.mockRestore()
      const realReader = source.getSemanticMarks!.bind(source)
      vi.spyOn(source, "getSemanticMarks").mockImplementation(() =>
        realReader().map((mark) => (mark.type === "command-end" ? { ...mark, rawStatus: "wrong" } : mark)),
      )
      const malformedControl = definition.lib!(source)
      expect(malformedControl.notTested).toEqual({
        reason: "no-semantic-observable",
        noObservable: NO_SAME_PATH_CONTROL,
      })
      expect(malformedControl.observation).toBeUndefined()
      expect(malformedControl.assertions).toBeUndefined()
      value.capabilities.extensions.delete("semantic-command-end")
      const undeclared = createLibProbeSource(value, undefined, undefined, undefined)
      expect(undeclared.getSemanticMarks).toBeUndefined()
      expect(definition.lib!(undeclared).criterionBranch).toBe(SEMANTIC_PROMPT_SOURCE_REVIEW)
      value.capabilities.extensions.add("semantic-command-end")
      Object.defineProperty(value, "getSemanticMarks", { value: undefined })
      const missing = definition.lib!(createLibProbeSource(value, undefined, undefined, undefined))
      expect(missing.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
      expect(missing.note).toContain("getSemanticMarks")
      expect(missing.observation).toBeUndefined()
    } finally {
      value.destroy()
    }
  },
)

// @failure A registered semantic callback grades consumption or cached records instead of new typed, positioned marks.
// @level l1
// @consumer Eight vterm semantic cells through the real adapter, collector and registry.
test.for(VTERM_MARK_CASES)(
  "%s decides new marks and distinguishes stale/missing readers",
  async ([id, selector, type]) => {
    const value = createVtermBackend({ cols: 80, rows: 24 })
    try {
      value.feed(new TextEncoder().encode(`\x1b[7;8H\x1b]${selector};C\x07`))
      const source = createLibProbeSource(value, undefined, undefined, undefined)
      const definition = registryDefinitions([id])[0]!
      const result = definition.lib!(source)
      expect(result.observation, id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
      expect(result.assertions, id).toMatchObject([{ kind: "positive", observed: result.response }])
      const observed = JSON.parse(result.response!) as {
        first: unknown[]
        second: unknown[]
        before: unknown[]
        secondBefore: unknown[]
      }
      expect(observed.first.at(-1)).toEqual({ type, startRow: 0, startCol: 0 })
      expect(observed.second.at(-1)).toEqual({ type, startRow: 1, startCol: 2 })
      expect(observed.first).toHaveLength(observed.before.length + 1)
      expect(observed.second).toHaveLength(observed.secondBefore.length + 1)
      const realFeed = source.feed.bind(source)
      let controlled = false
      let cached: ReturnType<typeof value.getSemanticMarks> | undefined
      vi.spyOn(source, "feed").mockImplementation((text) => {
        if (text.startsWith(`\x1b]${selector === 133 ? 633 : 133};`)) controlled = true
        if (controlled && text.startsWith(`\x1b]${selector};`) && cached === undefined) {
          cached = value.getSemanticMarks()
        }
        realFeed(text)
      })
      vi.spyOn(source, "getSemanticMarks").mockImplementation(() => cached ?? value.getSemanticMarks())
      expect(definition.lib!(source).observation).toMatchObject({
        outcome: "unsupported",
        assertionType: "buffer_state",
      })
      Object.defineProperty(value, "getSemanticMarks", { value: undefined })
      const absent = createLibProbeSource(value, undefined, undefined, undefined)
      const missing = definition.lib!(absent)
      expect(missing.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
      expect(missing.tests).toMatchObject([{ id: "review", status: "test-todo" }])
      // Generic umbrella TODOs share this branch but do not identify the declared reader's missing tool.
      expect(missing.note, id).toContain("semantic-marks getSemanticMarks readback is unavailable")
      expect(missing.observation).toBeUndefined()
    } finally {
      value.destroy()
    }
  },
)

// @failure Engines declaring semanticPrompts without the semantic-marks extension lose their decidable source review.
// @level l1
// @consumer WezTerm's three and Ghostty-native's six semantic start-marker callback routes.
test("wezterm and ghostty-native without a declared mark reader retain source review", () => {
  // An actual JS terminal supplies consumption/cursor controls; these metadata-only
  // route checks neither execute nor attest either optional native engine.
  for (const [engine, selectors] of [
    ["wezterm", [133]],
    ["ghostty-native", [133, 633]],
  ] as const) {
    const value = createXtermBackend({ cols: 80, rows: 24 })
    try {
      const original = createLibProbeSource(value, undefined, undefined, undefined)
      const source: LibProbeSource = {
        ...original,
        capabilities: { ...original.capabilities, semanticPrompts: true },
      }
      expect(source.capabilities.extensions.has("semantic-marks"), engine).toBe(false)
      expect(source.getSemanticMarks, engine).toBeUndefined()
      for (const selector of selectors) {
        for (const mark of ["a", "b", "c"]) {
          const id = `extensions.osc${selector}-${mark}`
          const result = registryDefinitions([id])[0]!.lib!(source)
          expect(result.criterionBranch, `${engine} ${id}`).toBe(SEMANTIC_PROMPT_SOURCE_REVIEW)
          expect(result.observation, `${engine} ${id}`).toBeUndefined()
        }
      }
    } finally {
      value.destroy()
    }
  }
})

// @failure A moving reader with the wrong marker type, position, append count or rewritten history passes a freshness-only check.
// @level l1
// @consumer The registered semantic start-marker predicate.
test.for(["type", "position", "count", "history"] as const)("rejects fresh mark readback with wrong %s", (fault) => {
  const value = createVtermBackend({ cols: 80, rows: 24 })
  try {
    // A correct new tail cannot witness append-only registration when the earlier mark was rewritten.
    // The existing type/position/count and cached-reader controls did not change a retained prefix.
    if (fault === "history") value.feed(new TextEncoder().encode("\x1b[7;8H\x1b]133;C\x07"))
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    const actual = source.getSemanticMarks!
    const realFeed = source.feed.bind(source)
    let controlled = false
    let targetPhase = false
    vi.spyOn(source, "feed").mockImplementation((text) => {
      if (text.startsWith("\x1b]633;A")) controlled = true
      if (controlled && text.startsWith("\x1b]133;A")) targetPhase = true
      realFeed(text)
    })
    vi.spyOn(source, "getSemanticMarks").mockImplementation(() => {
      const marks = actual()
      if (!targetPhase) return marks
      if (fault === "type") {
        return marks.map((mark) => (mark.type === "command-end" ? mark : { ...mark, type: "command" as const }))
      }
      if (fault === "position") {
        return marks.map((mark) => (mark.type === "command-end" ? mark : { ...mark, startCol: mark.startCol + 1 }))
      }
      if (fault === "history") {
        return marks.map((mark, index) =>
          index < marks.length - 1 && mark.type !== "command-end"
            ? { ...mark, startCol: mark.startCol + marks.length }
            : mark,
        )
      }
      return marks.flatMap((mark) => [mark, { ...mark }])
    })
    const result = registryDefinitions(["extensions.osc133-a"])[0]!.lib!(source)
    expect(result.observation).toMatchObject({ outcome: "unsupported", assertionType: "buffer_state" })
    expect(result.assertions).toMatchObject([{ kind: "negative", observed: result.response }])
  } finally {
    value.destroy()
  }
})

// @failure Observed start markers never become actual supported results through the production batch writer.
// @level l1
// @consumer The eight run-decided vterm mark cells in the collected result model.
test("real vterm mark observations survive the registered batch producer", async () => {
  const ids = VTERM_MARK_CASES.map(([id]) => id)
  const batch = await collectBatch(async () => createVtermBackend(), "vterm", registryDefinitions(ids))
  expect(batch.results).toMatchObject(
    ids.map((featureId) => ({ featureId, status: "supported", assertionType: "buffer_state" })),
  )
  expect(batch.observations).toHaveLength(ids.length)
  expect(batch.assertions).toMatchObject(
    ids.map((featureId) => ({ featureId, kind: "positive", assertionType: "buffer_state" })),
  )
})

// @failure Raw Sixel storage is promoted to rendering support, or the partial reason claims storage from a stale reader.
// @level l1
// @consumer The Sixel rendering cell, with its separately retained storage facet.
test("real vterm Sixel storage sharpens the TODO reason without grading rendering", () => {
  const value = createVtermBackend({ cols: 80, rows: 24 })
  try {
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    const definition = registryDefinitions(["extensions.sixel"])[0]!
    const result = definition.lib!(source)
    expect(result.note).toBe("payload retained at row/col; no raster; cell geometry unmeasured")
    expect(result.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
    expect(result.tests).toMatchObject([{ status: "test-todo" }])
    expect(result.observation).toBeUndefined()
    expect(JSON.parse(result.response!)).toMatchObject({ storage: { retained: true } })
    vi.spyOn(source, "getSixelImages").mockReturnValue([])
    const stale = definition.lib!(source)
    expect(stale.tests).toMatchObject([{ status: "test-todo" }])
    expect(JSON.parse(stale.response!)).toMatchObject({ storage: { retained: false } })
    expect(stale.note).not.toBe(result.note)
  } finally {
    value.destroy()
  }
})

test("cwd readback errors propagate after restoring the original metadata", async (context) => {
  const sibling = fileURLToPath(new URL("../../../termless/packages/vterm/src/backend.ts", import.meta.url))
  if (!existsSync(sibling)) context.skip(`Real-vterm cwd cleanup requires missing sibling ${sibling}`)
  const value = createVtermBackend({ cols: 80, rows: 24 })
  try {
    expect(hasExtension(value, "osc-metadata")).toBe(true)
    if (!hasExtension<OscMetadataExtension>(value, "osc-metadata")) throw new Error("missing OSC metadata")
    value.feed(new TextEncoder().encode("\x1b]7;file://localhost/original\x07"))
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    const read = source.getCwd!.bind(source)
    vi.spyOn(source, "getCwd")
      .mockImplementationOnce(read)
      .mockImplementationOnce(() => {
        throw new Error("metadata read failed")
      })
    expect(() => registryDefinitions(["extensions.osc7-cwd"])[0]!.lib!(source)).toThrow("metadata read failed")
    expect(value.getCwd?.()).toBe("file://localhost/original")
  } finally {
    value.destroy()
  }
})

// 31299: callback-only assertions miss a typed source review that the capture parser rejects.
// Keep the real registered callback, pinned identity fixture, adapter, collector and parser on one path.
test.each(["extensions.osc117-reset-highlight-bg", "extensions.osc119-reset-highlight-fg"])(
  "%s reads TEST TODO, never a source review, through the actual collector",
  async (id) => {
    const definition = ALL_PROBES.find((entry) => entry.id === id)!
    // Source-audit input, not an attestation of this runner's checkout. Standalone CI has no owned siblings.
    const identity = {
      kind: "js",
      runtimeFormat: "js",
      engineVersion: "6.0.0",
      adapterVersion: "0.10.2",
      termlessRevision: "9f0d4a5cbbeb2b7d9263ef7e07699df16a1cafc7",
      // Source-audit fixture follows the supplied-pixel binding edit; response forwarding is unchanged.
      adapterSources: [
        { path: "packages/xtermjs/src/index.ts", blobOid: "550e10110ec2baaf326d2958319b03ee8208feba" },
        { path: "packages/xtermjs/src/backend.ts", blobOid: "72dc827b2026af7736de722f7ff986a04f3fe883" },
      ],
      resolvedPath:
        "node_modules/.bun/@xterm+headless@6.0.0/node_modules/@xterm/headless/lib-headless/xterm-headless.js",
      integrity: {
        kind: "registry",
        lockIntegrity:
          "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
      },
    } as const
    // collectBatch re-reads identity after init; keep that read on the same fixture too.
    vi.spyOn(headlessIdentity, "headlessRuntimeIdentity").mockResolvedValue(identity)
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: "reset-parser-contract-fixture",
      adapterVersion: "fixture",
      catalogIds: [id],
      probes: { term: [], mux: [], lib: [id] },
    }
    const draft = initializeRunDraft({
      source: { kind: "live" },
      runId: `reset-parser-contract-${id}`,
      sourceRevision: "a".repeat(40),
      intendedSubject: { kind: "lib", id: "xtermjs" },
      manifest,
    })
    const carrier = async () => {
      const value = await backend()
      // Producer metadata and the mocked runtime describe the same historical audit fixture.
      value.getAdapterSources = () => identity.adapterSources
      return value
    }
    const batch = await collectBatch(carrier, "xtermjs", [definition], draft, undefined, {
      identity,
      adapterPath: Bun.resolveSync("@termless/xtermjs", fileURLToPath(import.meta.url)),
      adapterPackage: "@termless/xtermjs",
      adapterType: "js",
    })
    const captured: CapturedRunDraft = {
      ...draft,
      subject: {
        kind: "lib",
        id: "xtermjs",
        version: identity.engineVersion,
        os: "linux",
        osVersion: null,
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      identity: "unverified",
      runtimeIdentity: identity,
      measuredAt: new Date().toISOString(),
      origin: { kind: "collector" },
      rawReplies: { ...draft.rawReplies, ...batch.rawReplies },
      results: batch.results,
      assertions: batch.assertions,
    }
    const parsed = parseRun(
      `${id}.capture.json`,
      JSON.stringify(captured),
      manifest.catalogIds,
      new Map([[manifest.probeHash, manifest]]),
    )
    expect(parsed.results).toMatchObject([
      {
        featureId: id,
        status: "test-todo",
        tests: [{ id: "criterion", status: "test-todo" }],
      },
    ])
    expect(parsed.results?.[0]?.criterionBranch).toBeUndefined()
  },
)

// 31770 @cto a60bc57e N2: the unit cases in extensions-osc0-observations.test.ts call the OSC 0 callback
// directly, so the collector wrapping of its control and getter failures was never fault-injected.
// Real xterm backend, audited identity, registered callback and collectBatch on one path: a failed control
// or a throwing getter must leave TEST FAILURE with both labels restored and no support or negative claim.
test.each([
  { fault: "none" },
  { fault: "icon-control" },
  { fault: "title-control" },
  { fault: "icon-readback" },
  { fault: "title-readback" },
] as const)("audited xterm OSC 0 $fault survives the actual collector without a grade leak", async ({ fault }) => {
  const id = "extensions.osc0-icon-title"
  const identity = {
    kind: "js",
    runtimeFormat: "js",
    engineVersion: "6.0.0",
    adapterVersion: "0.10.2",
    termlessRevision: "9f0d4a5cbbeb2b7d9263ef7e07699df16a1cafc7",
    // The audited source table, not an attestation of this runner's checkout.
    adapterSources: Object.entries(ADAPTER_SOURCE_AUDITS.xtermjs).map(([path, blobOid]) => ({ path, blobOid })),
    resolvedPath: "node_modules/.bun/@xterm+headless@6.0.0/node_modules/@xterm/headless/lib-headless/xterm-headless.js",
    integrity: {
      kind: "registry",
      lockIntegrity: "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
    },
  } as const
  vi.spyOn(headlessIdentity, "headlessRuntimeIdentity").mockResolvedValue(identity)
  const original = { icon: "saved-icon", title: "saved-title" }
  let final: { icon: string; title: string } | undefined
  let effectFed = false
  const readbackError = new Error(`${fault} unavailable`)
  const carrier = async () => {
    const value = await backend()
    value.getAdapterSources = () => identity.adapterSources
    const feed = value.feed.bind(value)
    const init = value.init.bind(value)
    // collectBatch initializes the backend; the saved labels are set right after, before the callback.
    value.init = (options) => {
      init(options)
      feed(new TextEncoder().encode(`\x1b]1;${original.icon}\x07\x1b]2;${original.title}\x07`))
    }
    const readIcon = value.getIconLabel!.bind(value)
    const readTitle = value.getTitle.bind(value)
    // Fault at the engine boundary: a dropped control setter, or a getter that fails after the effect.
    value.feed = (data: Uint8Array) => {
      const text = new TextDecoder().decode(data)
      if (text.startsWith("\x1b]0;")) effectFed = true
      if (fault === "icon-control" && text.startsWith("\x1b]1;osc0-icon-control")) return
      if (fault === "title-control" && text.startsWith("\x1b]2;osc0-title-control")) return
      feed(data)
    }
    value.getIconLabel = () => {
      if (effectFed && fault === "icon-readback") throw readbackError
      return readIcon()
    }
    value.getTitle = () => {
      if (effectFed && fault === "title-readback") throw readbackError
      return readTitle()
    }
    const destroy = value.destroy.bind(value)
    value.destroy = () => {
      final = { icon: readIcon(), title: readTitle() }
      destroy()
    }
    return value
  }
  const batch = await collectBatch(carrier, "xtermjs", registryDefinitions([id]), undefined, undefined, {
    identity,
    adapterPath: Bun.resolveSync("@termless/xtermjs", fileURLToPath(import.meta.url)),
    adapterPackage: "@termless/xtermjs",
    adapterType: "js",
  })
  expect(final).toEqual(original)
  expect(JSON.parse(batch.rawReplies["collector.replyPath"]!)).toMatchObject({
    decisions: { [id]: { runtimeIdentity: identity } },
  })
  const observation = batch.observations.find((entry) => entry.featureId === id)
  const result = batch.results.find((entry) => entry.featureId === id)
  if (fault === "none") {
    // Control: the audited state route is the one reached, so the fault rows below are not vacuous.
    expect(effectFed).toBe(true)
    expect(observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
    expect(batch.assertions.filter((entry) => entry.featureId === id).map(({ kind }) => kind)).toContain("positive")
    return
  }
  expect(effectFed).toBe(fault.endsWith("-readback"))
  expect(result).toMatchObject({ status: "test-failure" })
  expect(observation?.outcome).not.toBe("supported")
  expect(observation?.outcome).not.toBe("unsupported")
  expect(batch.assertions.filter((entry) => entry.featureId === id)).toEqual([])
  if (fault.endsWith("-control")) {
    expect(batch.ungradedDiagnostics).toEqual({})
    expect(result!.tests).toMatchObject([
      {
        status: "test-failure",
        reason: expect.stringContaining("OSC 0 independent icon/title controls were not both read back"),
      },
    ])
  } else {
    expect(batch.ungradedDiagnostics[id]).toMatchObject({
      kind: "collector-error",
      message: expect.stringContaining(`${fault} unavailable`),
    })
  }
})

// Q2/bar93: callback tests miss a typed parser-state result rejected at the collector/parser boundary. Since #32246 the
// former source review is TEST TODO coverage, which must still survive collection and parsing.
// Canonical source validation lazily fetches historical Git blobs in CI's partial clones; this is not a speed test.
test("DECSSCLS real-vterm parser-state TEST TODO survives collection and canonical parsing", async () => {
  const id = "modes.decsscls"
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "decsscls-parser-fixture",
    adapterVersion: "fixture",
    catalogIds: [id],
    probes: { term: [], mux: [], lib: [id] },
  }
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "decsscls-parser-fixture",
    // Existing frozen source object; the fixture engine version remains unreviewed and unverified.
    sourceRevision: "9e319ac6e815688fc4b56eade0d06a49eaffafba",
    intendedSubject: { kind: "lib", id: "vterm" },
    manifest,
  })
  const batch = await collectBatch(async () => createVtermBackend(), "vterm", registryDefinitions([id]), draft)
  // #32246: no source review decides DECSSCLS; the parser-state cell is TEST TODO coverage with no negative assertion.
  expect(batch.results).toMatchObject([
    { featureId: id, status: "test-todo", tests: [{ id: "criterion", status: "test-todo" }] },
  ])
  expect(batch.results[0]).not.toHaveProperty("criterionBranch")
  expect(batch.results[0]).not.toHaveProperty("assertionType")
  expect(JSON.parse(batch.rawReplies[id]!)).toMatchObject({ cursor: { x: 1, y: 0 } })
  expect(JSON.parse(batch.rawReplies[id]!)).toMatchObject({ text: expect.stringMatching(/^Q\s*$/u) })
  expect(batch.assertions).toEqual([])
  const captured: CapturedRunDraft = {
    ...draft,
    subject: {
      kind: "lib",
      id: "vterm",
      version: "fixture",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    measuredAt: "2026-11-02T06:20:00.000Z",
    // Private unit identity with an existing source object, not an attestation of the loaded engine.
    runtimeIdentity: {
      kind: "js",
      runtimeFormat: "js",
      engineVersion: "fixture",
      adapterVersion: "fixture",
      termlessRevision: "539e4803eee45fcfe60369188c2189b57a06ae18",
      resolvedPath: "fixture/vterm",
      integrity: { kind: "registry", lockIntegrity: "fixture" },
    },
    origin: { kind: "collector" },
    rawReplies: { ...draft.rawReplies, ...batch.rawReplies },
    results: batch.results,
    assertions: batch.assertions,
  }
  const finalized = finalizeCollectedDraft(captured)
  expect(finalized.results).toMatchObject([
    { featureId: id, status: "test-todo", tests: [{ id: "criterion", status: "test-todo" }] },
  ])
  expect(finalized.assertions).toEqual(batch.assertions)
  expect(finalized.rawReplies).toEqual(batch.rawReplies)
  const parsed = parseRun(
    "decsscls.capture.json",
    JSON.stringify(finalized),
    manifest.catalogIds,
    new Map([[manifest.probeHash, manifest]]),
  )
  expect(parsed.results).toEqual(finalized.results)
}, 30_000)

// @failure A D/633 prompt result at the formerly audited WezTerm identity becomes a collector error, or is graded
//   from source instead of staying TEST TODO (#32246).
// @level l1 @consumer collectBatch plus capture parser; callback tests cannot catch declaration rejection.
test("Wezterm prompt TEST TODO rows survive actual collection and capture binding", async () => {
  const ids = [
    "extensions.osc133-d",
    "extensions.osc633-a",
    "extensions.osc633-b",
    "extensions.osc633-c",
    "extensions.osc633-d",
    "extensions.osc633-e",
    "extensions.osc633-p",
  ]
  // Deliberately use the existing JS backend with a mocked identity. This tests producer mechanics,
  // not native execution/attestation, and runs without the owned vterm or ghostty sibling sources.
  const identity = {
    kind: "native",
    engineVersion: "0.1.0-fork.5",
    adapterVersion: "0.10.2",
    termlessRevision: "83b22ab3f99ff3c2f3e43bcfce346c1374f540e1",
    // The JS carrier exercises collection; the qualified identity belongs to audited WezTerm sources.
    adapterSources: [
      { path: "packages/wezterm/src/index.ts", blobOid: "512606c5270ffd0cff55c1b70f5b3eda18a92df0" },
      { path: "packages/wezterm/src/backend.ts", blobOid: "42a196995a5f8845ab2e3bb6227192556c470071" },
      { path: "packages/wezterm/native/src/lib.rs", blobOid: "445f5484027aebbea01a641a96dd92dfea273693" },
      { path: "src/load-native.ts", blobOid: "34e142550085450ab02138184626716ad0d6b546" },
    ],
    loadedBinary: {
      path: "vendor/termless/packages/wezterm/termless-wezterm.node",
      sha256: "6722b331de7489c14cb599d939e5d2314f054220728f83c5c29f454e70273e47",
    },
    provenance: {
      sha256: "6722b331de7489c14cb599d939e5d2314f054220728f83c5c29f454e70273e47",
      sourceCommit: "83b22ab3f99ff3c2f3e43bcfce346c1374f540e1",
      buildHash: "94a2d6025d3dc9e62debb7cbe388b3ad5113394d0ab6746d6baa58475fbe9c56",
      toolchain:
        "rustc 1.94.0 (4a4ef493e 2026-03-02) (built from a source tarball); cargo 1.94.0 (85eff7c80 2026-01-15)",
      lockSha256: "8eaeab733cced8d47feb223d773d5ae158b2e6af8c994f993d4071d9ba3231d4",
    },
  } as const
  vi.spyOn(headlessIdentity, "headlessRuntimeIdentity").mockResolvedValue(identity)
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "wezterm-prompt-parser-contract-fixture",
    adapterVersion: "fixture",
    catalogIds: ids,
    probes: { term: [], mux: [], lib: ids },
  }
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "wezterm-prompt-parser-contract",
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "wezterm" },
    manifest,
  })
  const carrier = async () => {
    const value = await backend()
    // The JS carrier's metadata belongs to this mocked WezTerm fixture, not the loaded JS engine.
    value.getAdapterSources = () => identity.adapterSources
    return value
  }
  const batch = await collectBatch(carrier, "wezterm", registryDefinitions(ids), draft, undefined, {
    identity,
    adapterPath: Bun.resolveSync("@termless/xtermjs", fileURLToPath(import.meta.url)),
    adapterPackage: "@termless/xtermjs",
    adapterType: "js",
  })
  const captured: CapturedRunDraft = {
    ...draft,
    subject: {
      kind: "lib",
      id: "wezterm",
      version: identity.engineVersion,
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    runtimeIdentity: identity,
    measuredAt: new Date().toISOString(),
    origin: { kind: "collector" },
    rawReplies: { ...draft.rawReplies, ...batch.rawReplies },
    results: batch.results,
    assertions: batch.assertions,
  }
  // #32246: the formerly audited WezTerm identity grades no prompt mark from source; each stays TEST TODO, untyped.
  for (const id of ids) {
    const row = captured.results.find((entry) => entry.featureId === id)!
    expect(row).toMatchObject({ featureId: id, status: "test-todo" })
    expect(row.criterionBranch).not.toBe("source-negative-review")
    // osc633-d/-p report their reader route as an inconclusive observation (#32247); still TEST TODO, never graded.
    if (id !== "extensions.osc633-d" && id !== "extensions.osc633-p") expect(row).not.toHaveProperty("assertionType")
    expect(captured.runtimeIdentity).toEqual(identity)
  }
  expect(captured.assertions).toEqual([])
  const parsed = parseRun(
    "wezterm-prompt.capture.json",
    JSON.stringify(captured),
    ids,
    new Map([[manifest.probeHash, manifest]]),
  )
  expect(parsed.results).toHaveLength(7)
  expect(
    parsed.results?.every((row) => row.criterionBranch !== "source-negative-review" && row.status === "test-todo"),
  ).toBe(true)
})

// #32099: callback-only tests miss a result rejected by an inherited query_reply declaration. Real engines must take
// different branches through the same definitions, including xterm's actual mode2031 Ps0 negative; since #32246 the
// vterm engines' former source reviews are untyped TEST TODO rows that must still survive collection and parsing.
test("source-qualified mode and mouse criteria survive collection and capture parsing", async () => {
  const ids = ["modes.synchronized-output", "modes.color-scheme-reporting", "input.pixel-mouse"]
  for (const [name, producer] of [
    ["vt100", resolveVt100],
    ["vt220", resolveVt220],
    ["xtermjs", backend],
  ] as const) {
    const adapterPackage = `@termless/${name}`
    // Source-audit inputs, not this host's checkout attestation. These pins match the existing
    // headless-decrpm capturedModeEngines and OSC117 xterm fixtures; standalone CI has no owned vterm.
    const identity = {
      kind: "js",
      runtimeFormat: "js",
      adapterVersion: "0.10.2",
      termlessRevision: "8be31bfc35c0359e39a836b1d397f49e7176c97f",
      ...(name !== "xtermjs"
        ? ({
            engineVersion: "0.10.1",
            resolvedPath: `vendor/vterm/packages/${name}/src/index.ts`,
            integrity: {
              kind: "source",
              repository: "git@github.com:beorn/vterm.git",
              revision: "9e99e4d23cdc606fca258b1863aa2be7ae79eed3",
              treeOid:
                name === "vt100"
                  ? "b941dae48b25ae8825c394750bda5245c9d93dfa"
                  : "4205f8936ad1848d1029729f3ada888cd61759a8",
              cleanTree: true,
            },
            adapterSources:
              name === "vt100"
                ? [
                    { path: "packages/vt100/src/index.ts", blobOid: "99833d737402f9d1d8e3e257e3a255d8aa1facc3" },
                    { path: "packages/vt100/src/backend.ts", blobOid: "cdb8be8c5ebbba68a5920cfa4df27c9deb31745a" },
                  ]
                : [
                    { path: "packages/vt220/src/index.ts", blobOid: "601dd26eb7e753a5396ebdf72f1ef8ee2cc4355f" },
                    { path: "packages/vt220/src/backend.ts", blobOid: "7369e3710e36aa649372fd09011ecfdd6ba47c73" },
                  ],
          } as const)
        : ({
            engineVersion: "6.0.0",
            resolvedPath:
              "node_modules/.bun/@xterm+headless@6.0.0/node_modules/@xterm/headless/lib-headless/xterm-headless.js",
            integrity: {
              kind: "registry",
              lockIntegrity:
                "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
            },
            adapterSources: [
              { path: "packages/xtermjs/src/index.ts", blobOid: "550e10110ec2baaf326d2958319b03ee8208feba" },
              { path: "packages/xtermjs/src/backend.ts", blobOid: "481fe005c5801cbb5e6ba4c8677f577e02122e4e" },
            ],
          } as const)),
    } as const
    // collectBatch re-reads identity and adapter metadata after init; both use this audit fixture.
    vi.spyOn(headlessIdentity, "headlessRuntimeIdentity").mockResolvedValue(identity)
    const carrier = async () => {
      const value = await producer()
      return Object.assign(value, {
        capabilities: {
          ...value.capabilities,
          extensions: new Set([...(value.capabilities.extensions ?? []), "adapter-sources"]),
        },
        getAdapterSources: () => identity.adapterSources,
      })
    }
    const manifest = {
      schemaVersion: 4 as const,
      probeHash: "mode-source-composition-fixture",
      adapterVersion: "fixture",
      catalogIds: ids,
      probes: { term: [], mux: [], lib: ids },
    }
    const draft = initializeRunDraft({
      source: { kind: "live" },
      runId: `mode-source-composition-${name}`,
      sourceRevision: "a".repeat(40),
      intendedSubject: { kind: "lib", id: name },
      manifest,
    })
    const definitions = registryDefinitions(ids)
    for (const definition of definitions) expect(definition.libAssertionType, definition.id).toBeUndefined()
    const batch = await collectBatch(carrier, name, definitions, draft, undefined, {
      identity,
      adapterPath: Bun.resolveSync(adapterPackage, fileURLToPath(import.meta.url)),
      adapterPackage,
      adapterType: "js",
    })
    const captured: CapturedRunDraft = {
      ...draft,
      subject: {
        kind: "lib",
        id: name,
        version: identity.engineVersion,
        os: "linux",
        osVersion: null,
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      identity: "unverified",
      runtimeIdentity: identity,
      measuredAt: new Date().toISOString(),
      origin: { kind: "collector" },
      rawReplies: { ...draft.rawReplies, ...batch.rawReplies },
      results: batch.results,
      assertions: batch.assertions,
    }
    for (const id of ids) {
      expect(
        captured.results.find((entry) => entry.featureId === id),
        id,
      ).toMatchObject(
        name !== "xtermjs"
          ? { status: "test-todo" }
          : {
              status: id === "modes.color-scheme-reporting" ? "unsupported" : "supported",
              assertionType: id === "input.pixel-mouse" ? "input_bytes" : "query_reply",
            },
      )
      // #32246: the formerly audited vterm identities take no source branch and carry no typed negative.
      if (name !== "xtermjs") {
        const row = captured.results.find((entry) => entry.featureId === id)!
        expect(row, id).not.toHaveProperty("criterionBranch")
        expect(row, id).not.toHaveProperty("assertionType")
      }
      expect(JSON.stringify(batch.ungradedDiagnostics[id] ?? {}), id).not.toContain("collector-error")
      if (name === "xtermjs") {
        expect(
          batch.assertions.filter((assertion) => assertion.featureId === id),
          id,
        ).toMatchObject([
          {
            assertionType: id === "input.pixel-mouse" ? "input_bytes" : "query_reply",
            kind: id === "modes.color-scheme-reporting" ? "negative" : "positive",
          },
        ])
        expect(JSON.parse(batch.rawReplies[id]!), id).toMatchObject(
          id === "input.pixel-mouse"
            ? {
                report: "\x1b[<0;41;25M",
              }
            : {
                setReply: id === "modes.synchronized-output" ? "\x1b[?2026;1$y" : "\x1b[?2031;0$y",
              },
        )
      } else if (id === "input.pixel-mouse") {
        expect(JSON.parse(batch.rawReplies[id]!), id).toMatchObject({
          commands: ["\x1b[?1016h", "\x1b[?1016l"],
          line: "XX",
          position: { x: 2, y: 0 },
          control: "consumed-without-effect",
        })
      }
    }
    const parsed = parseRun(
      "mode-source.capture.json",
      JSON.stringify(captured),
      ids,
      new Map([[manifest.probeHash, manifest]]),
    )
    expect(parsed.results).toHaveLength(3)
    for (const row of parsed.results ?? []) {
      expect(row).toMatchObject(
        name !== "xtermjs"
          ? { status: "test-todo" }
          : {
              status: row.featureId === "modes.color-scheme-reporting" ? "unsupported" : "supported",
              assertionType: row.featureId === "input.pixel-mouse" ? "input_bytes" : "query_reply",
            },
      )
    }
  }
})

// A registered callback can lose its marker while a synthetic marked callback still passes.
// Missing qualification must not turn its configured, silent writer into producer absence.
test("retains registered reply failure evidence when the writer is unqualified", async () => {
  const id = "device.dsr-996-color-scheme"
  const definition = ALL_PROBES.find((entry) => entry.id === id)!
  const batch = await collectBatch(backend, "xtermjs", [definition])
  expect(JSON.parse(batch.rawReplies["collector.replyPath"]!)).toMatchObject({
    decisions: {
      [id]: {
        member: false,
        reason: "xtermjs has no measured runtime identity for reply delivery",
      },
    },
  })
  const result = batch.results[0]!
  expect(result.status).toBe("test-failure")
  expect(result.reason).toContain(`sent ${JSON.stringify("\x1b[?996n")}; received ""`)
  expect(result.reason).toContain("synchronous feed and getCursor boundary; timeout not applicable")
  expect(result.tests).toMatchObject([{ id: "criterion", status: "test-failure", rawReplyRef: id }])
  expect(batch.rawReplies[id]).toBe("")
})

// The collector must use actual feedCapture evidence only when the callback requests it.
// Callback-only tests cannot establish this production adapter/sink boundary.
test.each([false, true])("retains only marked synchronous reply failure evidence (marked: %s)", async (marked) => {
  const definition = ALL_PROBES.find((entry) => entry.id === "cursor.position-report")!
  const batch = await collectBatch(backend, "xtermjs", [
    {
      ...definition,
      lib(ctx) {
        expect(ctx.feedCapture("\x1b[9999n")).toBe("")
        return marked
          ? replyFailure("No probe reply")
          : { pass: false, tests: [{ id: "criterion", status: "test-failure", reason: "No probe reply" }] }
      },
    },
  ])
  const result = batch.results[0]!
  expect(result.status).toBe("test-failure")
  expect(result.reason).toBe(
    marked
      ? 'No probe reply; sent "\\u001b[9999n"; received ""; synchronous feed and getCursor boundary; timeout not applicable'
      : "No probe reply",
  )
  expect(JSON.stringify(batch)).not.toContain("replyFailureTestIds")
})

// Malformed corroborating replies must stay visible after the real callback/collector boundary;
// valid retained-state fixtures cannot distinguish bad input from silence.
test.each([
  ["extensions.osc17-highlight-bg", "OSC"],
  ["extensions.sixel-da1", "DA1"],
  ["extensions.sixel-geometry-report", "Sixel geometry"],
] as const)("%s stores malformed extension reply reasons", async (id, kind) => {
  const definition = ALL_PROBES.find((entry) => entry.id === id)!
  const reply = "garbage"
  const batch = await collectBatch(backend, "xtermjs", [
    {
      ...definition,
      lib(context) {
        // Controlled received bytes exercise the actual callback and stored-row precedence.
        return definition.lib!({ ...context, queryWithSentinelOutcome: undefined, feedCapture: () => reply })
      },
    },
  ])
  const reason = `Malformed ${kind} reply: ${JSON.stringify(reply)}`
  expect(batch.results).toMatchObject([{ status: "test-failure", reason, tests: [{ reason }] }])
  expect(batch.rawReplies[id]).toBe(reply)
  expect(JSON.stringify(batch)).not.toContain("replyFailureTestIds")
})

test.each([
  { query: "\x1b[18t", reply: "not-a-size-reply", note: "Malformed 18t reply", disagree: false },
  {
    query: "\x1b[?3$p",
    reply: "not-a-mode-reply",
    note: "Malformed or out-of-range DECRPM mode 3 reply",
    disagree: false,
  },
  { query: "\x1b[?3$p", reply: "\x1b[?3;9$y", note: "Malformed or out-of-range DECRPM mode 3 reply", disagree: false },
  { query: "\x1b[18t", reply: "", note: null, disagree: false },
  { query: "\x1b[18t", reply: "not-a-size-reply", note: "Malformed 18t reply", disagree: true },
  {
    query: "\x1b[?3$p",
    reply: "not-a-mode-reply",
    note: "Malformed or out-of-range DECRPM mode 3 reply",
    disagree: true,
  },
])(
  "DECCOLM retains corroborating reply diagnostics: $reply (disagreement: $disagree)",
  async ({ query, reply, note, disagree }) => {
    const definition = ALL_PROBES.find((entry) => entry.id === "modes.deccolm")!
    const batch = await collectBatch(backend, "xtermjs", [
      {
        ...definition,
        lib(context) {
          const capture = context.feedCapture.bind(context)
          let sizeReplies = 0
          context.feedCapture = (sequence) => {
            if (disagree && sequence === "\x1b[18t" && ++sizeReplies === 2) return "\x1b[8;24;100t"
            return sequence === query ? reply : capture(sequence)
          }
          return definition.lib!(context)
        },
      },
    ])
    expect(batch.results).toMatchObject([{ status: disagree ? "test-failure" : "unsupported" }])
    const diagnostic =
      batch.observations[0]?.note ?? batch.results[0]?.tests.find((test) => test.id === "criterion")?.reason
    if (disagree) {
      expect(batch.observations).toEqual([])
      expect(diagnostic).toContain("18t/sweep disagreement")
    } else {
      expect(batch.assertions.length).toBeGreaterThan(0)
    }
    if (note) {
      expect(diagnostic).toContain(note)
      expect(diagnostic).toContain(JSON.stringify(reply))
    } else {
      expect(diagnostic).not.toMatch(/Malformed/)
    }
    expect(batch.assertions.every((assertion) => assertion.observed === batch.rawReplies[definition.id])).toBe(true)
  },
)

// Callback-only tests missed the eight real collector refusals. Replay only their retained
// state through the deciding callback and collector; this fixture does not execute these engines.
test.each(retainedDeccolm.rows)("DECCOLM retained $engine state survives the strict collector", async (sample) => {
  const definition = ALL_PROBES.find((entry) => entry.id === "modes.deccolm")!
  const reads = JSON.parse(sample.raw) as Parameters<typeof cellWidthTransition>[0]
  const callback = cellWidthTransition(reads)
  expect(callback.response).toBe(sample.raw)
  if (!callback.observation) throw new Error(`Retained ${sample.engine} state must produce a measured callback`)
  const collect = (result: ProbeCallbackResult) =>
    collectBatch(backend, "xtermjs", [{ ...definition, lib: () => result }])
  const legacy = await collect({
    ...callback,
    assertions: sample.legacyAssertions.map((assertion) => ({
      ...assertion,
      assertionType: "buffer_state" as const,
      kind: assertion.kind === "positive" ? ("positive" as const) : ("negative" as const),
    })),
  })
  expect(legacy.results).toMatchObject([{ status: "test-failure" }])
  expect(legacy.results[0]!.tests[0]!.reason).toContain("lacks matching raw state and assertion")
  expect(legacy.rawReplies[definition.id]).toBe(sample.raw)
  const repaired = await collect(callback)
  expect(repaired.results).toMatchObject([{ status: sample.expected, assertionType: "buffer_state" }])
  expect(repaired.rawReplies[definition.id]).toBe(sample.raw)
  expect(repaired.assertions[0]!.observed).toBe(sample.raw)
  // Unit metadata is explicitly unverified; it grants no historical suite or engine attestation.
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "deccolm-reader-fixture",
    adapterVersion: "fixture",
    catalogIds: [definition.id],
    probes: { term: [], mux: [], lib: [definition.id] },
  }
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: `deccolm-reader-${sample.engine}`,
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "xtermjs" },
    manifest,
  })
  const captured: CapturedRunDraft = {
    ...draft,
    subject: {
      kind: "lib",
      id: "xtermjs",
      version: "fixture",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    runtimeIdentity: {
      kind: "js",
      engineVersion: "fixture",
      adapterVersion: "fixture",
      termlessRevision: "fixture",
      resolvedPath: "fixture/xtermjs",
      integrity: { kind: "registry", lockIntegrity: "fixture" },
      runtimeFormat: "js",
    },
    measuredAt: "2026-10-30T18:34:00.000Z",
    origin: { kind: "collector" },
    rawReplies: { ...draft.rawReplies, ...repaired.rawReplies },
    results: repaired.results,
    assertions: repaired.assertions,
  }
  const parsed = parseRun(
    sample.engine,
    JSON.stringify(captured),
    manifest.catalogIds,
    new Map([[manifest.probeHash, manifest]]),
  )
  expect(parsed.results).toMatchObject([{ featureId: definition.id, status: sample.expected }])
  expect(
    repaired.assertions.every(
      (assertion) => assertion.kind === (sample.expected === "supported" ? "positive" : "negative"),
    ),
  ).toBe(true)
  expect(callback.observation?.note).toContain(`initial=${reads.initial.kind === "width" ? reads.initial.width : ""}`)
})

// The old null arm left this real-source feature unattempted; fake callback tests cannot
// catch a missing registry schedule or actuator forward at the production recorder boundary.
test("viewport hold records a real xterm measurement and both output phases", async () => {
  const id = "scrollback.viewport-hold-output"
  const batch = await collectBatch(backend, "xtermjs", registryDefinitions([id]))
  expect(batch.results).toMatchObject([{ featureId: id, status: "supported", attempt: { scope: "probe" } }])
  expect(batch.observations).toMatchObject([{ featureId: id, outcome: "supported", assertionType: "buffer_state" }])
  expect(batch.assertions).toMatchObject([{ featureId: id, kind: "positive", assertionType: "buffer_state" }])
  expect(JSON.parse(batch.rawReplies[id]!)).toMatchObject({
    ordinary: { outcome: "hold", markerObserved: true },
    synchronized: { outcome: "hold", markerObserved: true },
  })
})

test("the real viewport Scrollback contract replays deterministically and satisfies its decided row", async () => {
  const row: GroupContract[number] = {
    id: "scrollback.viewport-hold-output",
    expected: "decided",
    claim: "The viewport holds on ordinary and synchronized output",
  }
  const probe = ALL_PROBES.find((entry) => entry.id === row.id)
  if (!probe) throw new Error(`Missing Scrollback probe ${row.id}`)
  expect(probe.lib !== null || probe.term !== null, `${row.id} has no callback`).toBe(true)
  {
    const backend = createXtermBackend()
    backend.init({ cols: 80, rows: 24 })
    try {
      const source = () => createLibProbeSource(backend, undefined, undefined, undefined)
      const first = await regradeRow(probe, row, { headless: source() })
      const second = await regradeRow(probe, row, { headless: source() })
      expect(second.after, `${row.id} is not deterministic`).toBe(first.after)
      expect(second.satisfies, `${row.id} satisfaction is not deterministic`).toBe(first.satisfies)
      expect(first.satisfies, `${row.id} must route through satisfiesContract`).toBe(
        satisfiesContract(row, first.after),
      )
    } finally {
      backend.destroy()
    }
  }
  {
    const backend = createXtermBackend()
    backend.init({ cols: 80, rows: 24 })
    try {
      const required = row.expected === "decided" ? "supported" : row.expected
      const graded = await regradeRow(probe, row, {
        headless: createLibProbeSource(backend, undefined, undefined, undefined),
      })
      expect(graded.after, `${row.id} reads ${required} from a surface implementing its claim`).toBe(required)
      expect(graded.satisfies, `${row.id} satisfies its contract row`).toBe(true)
    } finally {
      backend.destroy()
    }
  }
})

// #31804 repaired the pinned engine's anchor; #31803 merges second and retains the real witness.
test("real vterm holds the absolute viewport anchor in both output phases", async () => {
  const probe = ALL_PROBES.find((entry) => entry.id === "scrollback.viewport-hold-output")
  if (!probe?.lib) throw new Error("Missing scrollback.viewport-hold-output headless callback")
  const backend = await createVtermBackend()
  backend.init({ cols: 80, rows: 24 })
  try {
    const result = probe.lib(createLibProbeSource(backend, undefined, undefined, undefined))
    expect(result.observation?.outcome).toBe("supported")
    expect(result.assertions).toMatchObject([{ kind: "positive", assertionType: "buffer_state" }])
    expect(JSON.parse(result.response!)).toMatchObject({
      ordinary: { outcome: "hold", markerObserved: true },
      synchronized: { outcome: "hold", markerObserved: true },
    })
  } finally {
    backend.destroy()
  }
})

// Scripted callback tests cannot detect a producer declaration lost at the real adapter/collector/writer boundary.
// These are private unit captures: no source-derived Untestable decision or identity verification is applied.
test.each([
  ["wezterm", async () => createWeztermBackend()],
  ["libvterm", resolveLibvterm],
] as const)(
  "retains %s viewport absence through production collection and immutable writer binding",
  async (name, producer) => {
    const id = "scrollback.viewport-hold-output"
    const declaredBackend = await producer()
    const declaration = declaredBackend.capabilities.productViewport
    expect(declaration).toMatchObject({
      available: false,
      reason: expect.stringContaining(name === "wezterm" ? "Screen" : "libvterm"),
    })
    declaredBackend.destroy()
    // Carry the real producer's declaration on the existing JS harness: absence performs no engine I/O,
    // and this transport contract must run without the optional WezTerm native addon (including hosted CI).
    // An xterm-named carrier also proves omission is capability-derived rather than an engine-name list.
    const factory = async () => {
      const value = createXtermBackend()
      value.capabilities.productViewport = declaration
      return value
    }
    const instance = await factory()
    instance.init({ cols: 80, rows: 24 })
    try {
      const source = createLibProbeSource(instance, undefined, undefined, undefined)
      expect(source.capabilities.productViewport).toEqual(declaration)
      expect(source.scrollViewport).toBeUndefined()
    } finally {
      instance.destroy()
    }
    const draft = initializeRunDraft({
      source: { kind: "live" },
      runId: `viewport-absence-${name}`,
      sourceRevision: "a".repeat(40),
      intendedSubject: { kind: "lib", id: name },
      manifest: {
        schemaVersion: 4,
        probeHash: "viewport-absence-suite",
        adapterVersion: "3",
        catalogIds: [id],
        probes: { term: [], mux: [], lib: [id] },
      },
    })
    const batch = await collectBatch(factory, name, registryDefinitions([id]), draft)
    expect(batch.results).toMatchObject([
      {
        featureId: id,
        status: "test-todo",
        criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
        tests: [{ id: "review", status: "test-todo", reason: declaration!.reason }],
      },
    ])
    expect(batch.observations).toEqual([])
    expect(batch.assertions).toEqual([])
    expect(JSON.parse(batch.rawReplies[id]!)).toMatchObject({ productViewport: declaration })
    expect(JSON.parse(batch.rawReplies[id]!)).not.toHaveProperty("runtimeIdentity")
    const captured: CapturedRunDraft = {
      ...draft,
      subject: {
        kind: "lib",
        id: name,
        version: "unit-fixture",
        os: "linux",
        osVersion: null,
        outerTerminal: null,
        mux: null,
        config: null,
        permissions: null,
      },
      identity: "unverified",
      measuredAt: "2026-10-30T01:00:00.000Z",
      origin: { kind: "collector" },
      rawReplies: { ...draft.rawReplies, ...batch.rawReplies },
      assertions: batch.assertions,
      results: batch.results,
    }
    const finalized = finalizeCollectedDraft(captured)
    expect(finalized.results).toEqual(batch.results)
    expect(finalized.rawReplies[id]).toBe(batch.rawReplies[id])
  },
)

// Nullable mode metadata still permits measured wrapping from actual cell behavior.
test("null mode metadata classes A/B retain measured wrapping, unknown cleanup and raw state", async () => {
  const writes: string[] = []
  const factory = async () => {
    const value = await resolveLibvterm()
    // Pin nullable metadata independently of each adapter's available native readers.
    // The subject is Terminfo's null-mode consumers, not native reader availability.
    vi.spyOn(value, "getMode").mockReturnValue(null as unknown as boolean)
    const feed = value.feed.bind(value)
    vi.spyOn(value, "feed").mockImplementation((bytes) => {
      writes.push(new TextDecoder().decode(bytes))
      feed(bytes)
    })
    return value
  }
  const batch = await collectBatch(
    factory,
    "libvterm",
    registryDefinitions([
      "modes.auto-wrap",
      "cursor.reverse-wrap",
      "modes.application-keypad",
      "modes.color-scheme-reporting",
      "modes.left-right-margin",
      "modes.altscreen-47",
      "modes.altscreen-1047",
    ]),
  )
  expect.soft(batch.observations.find((row) => row.featureId === "modes.auto-wrap")).toMatchObject({
    outcome: "supported",
    assertionType: "buffer_state",
  })
  expect.soft(writes).not.toContain("\x1b[?7l")
  // Mode 2031 now measures DECRPM recognition and resets its enabled query state, even with null metadata.
  expect.soft(writes).toContain("\x1b[?2031l")
  expect.soft(JSON.parse(batch.rawReplies["modes.application-keypad"]!)).toMatchObject({
    setMode: null,
    resetMode: null,
  })
  expect.soft(writes).toContain("\x1b=")
  expect.soft(writes).toContain("\x1b>")
  // #30702: the margin and alternate-screen arms read the cells, so their raw state is the seeded frames.
  expect.soft(JSON.parse(batch.rawReplies["modes.left-right-margin"]!)).toMatchObject({
    seed: "ABCDEFGH",
    margins: "3-6",
  })
  for (const id of ["modes.altscreen-47", "modes.altscreen-1047"]) {
    expect.soft(JSON.parse(batch.rawReplies[id]!), id).toMatchObject({ seedA: "PRIMARY-A", seedB: "PRIMARY-B" })
  }
  expect(batch.results.find((row) => row.featureId === "modes.application-keypad")).toMatchObject({
    status: "test-todo",
    reason: expect.stringContaining("adapter binding libvterm applicationKeypad"),
  })
})

// The callback criterion can name the Ps while the collector must still keep the exact transport bytes.
test.each([0, 1, 4] as const)(
  "OSC 5522 Ps %s retains detection and raw bytes through the production batch recorder",
  async (ps) => {
    const id = "extensions.osc5522-clipboard"
    const response = `\x1b[?5522;${ps}$y\x1b[?1;2c`
    const value = await backend()
    const feed = value.feed.bind(value)
    vi.spyOn(value, "feed").mockImplementation((bytes) => {
      if (new TextDecoder().decode(bytes) === "\x1b[?5522$p") {
        value.onResponse?.(new TextEncoder().encode(response))
      } else feed(bytes)
    })
    const batch = await collectBatch(async () => value, "xtermjs", registryDefinitions([id]))
    expect(batch.rawReplies[id]).toBe(response)
    const supported = ps === 1
    expect(batch.observations).toMatchObject([
      { featureId: id, outcome: supported ? "supported" : "unsupported", assertionType: "query_reply" },
    ])
    expect(batch.assertions).toMatchObject([{ featureId: id, kind: supported ? "positive" : "negative" }])
    expect(batch.results.find((result) => result.featureId === id)?.status).toBe(
      supported ? "supported" : "unsupported",
    )
  },
)

// Missing-input callback tests never exercised the production recorder, so these
// OS-window criteria stayed generic TODOs with no review a collector could retain.
test("separates mode readback from headless OS-input review without fabricating app delivery", async () => {
  const ids = [
    "input.xtest-key",
    "extensions.clipboard-paste",
    "input.modify-other-keys",
    "input.modify-other-keys-3",
    "modes.alt-scroll-1007",
    "modes.application-keypad",
  ]
  const modeIds = new Set(["modes.alt-scroll-1007", "modes.application-keypad"])
  const definitions = ids.map((id) => {
    const found = ALL_PROBES.find((probe) => probe.id === id)
    if (!found) throw new Error(`Missing registry definition ${id}`)
    return found
  })
  const batch = await collectBatch(backend, "xtermjs", definitions)
  expect(batch.results).toHaveLength(ids.length)
  expect(batch.observations).toMatchObject([
    { featureId: "modes.alt-scroll-1007", outcome: "unsupported", assertionType: "query_reply" },
    { featureId: "modes.application-keypad", outcome: "supported", assertionType: "buffer_state" },
  ])
  expect(batch.assertions).toMatchObject([
    { featureId: "modes.alt-scroll-1007", kind: "negative" },
    { featureId: "modes.application-keypad", kind: "positive" },
  ])
  expect(batch.ungradedDiagnostics).toEqual({})
  for (const result of batch.results) {
    if (modeIds.has(result.featureId)) {
      expect(result.status).toBe(result.featureId === "modes.application-keypad" ? "supported" : "unsupported")
      expect(result.assertionType).toBe(
        result.featureId === "modes.application-keypad" ? "buffer_state" : "query_reply",
      )
      expect(batch.notTested.some((row) => row.featureId === result.featureId)).toBe(false)
      continue
    }
    expect(result.status, result.featureId).toBe("test-todo")
    const expected = { reason: /OS-level XTEST/, raw: { input: false } }
    expect(result.reason, result.featureId).toMatch(expected.reason)
    expect(result.rawReplyRef, result.featureId).toBe(result.featureId)
    expect(JSON.parse(batch.rawReplies[result.featureId]!), result.featureId).toMatchObject(expected.raw)
    expect(batch.notTested, result.featureId).toContainEqual({
      featureId: result.featureId,
      reason: "no-semantic-observable",
      noObservable: expect.stringMatching(expected.reason),
      rawReplyRef: result.featureId,
    })
    expect(result.criterionBranch, result.featureId).toBe("os-input-review")
    expect(result.tests, result.featureId).toContainEqual(
      expect.objectContaining({
        id: "review",
        status: "test-todo",
        attempt: { scope: "none" },
        rawReplyRef: result.featureId,
        reason: expect.any(String),
      }),
    )
  }
})

// @failure A library mouse criterion borrows OS-input review instead of observing the real Vterm encoder.
// @level l1
// @consumer The production library collector and canonical capture parser.
test.each([
  ["input.pixel-mouse", "\x1b[<0;41;25M"],
  ["input.x10-mouse", "\x1b[M %#"],
  ["input.urxvt-mouse", "\x1b[32;5;3M"],
  ["input.button-event-mouse", "\x1b[<32;5;3M"],
  ["input.xtest-click", "\x1b[<0;5;3M"],
  ["input.xtest-wheel", "\x1b[<64;5;3M"],
])("Vterm %s mouse report survives real collector and canonical parser", async (id, report) => {
  const batch = await collectBatch(async () => createVtermBackend(), "vterm", registryDefinitions([id]))
  expect(batch.results).toMatchObject([{ featureId: id, status: "supported", assertionType: "input_bytes" }])
  expect((JSON.parse(batch.rawReplies[id]!) as { report: string }).report).toBe(report)
  expect(batch.assertions).toMatchObject([{ featureId: id, kind: "positive", assertionType: "input_bytes" }])
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "mouse-reader-fixture",
    adapterVersion: "fixture",
    catalogIds: [id],
    probes: { term: [], mux: [], lib: [id] },
  }
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "mouse-reader-fixture",
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "vterm" },
    manifest,
  })
  const captured: CapturedRunDraft = {
    ...draft,
    subject: {
      kind: "lib",
      id: "vterm",
      version: "fixture",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    runtimeIdentity: {
      kind: "js",
      engineVersion: "fixture",
      adapterVersion: "fixture",
      termlessRevision: "fixture",
      resolvedPath: "fixture/vterm",
      integrity: { kind: "registry", lockIntegrity: "fixture" },
      runtimeFormat: "js",
    },
    measuredAt: "2026-11-02T06:25:00.000Z",
    origin: { kind: "collector" },
    rawReplies: batch.rawReplies,
    results: batch.results,
    assertions: batch.assertions,
  }
  const parsed = parseRun(
    "mouse.capture.json",
    JSON.stringify(captured),
    [id],
    new Map([[manifest.probeHash, manifest]]),
  )
  expect(parsed.results).toEqual(batch.results)
  expect(parsed.assertions).toEqual(batch.assertions)
  const actionless = structuredClone(captured)
  delete actionless.assertions[0]!.action
  expect(() =>
    parseRun(
      "mouse-actionless.capture.json",
      JSON.stringify(actionless),
      [id],
      new Map([[manifest.probeHash, manifest]]),
    ),
  ).toThrow("requires the performed action")
})

// @failure A Vterm input cell at the formerly audited identity is graded from source, or its TEST TODO coverage record
//   is lost when recorded as a real headless batch (#32246).
// @consumer The four registered Vterm input callbacks through collectBatch; no capture or attestation.
test("formerly audited Vterm input cells record TEST TODO coverage through the collector", async () => {
  const ids = ["input.modify-other-keys", "input.modify-other-keys-3", "input.xtest-key", "input.kitty-click-events"]
  // Identity is a unit fixture; it does not attest this runner or grant collection/admission.
  const identity = {
    kind: "js",
    runtimeFormat: "js",
    engineVersion: "0.10.1",
    adapterVersion: "0.10.2",
    termlessRevision: "a871f0e580e1b02fb5dbb7ed854f6de623e7858e",
    resolvedPath: "vendor/vterm/packages/vterm/src/index.ts",
    adapterSources: [{ path: "packages/vterm/src/index.ts", blobOid: "a".repeat(40) }],
    integrity: {
      kind: "source",
      repository: "git@github.com:beorn/vterm.git",
      revision: "67dd3960746766ed47e2bb4b2ced6503a78549cc",
      treeOid: "e9d67d4b4ba7cb4caf0d0824b3b272c10e4b229e",
      cleanTree: true,
    },
  } as const
  vi.spyOn(headlessIdentity, "headlessRuntimeIdentity").mockResolvedValue(identity)
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "vterm-input-source-review-parser-fixture",
    adapterVersion: "fixture",
    catalogIds: ids,
    probes: { term: [], mux: [], lib: ids },
  }
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "vterm-input-source-review-parser-fixture",
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "vterm" },
    manifest,
  })
  const batch = await collectBatch(
    async () => {
      const value = createVtermBackend()
      value.getAdapterSources = () => identity.adapterSources
      return value
    },
    "vterm",
    registryDefinitions(ids),
    draft,
    undefined,
    {
      identity,
      adapterPath: Bun.resolveSync("@termless/vterm", fileURLToPath(import.meta.url)),
      adapterPackage: "@termless/vterm",
      adapterType: "js",
    },
  )
  const captured: CapturedRunDraft = {
    ...draft,
    subject: {
      kind: "lib",
      id: "vterm",
      version: identity.engineVersion,
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    runtimeIdentity: identity,
    measuredAt: "2026-11-02T10:14:58.000Z",
    origin: { kind: "collector" },
    rawReplies: batch.rawReplies,
    results: batch.results,
    assertions: batch.assertions,
  }
  const parsed = parseRun(
    "vterm-input-source-review.capture.json",
    JSON.stringify(captured),
    ids,
    new Map([[manifest.probeHash, manifest]]),
  )
  expect(parsed.results).toEqual(batch.results)
  expect(parsed.assertions).toEqual([])
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.results).toHaveLength(ids.length)
  expect(batch.notTested).toEqual(
    ids.map((id) => ({
      featureId: id,
      reason: "no-semantic-observable",
      noObservable: NO_SAME_PATH_CONTROL,
      rawReplyRef: id,
    })),
  )
  for (const id of ids) {
    const row = batch.results.find((entry) => entry.featureId === id)
    expect(row).toMatchObject({ status: "test-todo" })
    expect(row?.criterionBranch).toBeUndefined()
    expect(row?.assertionType).toBeUndefined()
  }
  expect(batch.assertions).toEqual([])
  expect(batch.observations).toEqual([])
})

// @failure Unknown state and named unavailable input become measured negatives, or programming errors become TODO.
// @level l1
// @consumer The production mouse library arm through the real collector.
test("mouse collector distinguishes unavailable state/pixels, measured no-report and unexpected errors", async () => {
  const kitty = await collectBatch(
    async () => createVtermBackend(),
    "vterm",
    registryDefinitions(["input.kitty-click-events"]),
  )
  // #32246: the former source review of the kitty click encoder is TEST TODO coverage with no same-path control.
  expect(kitty.results).toMatchObject([{ status: "test-todo", reason: NO_SAME_PATH_CONTROL }])
  const id = "input.pixel-mouse"
  const reset = "\x1b[?9;1000;1002;1003;1005;1006;1015;1016l"
  const cases: { state: boolean | null; error?: string; expected: string }[] = [
    { state: null, expected: "test-todo" },
    { state: true, expected: "unsupported" },
    {
      state: true,
      error: "mouse encoding unavailable: fixture pixel binding unavailable",
      expected: "test-todo",
    },
    { state: true, error: "broken encoder invariant", expected: "test-failure" },
  ]
  for (const { state, error, expected } of cases) {
    const backend = createVtermBackend()
    const feed = vi.spyOn(backend, "feed")
    vi.spyOn(backend, "getMode").mockReturnValue(state)
    vi.spyOn(backend, "encodeMouse")
      .mockReturnValueOnce(null)
      .mockImplementation(() => {
        if (error) throw new Error(error)
        return null
      })
    const batch = await collectBatch(async () => backend, "vterm", registryDefinitions([id]))
    expect(batch.results).toMatchObject([{ featureId: id, status: expected }])
    if (expected === "unsupported") {
      expect(batch.assertions).toMatchObject([{ featureId: id, kind: "negative", assertionType: "input_bytes" }])
      expect(JSON.parse(batch.rawReplies[id]!)).toMatchObject({ negativeControl: null, report: null })
    } else expect(batch.assertions).toEqual([])
    if (error) expect(batch.results[0]!.reason).toContain(error)
    const writes = feed.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))
    expect(writes.at(-1)).toBe(reset)
    expect(writes).toContain("\x1b[?1000h\x1b[?1016h")
  }
  const backend = createVtermBackend()
  const feed = vi.spyOn(backend, "feed")
  vi.spyOn(backend, "encodeMouse").mockReturnValue(new TextEncoder().encode("\x1b[<0;41;25M"))
  const broken = await collectBatch(async () => backend, "vterm", registryDefinitions([id]))
  expect(broken.results).toMatchObject([
    { featureId: id, status: "test-failure", reason: expect.stringContaining("tracking reset") },
  ])
  expect(new TextDecoder().decode(feed.mock.calls.at(-1)![0])).toBe(reset)
})

// @failure Cell coordinates are falsely accepted as a pixel-coordinate witness.
// @level l1
// @consumer The production pixel library criterion with explicit cell and pixel coordinates.
test("pixel library arm never grades a cell-coordinate encoder report", async () => {
  const backend = createVtermBackend()
  const encode = vi
    .spyOn(backend, "encodeMouse")
    .mockReturnValueOnce(null)
    .mockReturnValue(new TextEncoder().encode("\x1b[<0;5;3M"))
  const batch = await collectBatch(async () => backend, "vterm", registryDefinitions(["input.pixel-mouse"]))
  expect(batch.results).toMatchObject([{ status: "unsupported", assertionType: "input_bytes" }])
  expect(JSON.parse(batch.rawReplies["input.pixel-mouse"]!)).toMatchObject({
    tracking: true,
    negativeControl: null,
    report: "\x1b[<0;5;3M",
  })
  expect(encode).toHaveBeenCalledTimes(2)
  expect(batch.assertions).toMatchObject([{ kind: "negative", assertionType: "input_bytes" }])
})

// @failure Supplied pixel coordinates never reach xtermjs's native delegated encoder.
// @level l1
// @consumer The production xtermjs mouse criteria through its own delegated engine encoder.
test("xtermjs library mouse arms retain measured cell and supplied-pixel reports", async () => {
  const ids = [
    "input.button-event-mouse",
    "input.pixel-mouse",
    "input.urxvt-mouse",
    "input.x10-mouse",
    "input.xtest-click",
    "input.xtest-wheel",
  ]
  const batch = await collectBatch(backend, "xtermjs", registryDefinitions(ids))
  expect(batch.results.map(({ featureId, status }) => ({ featureId, status }))).toEqual([
    { featureId: ids[0], status: "supported" },
    { featureId: ids[1], status: "supported" },
    { featureId: ids[2], status: "unsupported" },
    { featureId: ids[3], status: "supported" },
    { featureId: ids[4], status: "supported" },
    { featureId: ids[5], status: "supported" },
  ])
  expect(JSON.parse(batch.rawReplies[ids[1]!]!)).toMatchObject({ report: "\x1b[<0;41;25M" })
  expect(JSON.parse(batch.rawReplies[ids[2]!]!)).toMatchObject({ report: "\x1b[M %#" })
})

// @failure Legacy collection without runtime source identity loses ordinary mouse TODO or accepted-decision carry.
// @level l1
// @consumer Natural collection's accepted-decision carry and the canonical capture reader.
// This legacy path omits runtime source identity. The source-qualified journey above covers audited engines.
test("legacy collection without source identity keeps mouse tool gaps TODO and its old accepted record", async () => {
  const ids = [
    "input.button-event-mouse",
    "input.pixel-mouse",
    "input.urxvt-mouse",
    "input.x10-mouse",
    "input.xtest-click",
    "input.xtest-wheel",
  ]
  const actual = await resolveVt100()
  try {
    expect(actual.capabilities.extensions.has("mouse-encoding")).toBe(false)
  } finally {
    actual.destroy()
  }
  const batch = await collectBatch(resolveVt100, "vt100", registryDefinitions(ids))
  expect(batch.results.map((row) => row.featureId)).toEqual(ids)
  for (const row of batch.results) {
    expect(row.status).toBe("test-todo")
    expect(row.reason).toContain("mouse-encoding extension unavailable")
    expect(row.criterionBranch).toBeUndefined()
    expect(row.tests?.some((test) => test.id === "review" || test.reviewRef !== undefined)).not.toBe(true)
    expect(JSON.parse(batch.rawReplies[row.featureId]!)).toEqual({ mouseEncoding: false })
  }
  expect(batch.assertions).toEqual([])
  expect(batch.observations).toEqual([])
  expect(batch.ungradedDiagnostics).toEqual({})
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "mouse-gap-reader-fixture",
    adapterVersion: "fixture",
    catalogIds: ids,
    probes: { term: [], mux: [], lib: ids },
  }
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "mouse-gap-reader-fixture",
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "vt100" },
    manifest,
  })
  // Existing unverified unit metadata; no runtime attestation, real capture or review actuation.
  const captured: CapturedRunDraft = {
    ...draft,
    subject: {
      kind: "lib",
      id: "vt100",
      version: "fixture",
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    runtimeIdentity: {
      kind: "js",
      engineVersion: "fixture",
      adapterVersion: "fixture",
      termlessRevision: "fixture",
      resolvedPath: "fixture/vt100",
      integrity: { kind: "registry", lockIntegrity: "fixture" },
      runtimeFormat: "js",
    },
    measuredAt: "2026-11-02T07:05:00.000Z",
    origin: { kind: "collector" },
    rawReplies: batch.rawReplies,
    results: batch.results,
    assertions: batch.assertions,
  }
  const original = globalThis.structuredClone(captured)
  const enriched = finalizeCollectedDraft(captured)
  expect(enriched.results).toEqual(batch.results)
  expect(enriched.rawReplies).toEqual(batch.rawReplies)
  expect(enriched).not.toHaveProperty("sealedAt")
  expect(captured).toEqual(original)
  const parsed = parseRun(
    "mouse-gap.capture.json",
    JSON.stringify(enriched),
    ids,
    new Map([[manifest.probeHash, manifest]]),
  )
  expect(parsed.results).toEqual(batch.results)
  expect(parsed.assertions).toEqual([])
})

test("input.kitty-click-events measures unsupported on xtermjs via the delegated mouse-encoding extension and enforces C3 wiring", async () => {
  const id = "input.kitty-click-events"
  const batch = await collectBatch(backend, "xtermjs", registryDefinitions([id]))
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.results).toMatchObject([
    {
      featureId: id,
      status: "unsupported",
      attempt: { scope: "probe" },
      assertionType: "input_bytes",
      rawReplyRef: id,
    },
  ])
  expect(batch.observations).toMatchObject([
    {
      featureId: id,
      outcome: "unsupported",
      assertionType: "input_bytes",
      rawReplyRef: id,
    },
  ])
  expect(batch.assertions).toMatchObject([
    {
      featureId: id,
      kind: "negative",
      action: "kitty-click-events:1",
      assertionType: "input_bytes",
      rawReplyRef: id,
    },
  ])
  const observed = JSON.parse(batch.rawReplies[id]!) as Record<string, unknown>
  expect(observed).toMatchObject({
    marker: "OSC 133;A;click_events=1",
    pointer: { x: 5, y: 3 },
    negativeControl: null,
    report: null,
  })

  // C3: declared "mouse-encoding" without an encodeMouse function throws a loud binding defect.
  const brokenBackend = await createXtermBackend()
  brokenBackend.init({ cols: 80, rows: 24 })
  try {
    const withoutMethod = Object.assign(Object.create(Object.getPrototypeOf(brokenBackend)), brokenBackend, {
      encodeMouse: undefined,
    })
    expect(() => createLibProbeSource(withoutMethod, undefined, undefined, undefined)).toThrow(
      /declares capability extension "mouse-encoding" without an encodeMouse function/,
    )
  } finally {
    brokenBackend.destroy()
  }

  // C3: encodeMouse method present without "mouse-encoding" in capabilities.extensions stays unwired -> TEST TODO.
  const undeclaredBackend = await createXtermBackend()
  undeclaredBackend.init({ cols: 80, rows: 24 })
  try {
    undeclaredBackend.capabilities.extensions.delete("mouse-encoding")
    const src = createLibProbeSource(undeclaredBackend, undefined, undefined, undefined)
    expect(src.encodeMouse).toBeUndefined()
  } finally {
    undeclaredBackend.destroy()
  }
})

// Callback coverage alone did not prove that a shell mark could enter canonical required-review custody.
test("retains a qualified headless shell mark's required source review through production recording", async () => {
  const id = "extensions.osc133-a"
  const { initializeRunDraft } = await import("@terminfo/probe-defs")
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "semantic-prompt-review",
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "xtermjs" },
    manifest: {
      schemaVersion: 4,
      probeHash: "semantic-prompt-suite",
      adapterVersion: "3",
      catalogIds: [id],
      probes: { term: [], mux: [], lib: [id] },
    },
  })
  const batch = await collectBatch(backend, "xtermjs", registryDefinitions([id]), draft)
  expect(batch.results).toEqual([
    expect.objectContaining({
      featureId: id,
      status: "test-todo",
      criterionBranch: SEMANTIC_PROMPT_SOURCE_REVIEW,
      rawReplyRef: id,
      tests: [
        expect.objectContaining({ id: "review", status: "test-todo", attempt: { scope: "none" }, rawReplyRef: id }),
      ],
    }),
  ])
  expect(batch.observations).toEqual([])
  expect(batch.assertions).toEqual([])
  expect(JSON.parse(batch.rawReplies[id]!)).toMatchObject({
    home: { x: 0, y: 0 },
    target: { x: 1, y: 0 },
    control: { x: 0, y: 0 },
    cell: "X",
  })
  // collect-headless.ts assembles its captured run from these production batch fields.
  const captured = {
    ...draft,
    rawReplies: { ...draft.rawReplies, ...batch.rawReplies },
    assertions: batch.assertions,
    results: batch.results,
  }
  expect(captured.rawReplies[id]).toBe(batch.rawReplies[id])
})

// The no-response grade hid that no F4 engine can read a colour back headless (#30547, @cto D-B): a silent first
// readback must ask for review with its raw query retained, while an engine that answers keeps its measured grade.
const COLOR_READBACK_IDS = [
  "extensions.osc104-reset-palette",
  "extensions.osc110-reset-fg",
  "extensions.osc111-reset-bg",
  "extensions.osc112-reset-cursor",
  "extensions.osc113-reset-pointer-fg",
  "extensions.osc114-reset-pointer-bg",
  "extensions.osc30001-color-stack-push",
  "extensions.osc30101-color-stack-pop",
]

function registryDefinitions(ids: readonly string[]): ProbeDefinition[] {
  return ids.map((id) => {
    const found = ALL_PROBES.find((probe) => probe.id === id)
    if (!found) throw new Error(`Missing registry definition ${id}`)
    return found
  })
}

test.each([
  ["xtermjs", async () => createXtermBackend()],
  ["libvterm", resolveLibvterm],
  ["vt100", resolveVt100],
  ["vt220", resolveVt220],
] as const)(
  "requests review for a silent headless colour readback on %s and retains its raw query",
  async (engine, factory) => {
    const batch = await collectBatch(factory, engine, registryDefinitions(COLOR_READBACK_IDS))
    expect(batch.results).toHaveLength(COLOR_READBACK_IDS.length)
    // On xtermjs, extensions.osc104-reset-palette is decided via the indexed-cell witness
    // (_core._inputHandler.onColor events; #31735, @cto 863bef67), while the 7 default/stack
    // queries remain silent and request color-readback-review.
    const cellWitnessIds = engine === "xtermjs" ? ["extensions.osc104-reset-palette"] : []
    expect(batch.observations).toEqual(
      cellWitnessIds.map((featureId) =>
        expect.objectContaining({ featureId, outcome: "supported", assertionType: "buffer_state" }),
      ),
    )
    expect(batch.assertions).toEqual(
      cellWitnessIds.map((featureId) =>
        expect.objectContaining({ featureId, kind: "positive", assertionType: "buffer_state" }),
      ),
    )
    for (const result of batch.results) {
      if (cellWitnessIds.includes(result.featureId)) {
        expect(result.status, result.featureId).toBe("supported")
        expect(result.criterionBranch, result.featureId).toBeUndefined()
        continue
      }
      expect(result.status, result.featureId).toBe("test-todo")
      expect(result.criterionBranch, result.featureId).toBe("color-readback-review")
      expect(result.rawReplyRef, result.featureId).toBe(result.featureId)
      const raw = JSON.parse(batch.rawReplies[result.featureId]!) as { query: string; originalRaw: string }
      expect(raw.query, result.featureId).toMatch(/^\x1b\]1?\d;/)
      expect(raw.originalRaw, result.featureId).toBe("")
      expect(batch.notTested, result.featureId).toContainEqual({
        featureId: result.featureId,
        reason: "no-semantic-observable",
        noObservable: expect.stringMatching(/answered nothing/),
        rawReplyRef: result.featureId,
      })
      expect(result.tests, result.featureId).toContainEqual(
        expect.objectContaining({ id: "review", status: "test-todo", rawReplyRef: result.featureId }),
      )
    }
  },
)

test("keeps the measured grade when the engine answers its colour readback", async () => {
  const batch = await collectBatch(async () => createVtermBackend(), "vterm", registryDefinitions(COLOR_READBACK_IDS))
  expect(batch.observations).toEqual(
    COLOR_READBACK_IDS.map((featureId) =>
      expect.objectContaining({ featureId, outcome: "supported", assertionType: "query_reply" }),
    ),
  )
  expect(batch.assertions).toEqual(
    COLOR_READBACK_IDS.map((featureId) => expect.objectContaining({ featureId, kind: "positive" })),
  )
  for (const result of batch.results) {
    expect(result.criterionBranch, result.featureId).toBeUndefined()
    expect(result.tests ?? [], result.featureId).not.toContainEqual(expect.objectContaining({ id: "review" }))
  }
})

// Final-return tests miss hard death during the active callback; its checkpoint must already exist.
test("checkpoints a probe attempt before invoking the headless callback", async () => {
  let active: unknown
  let seen: unknown
  await collectBatch(
    backend,
    "xtermjs",
    [
      definition("checkpoint.fixture", () => {
        seen = active
        return fakeProbeResult()
      }),
    ],
    undefined,
    (batch) => {
      active = structuredClone(batch.results[0])
    },
  )
  expect(seen).toMatchObject({
    featureId: "checkpoint.fixture",
    status: "test-todo",
    attempt: { scope: "probe", startedAt: expect.any(String) },
  })
})

function definition(
  id: string,
  lib: ProbeDefinition["lib"],
  markers: Pick<ProbeDefinition, "termAssertionType" | "libAssertionType"> = {},
): ProbeDefinition {
  return { id, lib, term: null, ...markers }
}

// AC3: independent feature results cannot depend on a previous probe's state.
// Existing cases check one callback or trust RIS; libvterm retains reverse-screen state after RIS.
for (const [name, create, reverseVideoOutcome] of [
  ["libvterm", resolveLibvterm, "supported"],
  ["xtermjs", async () => createXtermBackend(), "unsupported"],
] as const) {
  test(`${name} isolates independent mode and SGR probes in either order`, async () => {
    const definitions = ["modes.reverse-video", "sgr.inverse"].map((id) => {
      const probe = ALL_PROBES.find((item) => item.id === id)
      if (!probe) throw new Error(`Missing ${id} registry definition`)
      return probe
    })
    for (const order of [definitions, [...definitions].reverse()]) {
      const batch = await collectBatch(create, name, order)
      expect(batch.observations.find((item) => item.featureId === "sgr.inverse")).toMatchObject({
        outcome: "supported",
        assertionType: "buffer_state",
      })
      expect(batch.observations.find((item) => item.featureId === "modes.reverse-video")).toMatchObject({
        outcome: reverseVideoOutcome,
        assertionType: "query_reply",
        note: expect.stringMatching(/presentation .* unmeasured; protocol measured/),
      })
      expect(batch.notTested.find((item) => item.featureId === "modes.reverse-video")).toBeUndefined()
    }
  })
}

// AC3: eager and lazy parsers must attribute each query reply to its own capture.
// The existing batch tests exercise returned conclusions, not delayed parser I/O.
for (const [name, create, available] of [
  ["xtermjs", createXtermBackend, true],
  ["kitty", createKittyBackend, isKittyAvailable()],
] as const) {
  test.skipIf(!available)(`${name} captures only current query replies across reset`, async () => {
    const configDirectory = name === "kitty" ? mkdtempSync(join(tmpdir(), "terminfo-kitty-config-")) : undefined
    if (configDirectory) vi.stubEnv("KITTY_CONFIG_DIRECTORY", configDirectory)
    try {
      const value = create()
      const previous = vi.fn()
      value.onResponse = previous
      const replies: string[] = []
      // Kitty declares native reply delivery, whose host-recipe record needs the run draft the collector passes.
      const { initializeRunDraft } = await import("@terminfo/probe-defs")
      const draft = initializeRunDraft({
        source: { kind: "live" },
        runId: `${name}-reset-capture`,
        sourceRevision: "a".repeat(40),
        intendedSubject: { kind: "lib", id: name },
        manifest: {
          schemaVersion: 4 as const,
          probeHash: "reset-capture",
          adapterVersion: "3",
          catalogIds: ["capture"],
          probes: { term: [], mux: [], lib: ["capture"] },
        },
      })
      await collectBatch(
        async () => value,
        name,
        [
          definition("capture", (ctx) => {
            ctx.feed("\x1b[6n") // This reply belongs to the previous listener.
            replies.push(ctx.feedCapture("\x1b[2;3H\x1b[6n"))
            replies.push(ctx.feedCapture("\x1b[4;5H\x1b[6n"))
            ctx.reset()
            replies.push(ctx.feedCapture("\x1b[6n"))
            return fakeProbeResult()
          }),
        ],
        draft,
      )
      expect(replies).toEqual(["\x1b[2;3R", "\x1b[4;5R", "\x1b[1;1R"])
      expect(previous.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes)).join("")).toBe("\x1b[1;1R")
      expect(value.onResponse).toBe(previous)
    } finally {
      if (configDirectory) {
        vi.unstubAllEnvs()
        rmSync(configDirectory, { recursive: true, force: true })
      }
    }
  })
}

// #31373 (@cto 15cf18e4): a capture that reached an engine callback its adapter does not reproduce is a harness gap.
// The adapters above report no such callback, so no existing collector test could grade one.
// xterm.js stands in for an adapter that reports one unreproduced callback per OSC 52 read.
function unreproducingXterm() {
  const value = createXtermBackend()
  const warnings: EmulatorWarning[] = []
  value.capabilities.extensions.add("warnings")
  const feed = value.feed.bind(value)
  value.feed = (bytes) => {
    if (new TextDecoder().decode(bytes).includes("\x1b]52;")) {
      warnings.push({ code: "UNREPRODUCED_CALLBACK", message: "clipboard_control", backend: "xtermjs" })
    }
    feed(bytes)
  }
  return Object.assign(value, {
    getWarnings: () => [...warnings],
    clearWarnings: () => {
      warnings.length = 0
    },
  })
}

test.each([
  { name: "silent", query: "\x1b]52;c;?\x1b\\", harness: true },
  { name: "replied", query: "\x1b]52;c;?\x1b\\\x1b[6n", harness: false },
])("grades a capture that reached an unreproduced callback ($name)", async ({ query, harness }) => {
  const value = unreproducingXterm()
  const measured = (reply: string): ProbeCallbackResult => ({ ...fakeProbeResult("query_reply"), response: reply })
  const batch = await collectBatch(async () => value, "xtermjs", [
    definition("clipboard.read", (ctx) => measured(ctx.feedCapture(query))),
  ])
  const result = batch.results.find((entry) => entry.featureId === "clipboard.read")
  if (!harness) {
    expect(result?.tests.some((test) => test.id === HARNESS_INCOMPLETE_TEST)).toBe(false)
    expect(batch.rawReplies["clipboard.read"]).toMatch(/^\x1b\[\d+;\d+R$/)
    return
  }
  expect(result?.status).toBe("test-failure")
  expect(result?.tests).toEqual([
    expect.objectContaining({
      id: HARNESS_INCOMPLETE_TEST,
      status: "test-failure",
      reason: "Harness incomplete: xtermjs did not reproduce clipboard_control; silence is not evidence",
    }),
  ])
  expect(JSON.parse(batch.rawReplies["clipboard.read"] ?? "null")).toEqual({
    unreproduced: { backend: "xtermjs", captures: [{ query, callbacks: ["clipboard_control"] }] },
    measuredResponse: "",
  })
})

// #31373 (@cto 4ac8b275): on the native host route, the silent capture itself carries why it is silent, so the
// host-cause validator can accept it per capture; a capture that replied carries no cause.
test.each([
  { name: "silent", query: "\x1b]52;c;?\x07", cause: true },
  { name: "replied", query: "\x1b]52;c;?\x07\x1b[6n", cause: false },
])("a host capture beside an unreproduced callback records its harness cause ($name)", ({ query, cause }) => {
  const value = unreproducingXterm()
  value.init({ cols: 80, rows: 24 })
  const captures: Parameters<typeof feedCapture>[2] = []
  try {
    feedCapture(value, query, captures, { captures: [], silent: false })
  } finally {
    value.destroy()
  }
  expect(captures?.[0]?.cause).toEqual(
    cause ? { kind: "harness-unreproduced", callbacks: ["clipboard_control"] } : undefined,
  )
})

test("real vterm grades interior-region SU without moving the row above into history", async () => {
  const id = "scrollback.scroll-up"
  const probe = ALL_PROBES.find((item) => item.id === id)
  if (!probe) throw new Error(`Missing ${id} registry definition`)
  const value = createVtermBackend()
  const batch = await collectBatch(async () => value, "vterm", [probe])
  expect(batch.observations).toMatchObject([{ featureId: id, outcome: "supported", assertionType: "buffer_state" }])
  expect(batch.assertions).toMatchObject([{ featureId: id, kind: "positive" }])
  const raw = batch.rawReplies[id]
  if (!raw) throw new Error(`Missing ${id} raw measurement`)
  // The row is a region-readback kind row now, so its raw state is a GRID (one string[] per compared
  // row), not the deleted hand-written spec's flat `seed` plus numeric history counts. The old
  // "without creating scrollback history" claim is carried in CELL form: row 0 keeps its A marker, so a
  // terminal that scrolled the row above the region into history moves it and fails on this grid. The
  // numeric history observable belongs to the scrollback history rows (scrollback.accumulate,
  // scrollback.total-lines), which own that measurement.
  expect(JSON.parse(raw)).toMatchObject({
    before: [["A"], ["B"], ["C"], ["D"], ["E"]],
    after: [["A"], ["C"], ["D"], [""], ["E"]],
  })
})

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})
afterEach(() => {
  vi.restoreAllMocks()
})

test("retains Bun's missing artifact cause and path beside the failed worker stderr receipt", () => {
  // Captured from a real installed libvterm refusal; Bun puts ENOENT before its final stack line.
  const artifact = "/isolated/termless/packages/libvterm/wasm/libvterm.wasm"
  const stderr = `77 | const path = realpathSync(new URL("../wasm/libvterm.wasm", import.meta.url))\nENOENT: no such file or directory, lstat '${artifact}'\n    path: "${artifact}",\n      at <anonymous> (/isolated/termless/packages/libvterm/src/wasm-bindings.ts:77:18)\n`
  const directory = mkdtempSync(join(tmpdir(), "terminfo-headless-error-"))
  try {
    // The collector uses Bun's import.meta.dir, so exercise it in a real Bun child.
    const code = `
      const { collectHeadlessRuns } = await import(${JSON.stringify(new URL("./collect-headless.ts", import.meta.url).href)})
      Bun.spawn = () => ({
        stdout: new Blob([""]).stream(),
        stderr: new Blob([${JSON.stringify(stderr)}]).stream(),
        exited: Promise.resolve(1),
        kill() {},
      })
      const collection = await collectHeadlessRuns(["libvterm"], ${JSON.stringify(directory)})
      console.log(JSON.stringify(collection))
    `
    const child = spawnSync("bun", ["-e", code], { encoding: "utf8" })
    if (child.status !== 0) throw new Error(`Collector subprocess failed: ${child.stderr}`)
    const collection = JSON.parse(child.stdout) as {
      runs: string[]
      failures: Array<{ backend: string; package: string; error: string }>
    }
    expect(collection.runs).toEqual([])
    expect(collection.failures).toMatchObject([{ backend: "libvterm", package: "@termless/libvterm" }])
    expect(collection.failures[0]?.error).toContain("ENOENT: no such file or directory")
    expect(collection.failures[0]?.error).toContain(artifact)
    expect(readFileSync(join(directory, "libvterm.stderr.txt"), "utf8")).toBe(stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("attributes headless exceptions only to the headless marker and leaves legacy throws ungraded", async () => {
  const throws = () => {
    throw new TypeError("Callback failed")
  }
  const batch = await collectBatch(backend, "xtermjs", [
    definition("marked", throws, { termAssertionType: "query_reply", libAssertionType: "buffer_state" }),
    definition("app-only", throws, { termAssertionType: "query_reply" }),
    definition("legacy", throws),
  ])
  expect(batch.observations).toEqual([])
  for (const id of ["marked", "app-only", "legacy"]) {
    expect(batch.ungradedDiagnostics[id]).toEqual({
      kind: "collector-error",
      name: "TypeError",
      message: "headless xtermjs probe " + id + ": Callback failed",
    })
    expect(batch.results.find((result) => result.featureId === id)?.status).toBe("test-failure")
  }
  expect(probeReplies(batch)).toEqual({})
  expect(batch.assertions).toEqual([])
})

test("routes real registry constructor markers while multi-method callbacks remain ungraded", async () => {
  const ids = [
    "sgr.bold",
    "cursor.move.absolute",
    "device.primary-da",
    "extensions.osc133-a",
    "sgr.reset",
    "cursor.save-restore",
    "cursor.cup-scroll-region",
    "extensions.truecolor",
    "extensions.osc30001-color-stack-push",
    "extensions.osc30101-color-stack-pop",
  ]
  const definitions = ids.map((id) => {
    const found = ALL_PROBES.find((probe) => probe.id === id)
    if (!found) throw new Error(`Missing registry definition ${id}`)
    return found
  })
  const value = await backend()
  vi.spyOn(value, "init").mockImplementation(() => {
    throw new Error("Registry setup failed")
  })
  const batch = await collectBatch(async () => value, "xtermjs", definitions)
  expect(batch.observations).toEqual([])
  expect(Object.keys(batch.ungradedDiagnostics).sort()).toEqual([...ids].sort())
  for (const id of ids) {
    expect(batch.ungradedDiagnostics[id]).toMatchObject({
      message: "headless xtermjs probe " + id + ": Registry setup failed",
    })
    expect(batch.results.find((result) => result.featureId === id)?.status).toBe("test-failure")
  }
  expect(batch.assertions).toEqual([])
  expect(probeReplies(batch)).toEqual({})
})

test.each(["factory", "init"] as const)("attributes a %s failure before invoking its callback", async (stage) => {
  const value = await backend()
  const failure = new Error(`${stage} failed`)
  const destroy = vi.spyOn(value, "destroy")
  if (stage === "init") {
    vi.spyOn(value, "init").mockImplementation(() => {
      throw failure
    })
  }
  const callback = vi.fn(() => fakeProbeResult())
  const batch = await collectBatch(
    async () => {
      if (stage === "factory") throw failure
      return value
    },
    "xtermjs",
    [definition("setup", callback, { libAssertionType: "buffer_state" })],
  )
  expect(callback).not.toHaveBeenCalled()
  if (stage === "init") expect(destroy).toHaveBeenCalledOnce()
  expect(batch).toMatchObject({
    observations: [],
    assertions: [],
    notTested: [],
    rawReplies: {},
    ungradedDiagnostics: {
      setup: { kind: "collector-error", name: "Error", message: `headless xtermjs probe setup: ${stage} failed` },
    },
  })
})

test.each(["factory", "init"] as const)(
  "keeps a declared-none setup failure ungraded at %s instead of emitting an unparsable error",
  async (stage) => {
    const value = await backend()
    const failure = new Error(`${stage} failed`)
    if (stage === "init") {
      vi.spyOn(value, "init").mockImplementation(() => {
        throw failure
      })
    }
    const callback = vi.fn(() => fakeProbeResult())
    const batch = await collectBatch(
      async () => {
        if (stage === "factory") throw failure
        return value
      },
      "xtermjs",
      [definition("declines", callback, { libAssertionType: null })],
    )
    expect(callback).not.toHaveBeenCalled()
    // The canonical parser admits none only as an inconclusive refusal, so a collector failure on a
    // none arm stays a named ungraded diagnostic instead of becoming an error observation.
    expect(batch.observations).toEqual([])
    expect(batch.ungradedDiagnostics).toEqual({
      declines: { kind: "collector-error", name: "Error", message: `headless xtermjs probe declines: ${stage} failed` },
    })
  },
)

test("a real none-declaring probe keeps its setup failure ungraded", async () => {
  const ligatures = ALL_PROBES.find((probe) => probe.id === "extensions.font-ligatures")
  expect(ligatures?.libAssertionType).toBeNull()
  const batch = await collectBatch(
    async () => {
      throw new Error("engine unavailable")
    },
    "xtermjs",
    [ligatures!],
  )
  expect(batch.observations).toEqual([])
  expect(batch.ungradedDiagnostics["extensions.font-ligatures"]).toMatchObject({
    kind: "collector-error",
    message: "headless xtermjs probe extensions.font-ligatures: engine unavailable",
  })
})

// AC3: cleanup failure cannot leave a worker collecting and sealing apparently valid data.
test("aborts the batch on failed cleanup before invoking another probe", async () => {
  const value = await backend()
  vi.spyOn(value, "destroy").mockImplementationOnce(() => {
    throw new Error("Cleanup failed")
  })
  const next = vi.fn(() => fakeProbeResult())
  try {
    await expect(
      collectBatch(async () => value, "xtermjs", [
        definition("first", () => fakeProbeResult()),
        definition("next", next),
      ]),
    ).rejects.toThrow("headless xtermjs probe first: backend cleanup failed")
    expect(next).not.toHaveBeenCalled()
  } finally {
    value.destroy()
  }
})

test("attributes a context operation failure and restores the backend response listener", async () => {
  const value = await backend()
  const previous = vi.fn()
  value.onResponse = previous
  vi.spyOn(value, "feed").mockImplementation(() => {
    throw new Error("Feed failed")
  })
  const batch = await collectBatch(async () => value, "xtermjs", [
    definition(
      "query",
      (ctx) => {
        ctx.feedCapture("\x1b[c")
        return fakeProbeResult("query_reply")
      },
      { libAssertionType: "query_reply" },
    ),
  ])
  expect(value.onResponse).toBe(previous)
  expect(batch).toMatchObject({
    observations: [],
    assertions: [],
    notTested: [],
    rawReplies: {},
    ungradedDiagnostics: {
      query: { kind: "collector-error", name: "Error", message: "headless xtermjs probe query: Feed failed" },
    },
  })
})

test("attributes unavailable fixture grids to each probe without invoking callbacks", async () => {
  const callback = vi.fn(() => fakeProbeResult())
  const factory = async () => {
    const value = await backend()
    vi.spyOn(value, "getRow").mockImplementation(() => {
      throw new Error("Grid unavailable")
    })
    return value
  }
  const batch = await collectBatch(factory, "xtermjs", [
    definition("first", callback, { libAssertionType: "buffer_state" }),
    definition("second", callback, { libAssertionType: "query_reply" }),
  ])
  expect(batch.results.filter((result) => ["first", "second"].includes(result.featureId))).toMatchObject([
    { featureId: "first", status: "test-failure" },
    { featureId: "second", status: "test-failure" },
  ])
  expect(batch.ungradedDiagnostics.first).toMatchObject({
    message: expect.stringContaining("headless xtermjs probe first:"),
  })
  expect(batch.ungradedDiagnostics.first).toMatchObject({
    message: expect.stringContaining("no initialized row 0 grid"),
  })
  expect(callback).not.toHaveBeenCalled()
})

test("rejects a returned method that disagrees with the marker and preserves matching or unmeasured refusals", async () => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "wrong",
      () => ({
        pass: false,
        observation: { outcome: "inconclusive", reason: "no-response", assertionType: "query_reply" },
      }),
      { libAssertionType: "buffer_state" },
    ),
    definition(
      "matching",
      () => ({
        pass: false,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", assertionType: "buffer_state" },
      }),
      { libAssertionType: "buffer_state" },
    ),
    definition(
      "refused",
      () => ({
        pass: false,
        tests: [{ id: "criterion", status: "test-todo", reason: "insufficient-evidence" }],
      }),
      { libAssertionType: "buffer_state" },
    ),
  ])
  expect(batch).toMatchObject({
    observations: [
      {
        featureId: "wrong",
        outcome: "error",
        reason: "collector-error",
        assertionType: "query_reply",
        note: "Lib callback wrong declares buffer_state but returned query_reply; refused observation(outcome=inconclusive, reason=no-response, assertionType=query_reply)",
      },
      {
        featureId: "matching",
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        assertionType: "buffer_state",
      },
    ],
    assertions: [],
    notTested: [],
    rawReplies: {},
    ungradedDiagnostics: {},
  })
})

test.each([
  [
    "supported",
    'observation(outcome=supported, assertionType=none) and assertion(kind=positive, expected="X", observed="X")',
  ],
  ["error", "observation(outcome=error, reason=insufficient-evidence, assertionType=none)"],
  ["raw", "observation(outcome=inconclusive, reason=insufficient-evidence, assertionType=none)"],
  [
    "assertion",
    'observation(outcome=inconclusive, reason=insufficient-evidence, assertionType=none) and assertion(kind=positive, expected="X", observed="X")',
  ],
] as const)(
  "rejects a marked none result with %s instead of an unmeasured inconclusive refusal",
  async (variant, refused) => {
    const batch = await collectBatch(backend, "xtermjs", [
      definition(
        "invalid-none",
        ((ctx: Parameters<NonNullable<ProbeDefinition["lib"]>>[0]) => {
          ctx.feed("X")
          const observed = ctx.getCell(0, 0).char
          return {
            pass: variant === "supported",
            observation: {
              outcome: variant === "supported" ? "supported" : variant === "error" ? "error" : "inconclusive",
              evidence: "none",
              ...(variant !== "supported" && { reason: "insufficient-evidence" }),
            },
            ...((variant === "supported" || variant === "raw") && { response: observed }),
            ...((variant === "supported" || variant === "assertion") && {
              assertions: [{ kind: "positive" as const, expected: "X", observed }],
            }),
          }
        }) as unknown as NonNullable<ProbeDefinition["lib"]>,
        { libAssertionType: "buffer_state" },
      ),
    ])
    expect(batch).toMatchObject({
      observations: [],
      assertions: [],
      notTested: [],
      // `none` cannot carry an error: the canonical parser admits it only as an inconclusive
      // refusal, so this contradiction stays a named ungraded diagnostic.
      ungradedDiagnostics: {
        "invalid-none": {
          kind: "collector-error",
          name: "Error",
          message: expect.stringContaining("Callback for invalid-none returned no valid assertion type"),
        },
      },
    })
    // The refusal keeps the bytes the callback returned, beside its diagnostic, under the same id.
    expect(probeReplies(batch)).toStrictEqual(
      variant === "supported" || variant === "raw" ? { "invalid-none": "X" } : {},
    )
  },
)

// Unit source-audit metadata, not runner checkout attestation. Standalone CI has no owned siblings.
// Adapter sources are still read from each actual loaded backend below.
const qualifiedOscIdentities = {
  xtermjs: {
    kind: "js",
    runtimeFormat: "js",
    engineVersion: "6.0.0",
    adapterVersion: "0.10.2",
    termlessRevision: "9f0d4a5cbbeb2b7d9263ef7e07699df16a1cafc7",
    resolvedPath: "node_modules/.bun/@xterm+headless@6.0.0/node_modules/@xterm/headless/lib-headless/xterm-headless.js",
    integrity: {
      kind: "registry",
      lockIntegrity: "sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==",
    },
  },
  vterm: {
    kind: "js",
    runtimeFormat: "js",
    engineVersion: "0.10.1",
    adapterVersion: "0.10.2",
    termlessRevision: "9f0d4a5cbbeb2b7d9263ef7e07699df16a1cafc7",
    resolvedPath: "vendor/vterm/packages/vterm/src/index.ts",
    integrity: {
      kind: "source",
      repository: "git@github.com:beorn/vterm.git",
      revision: "67dd3960746766ed47e2bb4b2ced6503a78549cc",
      treeOid: "e9d67d4b4ba7cb4caf0d0824b3b272c10e4b229e",
      cleanTree: true,
    },
  },
} as const

// 30581: a refused callback result keeps its response under its feature id and its refused observation and
// assertions as text in the refusal, on every recorder branch, so the run file shows what the grader saw.
test.each([
  {
    name: "xtermjs",
    package: "@termless/xtermjs",
    factory: backend,
    returned: "query_reply",
    declared: "buffer_state",
  },
  // #32246: OSC 0 qualifies on the source's icon and title readers, not an audited identity. The vterm source exposes
  // both, so it declares buffer_state exactly as xterm does and refuses a query_reply result.
  {
    name: "vterm",
    package: "@termless/vterm",
    factory: async () => createVtermBackend(),
    returned: "query_reply",
    declared: "buffer_state",
  },
] as const)("registered OSC0 declaration refuses $returned for the actual $name source", async (scenario) => {
  const value = await scenario.factory()
  const identity = {
    ...qualifiedOscIdentities[scenario.name],
    adapterSources: headlessIdentity.readAdapterSources(scenario.name, value),
  }
  value.destroy()
  vi.spyOn(headlessIdentity, "headlessRuntimeIdentity").mockResolvedValue(identity)
  const registered = registryDefinitions(["extensions.osc0-icon-title"])[0]!
  const batch = await collectBatch(
    scenario.factory,
    scenario.name,
    [{ ...registered, lib: () => fakeProbeResult(scenario.returned) }],
    undefined,
    undefined,
    {
      identity,
      adapterPath: Bun.resolveSync(scenario.package, fileURLToPath(import.meta.url)),
      adapterPackage: scenario.package,
      adapterType: "js",
    },
  )
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.observations).toMatchObject([
    {
      featureId: registered.id,
      outcome: "error",
      reason: "collector-error",
      assertionType: scenario.returned,
      note: expect.stringContaining(`declares ${scenario.declared} but returned ${scenario.returned}`),
    },
  ])
})

test("real qualified OSC callbacks survive pending and unit-reviewed sealed reader journeys", async () => {
  const ids = ["extensions.osc0-icon-title", "extensions.osc52-clipboard", "extensions.osc52-write"]
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "qualified-class-set-fixture",
    adapterVersion: "fixture",
    catalogIds: ids,
    probes: { term: [], mux: [], lib: ids },
  }
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "qualified-class-set-unit-journey",
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "xtermjs" },
    manifest,
  })
  const identityBackend = await backend()
  const identity = {
    ...qualifiedOscIdentities.xtermjs,
    adapterSources: headlessIdentity.readAdapterSources("xtermjs", identityBackend),
  }
  identityBackend.destroy()
  vi.spyOn(headlessIdentity, "headlessRuntimeIdentity").mockResolvedValue(identity)
  const batch = await collectBatch(backend, "xtermjs", registryDefinitions(ids), draft, undefined, {
    identity,
    adapterPath: Bun.resolveSync("@termless/xtermjs", fileURLToPath(import.meta.url)),
    adapterPackage: "@termless/xtermjs",
    adapterType: "js",
  })
  expect(batch.ungradedDiagnostics).toEqual({})
  // #32246: the pending OSC 52 rows stay TEST TODO and carry no source branch or typed negative.
  expect(batch.results).toMatchObject([
    { featureId: ids[0], status: "supported", assertionType: "buffer_state" },
    { featureId: ids[1], status: "test-todo" },
    { featureId: ids[2], status: "test-todo" },
  ])
  for (const row of batch.results.slice(1)) {
    expect(row, row.featureId).not.toHaveProperty("criterionBranch")
    expect(row, row.featureId).not.toHaveProperty("assertionType")
  }
  const captured: CapturedRunDraft = {
    ...draft,
    subject: {
      kind: "lib",
      id: "xtermjs",
      version: identity.engineVersion,
      os: "linux",
      osVersion: null,
      outerTerminal: null,
      mux: null,
      config: null,
      permissions: null,
    },
    identity: "unverified",
    runtimeIdentity: identity,
    measuredAt: new Date().toISOString(),
    origin: { kind: "collector" },
    rawReplies: batch.rawReplies,
    results: batch.results,
    assertions: batch.assertions,
  }
  const read = (value: unknown) =>
    parseRun("qualified-unit.capture.json", JSON.stringify(value), ids, new Map([[manifest.probeHash, manifest]]))
  expect(read(captured).results).toEqual(batch.results)
  expect(read(finalizeCollectedDraft(captured)).results).toEqual(batch.results)
  // The parser-level-rejection rule is gone with the source answers (#32246): a TEST TODO row that claims a type
  // stays TEST TODO, never a graded negative.
  const mislabeled = structuredClone(captured)
  for (const result of mislabeled.results.slice(1)) result.assertionType = "query_reply"
  for (const assertion of mislabeled.assertions.filter((entry) => entry.featureId !== ids[0])) {
    assertion.assertionType = "query_reply"
  }
  const relabeled = read(mislabeled).results
  expect(relabeled?.slice(1).map((row) => row.status)).toEqual(["test-todo", "test-todo"])
  // The OSC 52 rows carry no state assertion any more (#32246); the measured OSC 0 snapshot keeps the check.
  const invalidState = structuredClone(captured)
  const stateAssertion = invalidState.assertions.find((entry) => entry.featureId === ids[0])!
  stateAssertion.observed = "not-json"
  invalidState.rawReplies[ids[0]!] = "not-json"
  expect(() => read(invalidState)).toThrow("state snapshot")
})

test.each([
  { selected: true, actual: "buffer_state", allowed: ["buffer_state"], outcome: "inconclusive" },
  { selected: false, actual: "query_reply", allowed: ["buffer_state"], outcome: "inconclusive" },
  { selected: true, actual: "query_reply", allowed: ["query_reply", "buffer_state"], outcome: "inconclusive" },
  { selected: false, actual: "buffer_state", allowed: ["buffer_state"], outcome: "error" },
  { selected: true, actual: "query_reply", allowed: ["buffer_state"], outcome: "error" },
] as const)("qualified declaration selects $selected/$actual/$allowed", async (scenario) => {
  const order: string[] = []
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "qualified",
      () => {
        order.push("callback")
        return fakeProbeResult(scenario.actual)
      },
      {
        libAssertionType: {
          when: (source) => {
            expect(typeof source.getTitle).toBe("function")
            order.push("when")
            return scenario.selected
          },
          then: scenario.allowed,
          otherwise: ["query_reply"],
        },
      },
    ),
  ])
  expect(order).toEqual(["when", "callback"])
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.observations).toHaveLength(1)
  expect(batch.observations[0]).toMatchObject({
    featureId: "qualified",
    assertionType: scenario.actual,
    outcome: scenario.outcome,
    reason: scenario.outcome === "error" ? "collector-error" : "insufficient-evidence",
  })
  if (scenario.outcome === "error") {
    const selected = scenario.selected ? scenario.allowed : ["query_reply"]
    expect(batch.observations[0]?.note).toContain(
      `Lib callback qualified declares ${selected.join(", ")} but returned ${scenario.actual}`,
    )
  }
})

test.each(["throw", "non-boolean"] as const)(
  "qualified declaration refuses a %s predicate before the callback",
  async (fault) => {
    const callback = vi.fn(() => fakeProbeResult())
    const predicate = vi.fn(() => {
      if (fault === "throw") throw new Error("predicate failed")
      return undefined as unknown as boolean
    })
    const batch = await collectBatch(backend, "xtermjs", [
      definition("invalid-predicate", callback, {
        libAssertionType: { when: predicate, then: ["buffer_state"], otherwise: ["query_reply"] },
      }),
    ])
    expect(predicate).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()
    expect(batch.observations).toEqual([])
    expect(batch.assertions).toEqual([])
    expect(batch.ungradedDiagnostics["invalid-predicate"]).toMatchObject({
      kind: "collector-error",
      message: expect.stringContaining(fault === "throw" ? "predicate failed" : "boolean"),
    })
  },
)

test("an assertion type that disagrees with the marker keeps the response and the refused claim", async () => {
  const response = "\x1b[?1;2c"
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "wrong",
      () => ({
        pass: false,
        response,
        observation: { outcome: "unsupported", assertionType: "query_reply" },
        assertions: [{ kind: "negative", assertionType: "query_reply", expected: "no DA1 answer", observed: response }],
      }),
      { libAssertionType: "buffer_state" },
    ),
  ])
  expect(batch.observations).toStrictEqual([
    {
      featureId: "wrong",
      outcome: "error",
      reason: "collector-error",
      assertionType: "query_reply",
      note: `Lib callback wrong declares buffer_state but returned query_reply; refused observation(outcome=unsupported, assertionType=query_reply) and assertion(kind=negative, expected="no DA1 answer", observed=${JSON.stringify(response)})`,
      rawReplyRef: "wrong",
    },
  ])
  expect(batch.assertions).toStrictEqual([])
  expect(probeReplies(batch)).toStrictEqual({ wrong: response })
  validateObservation(batch.observations[0]!, "run", batch.rawReplies, batch.assertions)
})

test.each([
  {
    name: "an assertion of the other kind",
    response: "X",
    observation: { outcome: "supported", assertionType: "buffer_state" },
    assertions: [{ kind: "negative", expected: "X", observed: "X" }],
    refused:
      'observation(outcome=supported, assertionType=buffer_state) and assertion(kind=negative, expected="X", observed="X")',
  },
  {
    name: "no assertion",
    response: "X",
    observation: { outcome: "supported", assertionType: "buffer_state" },
    assertions: [],
    refused: "observation(outcome=supported, assertionType=buffer_state)",
  },
  {
    name: "a parser-state assertion that observed other bytes",
    response: "X",
    observation: { outcome: "unsupported", assertionType: "buffer_state" },
    assertions: [{ kind: "negative", expected: "Y", observed: "Z" }],
    refused:
      'observation(outcome=unsupported, assertionType=buffer_state) and assertion(kind=negative, expected="Y", observed="Z")',
  },
  {
    name: "no response",
    response: undefined,
    observation: { outcome: "supported", assertionType: "buffer_state" },
    assertions: [{ kind: "positive", expected: "X", observed: "X" }],
    refused:
      'observation(outcome=supported, assertionType=buffer_state) and assertion(kind=positive, expected="X", observed="X")',
  },
] as const)("a conclusive result with $name keeps its response and refused claim", async (row) => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "unbound",
      (() => ({
        pass: row.observation.outcome === "supported",
        ...(row.response !== undefined && { response: row.response }),
        observation: row.observation,
        assertions: row.assertions,
      })) as unknown as ProbeDefinition["lib"],
      { libAssertionType: "buffer_state" },
    ),
  ])
  expect(batch.observations).toStrictEqual([
    {
      featureId: "unbound",
      outcome: "error",
      reason: "collector-error",
      assertionType: "buffer_state",
      note: `Callback result lacks matching raw state and assertion; refused ${row.refused}`,
      ...(row.response !== undefined && { rawReplyRef: "unbound" }),
    },
  ])
  expect(batch.assertions).toStrictEqual([])
  expect(probeReplies(batch)).toStrictEqual(row.response !== undefined ? { unbound: row.response } : {})
  validateObservation(batch.observations[0]!, "run", batch.rawReplies, batch.assertions)
})

test("an inconclusive result without a reason keeps its response and refused claim", async () => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "unreasoned",
      (() => ({
        pass: false,
        response: "X",
        observation: { outcome: "inconclusive", assertionType: "buffer_state" },
      })) as unknown as ProbeDefinition["lib"],
      { libAssertionType: "buffer_state" },
    ),
  ])
  expect(batch.observations).toStrictEqual([
    {
      featureId: "unreasoned",
      outcome: "error",
      reason: "collector-error",
      assertionType: "buffer_state",
      note: "Callback result lacks an inconclusive/error reason; refused observation(outcome=inconclusive, assertionType=buffer_state)",
      rawReplyRef: "unreasoned",
    },
  ])
  expect(probeReplies(batch)).toStrictEqual({ unreasoned: "X" })
  validateObservation(batch.observations[0]!, "run", batch.rawReplies, batch.assertions)
})

test("a result with no observation keeps its response and refused assertions", async () => {
  // The union makes this unreachable from a typed callback; an untyped caller still keeps what it returned.
  const untyped = (() => ({
    pass: true,
    response: "X",
    assertions: [{ kind: "positive", expected: "X", observed: "X" }],
  })) as unknown as ProbeDefinition["lib"]
  const batch = await collectBatch(backend, "xtermjs", [
    definition("legacy", untyped, { libAssertionType: "buffer_state" }),
  ])
  expect(batch.observations).toStrictEqual([])
  expect(batch.assertions).toStrictEqual([])
  expect(batch.ungradedDiagnostics).toStrictEqual({
    legacy: {
      kind: "collector-error",
      name: "Error",
      message:
        'Callback for legacy returned neither an observation nor a not-tested coverage record; its conclusion cannot be graded; refused assertion(kind=positive, expected="X", observed="X")',
    },
  })
  expect(probeReplies(batch)).toStrictEqual({ legacy: "X" })
})

// 30585: a grader that got no reply names that as its reason, and the reason is the record of the missing raw.
// The observation keeps its measured reason; a rowless callback is a writer defect and synthesizes no raw reply.
test("admits an inconclusive no-response result with its named reason and no synthesized raw", async () => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "silent",
      () => ({
        pass: false,
        observation: { outcome: "inconclusive", reason: "no-response", assertionType: "query_reply" },
      }),
      { libAssertionType: "query_reply" },
    ),
  ])
  expect(batch.observations).toStrictEqual([
    { featureId: "silent", outcome: "inconclusive", reason: "no-response", assertionType: "query_reply" },
  ])
  expect(batch.assertions).toStrictEqual([])
  expect(probeReplies(batch)).toStrictEqual({})
  expect(batch.results).toStrictEqual([
    expect.objectContaining({
      featureId: "silent",
      status: "test-failure",
      reason: "writer default: inconclusive observation without test rows; callback defect",
    }),
  ])
  expect(batch.results[0]).not.toHaveProperty("rawReplyRef")
  validateObservation(batch.observations[0]!, "run", batch.rawReplies, batch.assertions)
})

test("refuses a callback result that is neither a measurement nor a coverage record", async () => {
  // The union makes this unreachable from a typed callback; an untyped caller still gets a loud refusal.
  const untyped = (() => ({ pass: true, note: "Legacy conclusion" })) as unknown as ProbeDefinition["lib"]
  const batch = await collectBatch(backend, "xtermjs", [
    definition("legacy", untyped, { libAssertionType: "buffer_state" }),
  ])
  expect(batch).toMatchObject({
    observations: [],
    assertions: [],
    notTested: [],
    rawReplies: {},
    ungradedDiagnostics: {
      legacy: {
        kind: "collector-error",
        name: "Error",
        message:
          "Callback for legacy returned neither an observation nor a not-tested coverage record; its conclusion cannot be graded",
      },
    },
  })
})

// A named coverage record is additive state, not an observation, and it must keep its own raw capture.
test("records named not-tested coverage without an observation and keeps its raw trace", async () => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "modes.bracketed-paste",
      () => ({
        pass: false,
        response: JSON.stringify({ mode: false }),
        notTested: { reason: "no-semantic-observable", noObservable: "input events" },
      }),
      { libAssertionType: "buffer_state" },
    ),
  ])
  expect(batch.observations).toEqual([])
  expect(batch.assertions).toEqual([])
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.notTested).toEqual([
    {
      featureId: "modes.bracketed-paste",
      reason: "no-semantic-observable",
      noObservable: "input events",
      rawReplyRef: "modes.bracketed-paste",
    },
  ])
  expect(JSON.parse(batch.rawReplies["modes.bracketed-paste"] ?? "")).toEqual({ mode: false })
})

// Coverage without retained raw state is a loud collector error, never a not-tested claim.
test("refuses named coverage with no retained raw capture", async () => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "modes.bracketed-paste",
      () => ({
        pass: false,
        notTested: { reason: "no-semantic-observable", noObservable: "input events" },
      }),
      { libAssertionType: "buffer_state" },
    ),
  ])
  expect(batch.notTested).toEqual([])
  expect(batch.results.filter((result) => ["modes.bracketed-paste"].includes(result.featureId))).toMatchObject([
    { featureId: "modes.bracketed-paste", status: "test-failure" },
  ])
})

// A probe that never captured state cannot be recorded as not tested either.
test("a failed probe never becomes named coverage", async () => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "modes.bracketed-paste",
      () => {
        throw new Error("backend read failed")
      },
      { libAssertionType: "buffer_state" },
    ),
  ])
  expect(batch.notTested).toEqual([])
  expect(batch.results.filter((result) => ["modes.bracketed-paste"].includes(result.featureId))).toMatchObject([
    { featureId: "modes.bracketed-paste", status: "test-failure" },
  ])
})

// A mixed result - named coverage beside its own failed measurement - is a loud collector error, never
// coverage, and the healthy part of the batch keeps collecting.
test("refuses named coverage that arrives beside its returned error observation", async () => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "modes.bracketed-paste",
      (() => ({
        pass: false,
        response: JSON.stringify({ mode: false }),
        notTested: { reason: "no-semantic-observable", noObservable: "input events" },
        observation: {
          outcome: "error",
          reason: "collector-error",
          assertionType: "buffer_state",
          note: "backend read failed",
        },
      })) as unknown as ProbeDefinition["lib"],
      { libAssertionType: "buffer_state" },
    ),
    definition(
      "modes.focus-events",
      () => ({
        pass: false,
        response: JSON.stringify({ mode: false }),
        notTested: { reason: "no-semantic-observable", noObservable: "input events" },
      }),
      { libAssertionType: "buffer_state" },
    ),
  ])
  expect(batch.notTested).toEqual([
    {
      featureId: "modes.focus-events",
      reason: "no-semantic-observable",
      noObservable: "input events",
      rawReplyRef: "modes.focus-events",
    },
  ])
  expect(batch.results.filter((result) => ["modes.bracketed-paste"].includes(result.featureId))).toMatchObject([
    { featureId: "modes.bracketed-paste", status: "test-failure" },
  ])
  expect(batch.ungradedDiagnostics["modes.bracketed-paste"]).toMatchObject({
    message: expect.stringContaining(
      "beside observation(outcome=error, reason=collector-error, assertionType=buffer_state",
    ),
  })
  expect(batch.rawReplies["modes.bracketed-paste"]).toBe(JSON.stringify({ mode: false }))
  expect(batch.results.find((result) => result.featureId === "modes.bracketed-paste")?.rawReplyRef).toBe(
    "modes.bracketed-paste",
  )
  expect(batch.ungradedDiagnostics["modes.bracketed-paste"]).toMatchObject({
    message: expect.stringContaining('note="backend read failed"'),
  })
})

test("refuses named coverage that arrives beside supported observation and assertions", async () => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "modes.bracketed-paste",
      (() => ({
        pass: true,
        response: JSON.stringify({ mode: true }),
        notTested: { reason: "no-semantic-observable", noObservable: "input events" },
        observation: { outcome: "supported", assertionType: "buffer_state" },
        assertions: [{ kind: "positive", expected: "mode=true", observed: JSON.stringify({ mode: true }) }],
      })) as unknown as ProbeDefinition["lib"],
      { libAssertionType: "buffer_state" },
    ),
  ])
  expect(batch.notTested).toEqual([])
  expect(batch.assertions).toEqual([])
  expect(batch.results.filter((result) => ["modes.bracketed-paste"].includes(result.featureId))).toMatchObject([
    { featureId: "modes.bracketed-paste", status: "test-failure" },
  ])
  expect(batch.rawReplies["modes.bracketed-paste"]).toBe(JSON.stringify({ mode: true }))
  expect(batch.ungradedDiagnostics["modes.bracketed-paste"]).toMatchObject({
    message: expect.stringContaining("assertion(kind=positive"),
  })
  expect(batch.ungradedDiagnostics["modes.bracketed-paste"]).toMatchObject({
    message: expect.stringContaining("expected="),
  })
  expect(batch.ungradedDiagnostics["modes.bracketed-paste"]).toMatchObject({
    message: expect.stringContaining("observed="),
  })
})

// AC3: feature support cannot authorize metadata readback. Existing tests grade
// outcomes but do not catch a placeholder hyperlink=null presented as reported.
test("OSC 8 feature without metadata extension omits the cell field", () => {
  const value = createXtermBackend({ cols: 80, rows: 24 })
  try {
    value.capabilities.extensions.delete("hyperlinks")
    value.feed(new TextEncoder().encode("\x1b]8;;https://example.com/observed\x07L"))
    expect(value.capabilities.osc8Hyperlinks).toBe(true)
    expect(createLibProbeSource(value, undefined, undefined, undefined).getCell(0, 0)).not.toHaveProperty("hyperlink")
  } finally {
    value.destroy()
  }
})

// An advertised metadata contract must fail loudly by backend and cell; old
// coverage only checked getCell fields, so malformed extension methods escaped.
test.each([undefined, () => undefined, () => 5])("OSC 8 metadata declaration mismatch is named: %s", (readLink) => {
  const value = createXtermBackend({ cols: 80, rows: 24 })
  try {
    value.capabilities.extensions.add("hyperlinks")
    Object.assign(value, { getHyperlinkAt: readLink })
    expect(() => createLibProbeSource(value, undefined, undefined, undefined).getCell(0, 0)).toThrow(
      `${value.name} declares OSC 8 metadata`,
    )
  } finally {
    value.destroy()
  }
})

// A getter method alone cannot authorize state observation; forwarding must preserve its receiver
// and all three nullable slots without synthesizing colors from the real backend's cells.
test("default-color source forwarding requires an advertised callable aggregate getter", () => {
  const value = createXtermBackend({ cols: 80, rows: 24 })
  const colors = { fg: null, bg: { r: 1, g: 2, b: 3 }, cursor: null }
  const readColors = function (this: unknown) {
    expect(this).toBe(value)
    return colors
  }
  try {
    Object.assign(value, { getDefaultColors: readColors })
    expect(createLibProbeSource(value, undefined, undefined, undefined).getDefaultColors).toBeUndefined()
    value.capabilities.extensions.add("default-colors")
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    expect(source.getDefaultColors?.()).toEqual(colors)
    Object.assign(value, { getDefaultColors: undefined })
    expect(createLibProbeSource(value, undefined, undefined, undefined).getDefaultColors).toBeUndefined()
    Object.assign(value, { getDefaultColors: 42 })
    expect(createLibProbeSource(value, undefined, undefined, undefined).getDefaultColors).toBeUndefined()
  } finally {
    value.destroy()
  }
})

// Native adapter tests and isolated callback controls cannot catch source forwarding or collector
// binding failures. This journey uses the authentic addon and unchanged registry definitions.
const ghosttyNativeAvailable = isGhosttyNativeAvailable()
test.skipIf(!ghosttyNativeAvailable)(
  `real Ghostty default-color resets and OSC 8 retain bound buffer-state evidence${ghosttyNativeAvailable ? "" : " (NOT MEASURED: native addon unavailable)"}`,
  async () => {
    const resetRows = [
      ["extensions.osc110-reset-fg", "fg", 10, 110],
      ["extensions.osc111-reset-bg", "bg", 11, 111],
      ["extensions.osc112-reset-cursor", "cursor", 12, 112],
    ] as const
    const ids = [...resetRows.map(([id]) => id), "extensions.osc8"]
    const instances: { writes: string[]; replies: string[] }[] = []
    let metadataAvailable = false
    const batch = await collectBatch(
      async () => {
        const value = createGhosttyNativeBackend()
        metadataAvailable =
          value.capabilities.extensions.has("default-colors") || value.capabilities.extensions.has("hyperlinks")
        const instance = { writes: [] as string[], replies: [] as string[] }
        instances.push(instance)
        const feed = value.feed.bind(value)
        vi.spyOn(value, "feed").mockImplementation((bytes) => {
          instance.writes.push(new TextDecoder().decode(bytes))
          feed(bytes)
        })
        value.onResponse = (bytes) => instance.replies.push(new TextDecoder().decode(bytes))
        return value
      },
      "ghostty-native",
      registryDefinitions(ids),
    )
    expect(batch.results.map(({ featureId, status }) => ({ featureId, status }))).toEqual(
      ids.map((featureId) => ({ featureId, status: metadataAvailable ? "supported" : "test-todo" })),
    )
    // Native 0.10.2 lacks metadata; retain its TODO evidence and the source build's positive assertions.
    if (!metadataAvailable) {
      expect(batch.results.map(({ rawReplyRef }) => rawReplyRef)).toEqual(ids)
      expect(batch.observations).toEqual([])
      expect(batch.assertions).toEqual([])
      expect(batch.ungradedDiagnostics).toEqual({})
      expect(batch.notTested).toMatchObject(
        ids.map((featureId) => ({
          featureId,
          reason: "no-semantic-observable",
          rawReplyRef: featureId,
        })),
      )
      for (const [id] of resetRows) {
        expect(JSON.parse(batch.rawReplies[id]!)).toMatchObject({
          originalRaw: "",
          controls: Array.from({ length: 4 }, () => ({ response: "" })),
        })
      }
      expect(JSON.parse(batch.rawReplies["extensions.osc8"]!)).toEqual({
        chars: [..."ALINKZ"],
        links: Array.from({ length: 6 }, () => ({ reported: false })),
      })
      return
    }
    expect(batch.observations).toHaveLength(4)
    expect(batch.notTested).toEqual([])
    expect(batch.ungradedDiagnostics).toEqual({})
    for (const id of ids) {
      expect(batch.observations.find((row) => row.featureId === id)).toMatchObject({
        outcome: "supported",
        assertionType: "buffer_state",
        rawReplyRef: id,
      })
      expect(batch.assertions.filter((row) => row.featureId === id)).toMatchObject([
        { kind: "positive", assertionType: "buffer_state", rawReplyRef: id, observed: batch.rawReplies[id] },
      ])
    }
    const unset = { fg: null, bg: null, cursor: null }
    const seed = { r: 170, g: 187, b: 204 }
    for (const [index, [id, slot, setter, reset]] of resetRows.entries()) {
      const writes = [`\x1b]${setter};rgb:aa/bb/cc\x07`, `\x1b]${reset}\x07`]
      expect(JSON.parse(batch.rawReplies[id]!)).toEqual({
        slot,
        baseline: unset,
        seeded: { ...unset, [slot]: seed },
        restored: unset,
        seed,
        writes,
        errors: [],
      })
      expect(instances[index]!.writes).toEqual(writes)
    }
    const uri = "https://example.com/osc8-proof"
    expect(JSON.parse(batch.rawReplies["extensions.osc8"]!)).toEqual({
      chars: [..."ALINKZ"],
      links: [null, uri, uri, uri, uri, null].map((uri) => ({ reported: true, uri })),
    })
    expect(instances).toHaveLength(4)
    expect(instances.map(({ replies }) => replies)).toEqual([[], [], [], []])
  },
)

// Runtime status must preserve attempted failure separately from an unstarted implementation;
// old observation/coverage tests cannot express a catalogue member with no callback.
test("records a complete explicit catalogue and retains probe attempt failure", async () => {
  const { initializeRunDraft } = await import("@terminfo/probe-defs")
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "headless-status-contract",
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "xtermjs" },
    manifest: {
      schemaVersion: 4 as const,
      probeHash: "runtime-suite",
      adapterVersion: "3",
      catalogIds: ["attempted", "unimplemented"],
      probes: { term: [], mux: [], lib: ["attempted"] },
    },
  })
  const batch = await collectBatch(
    backend,
    "xtermjs",
    [
      definition(
        "attempted",
        () => {
          throw new Error("retained oracle failure")
        },
        { libAssertionType: "buffer_state" },
      ),
    ],
    draft,
  )
  expect(batch.results.map(({ featureId, status }) => ({ featureId, status }))).toEqual([
    { featureId: "attempted", status: "test-failure" },
    { featureId: "unimplemented", status: "test-todo" },
  ])
  expect(batch.results[0]?.attempt.scope).toBe("probe")
  expect(batch.results[0]?.reason).toContain("retained oracle failure")
  expect(batch.results[1]?.attempt).toEqual({ scope: "none" })
})

// Execution-only callbacks retain their real response and cannot borrow legacy pass as support.
test("retains execution-only failure bytes despite pass true and rejects a typed claim declared null", async () => {
  const result = await collectBatch(backend, "xtermjs", [
    definition("execution-only", () => ({
      pass: true,
      response: "retained refusal",
      tests: [{ id: "criterion", status: "test-failure", reason: "Timed out without a deciding observable" }],
    })),
    definition(
      "declared-null",
      () => ({
        pass: true,
        response: "retained state",
        observation: { outcome: "supported", assertionType: "query_reply" },
        assertions: [{ kind: "positive", assertionType: "query_reply", expected: "state", observed: "retained state" }],
      }),
      { libAssertionType: null },
    ),
  ])
  expect(result.results.map((entry) => entry.status)).toEqual(["test-failure", "test-failure"])
  expect(result.rawReplies).toMatchObject({ "execution-only": "retained refusal", "declared-null": "retained state" })
  expect(result.results[0]).toMatchObject({
    rawReplyRef: "execution-only",
    tests: [expect.objectContaining({ status: "test-failure" })],
  })
  expect(result.observations).toMatchObject([
    { featureId: "declared-null", outcome: "error", reason: "collector-error" },
  ])
})

// AC1: the old preflight refused an exact declared/loaded identity because it lacked
// audit-table membership; existing tests deliberately asserted that obsolete refusal.
test("a silent loaded binary collects a no-same-path-control TODO and an observed buffer result", async () => {
  const sha256 = "f".repeat(64)
  const identity = {
    kind: "native" as const,
    engineVersion: "fixture",
    adapterVersion: "fixture",
    termlessRevision: "a".repeat(40),
    loadedBinary: { path: "fixture.node", sha256 },
    provenance: {
      sha256,
      sourceCommit: "a".repeat(40),
      buildHash: "b".repeat(64),
      toolchain: "fixture",
      lockSha256: "c".repeat(64),
    },
  }
  const { assertDeclaredNativeSha } = await import("./headless-batch.ts")
  expect(() =>
    assertDeclaredNativeSha(
      "fixture",
      identity,
      { boundary: "feed-and-getCursor", adapterSources: [], engine: { kind: "native", sha256 } },
      undefined,
      undefined,
      () => {},
    ),
  ).not.toThrow()
  const definitions = registryDefinitions(["device.xtgettcap", "sgr.bold"]).map((definition) => ({
    ...definition,
    lib: (ctx: LibProbeSource) => definition.lib!({ ...ctx, runtimeIdentity: identity }),
  }))
  const batch = await collectBatch(backend, "xtermjs", definitions)
  expect(batch.results.find((row) => row.featureId === "device.xtgettcap")).toMatchObject({
    status: "test-todo",
    // #32246: a zero-byte reply on a loaded binary is TEST TODO with no same-path control, never a source audit.
    tests: [{ id: "criterion", status: "test-todo", reason: NO_SAME_PATH_CONTROL }],
  })
  expect(batch.observations.find((row) => row.featureId === "sgr.bold")).toMatchObject({
    outcome: "supported",
    assertionType: "buffer_state",
  })
  expect(batch.results.find((row) => row.featureId === "sgr.bold")).toMatchObject({
    status: "test-todo",
    reason: "visual effect not observed in this run",
  })
})

// AC2: an actual declared/loaded mismatch still refuses before probes and retains the original failure.
test("refuses a declared native SHA mismatch before probe collection", async () => {
  const { initializeRunDraft, readCollectorAttempt, recordCollectionFailure, recordCollectorAttempt } =
    await import("@terminfo/probe-defs")
  const { assertDeclaredNativeSha, finalizeHeadlessAttempt } = await import("./headless-batch.ts")
  const loadedSha = "67736cf8d7d96156ac921566713032a445bfd8564e499f5e715c3c7f077d8af6"
  const expectedSha = "32d76284e5a3c7673fafbbc83a16717fa0a1c1811c7d659d982176a53ceb1aa9"
  const nativeTreeOid = "4c4fb801b537704068deac6b8df24ed86a68cf35"
  const runtimeIdentity = {
    kind: "native" as const,
    engineVersion: "0.26.0",
    adapterVersion: "0.1.0",
    termlessRevision: "cd5cd5172680fd240ee3445dea96289793bc2d59",
    loadedBinary: {
      path: "vendor/termless/packages/alacritty/termless-alacritty-native.node",
      sha256: loadedSha,
    },
    provenance: {
      sha256: loadedSha,
      sourceCommit: "cd5cd5172680fd240ee3445dea96289793bc2d59",
      buildHash: "94ef4fbf1e21d454c70a39efaf9cfde1ebabe57a0f9cdb186fef782cfb1ff8ce",
      toolchain: "rustc 1.94.0",
      lockSha256: "1f89f2579b7d786a116d8fefb8267c4af076bd3a3893adcf14b00c4466740497",
    },
  }
  const declaration = {
    boundary: "feed-and-getCursor" as const,
    adapterSources: [{ path: "packages/alacritty/src/index.ts", blobOid: "b4154cbd6ef4a83ce2cbf3dcf26ff13d645efd05" }],
    engine: { kind: "native" as const, sha256: expectedSha },
  }
  // Audited artifact passes without emitting a warning or throwing.
  const draftPath = "pass-s93GZY/lib-alacritty-unknown.draft.json"
  const warnings: string[] = []
  expect(() =>
    assertDeclaredNativeSha(
      "alacritty",
      {
        ...runtimeIdentity,
        loadedBinary: { ...runtimeIdentity.loadedBinary, sha256: expectedSha },
        provenance: { ...runtimeIdentity.provenance, sha256: expectedSha },
      },
      declaration,
      nativeTreeOid,
      draftPath,
      (line) => warnings.push(line),
    ),
  ).not.toThrow()
  expect(warnings).toEqual([])

  // Identity mismatch refuses before probes, regardless of source-audit membership.
  const ids = ["extensions.osc10-fg-color", "device.primary-da"]
  const startedAt = "2026-10-29T22:34:03.743Z"
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "alacritty-unaudited-preflight",
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "alacritty" },
    manifest: {
      schemaVersion: 4,
      probeHash: "suite-hash",
      adapterVersion: "4",
      catalogIds: ids,
      probes: { term: [], mux: [], lib: ids },
    },
  })
  recordCollectorAttempt(draft, { result: "started", startedAt, ids, hostInputs: { "foreground-rgb": "not-supplied" } })
  draft.runtimeIdentity = runtimeIdentity

  let caught: Error | undefined
  try {
    assertDeclaredNativeSha("alacritty", runtimeIdentity, declaration, nativeTreeOid, draftPath, (line) =>
      warnings.push(line),
    )
  } catch (error) {
    caught = error as Error
    finalizeHeadlessAttempt(
      draft,
      {
        ...readCollectorAttempt(draft.rawReplies),
        ids,
        startedAt,
        result: "failed",
        error: caught.message,
      },
      registryDefinitions(ids),
    )
    recordCollectionFailure(draft, startedAt, caught.message, ids)
  }

  expect(caught).toBeDefined()
  expect(warnings).toEqual([caught!.message])
  expect(caught!.message).toContain(loadedSha)
  expect(caught!.message).toContain(`expected sha ${expectedSha}`)
  expect(caught!.message).toContain(`nativeTreeOid ${nativeTreeOid}`)
  expect(caught!.message).toContain(`draft: ${draftPath}`)
  expect(draft.rawReplies["collector.failure"]).toBe(caught!.message)
  expect(draft.rawReplies["collector.finalizationFailure"]).toBeUndefined()
  expect(draft.rawReplies["collector.replyPath"]).toBeUndefined()
  expect(Object.keys(draft.rawReplies).filter((key) => key.startsWith("collector.hostRecipes."))).toEqual([])
  expect(draft.results.every((row) => row.attempt.scope === "collection" && row.reason === caught!.message)).toBe(true)

  // #31810: kitty is typed "native" in backends.json but is a `kitty +runpy` subprocess bridge that loads
  // no .node addon; evaluating readNativeArtifactTreeOid(entry.package) as an argument to assertDeclaredNativeSha
  // must never ask require.cache for a loaded native addon in packages/kitty.
  const { readNativeArtifactTreeOid } = await import("./headless-identity.ts")
  const kittyIdentity = {
    kind: "native" as const,
    engineVersion: "0.49.2",
    adapterVersion: "0.10.2",
    termlessRevision: "07628619c7b5b5f74de1536df16dab0bc62676b6",
    loadedBinary: {
      path: "/nix/store/fbpk67n6fd9kb95vl7ksrc7pkh3gx3qx-kitty-official-binary-0.49.2/bin/kitty",
      sha256: "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886",
    },
    provenance: {
      sha256: "bb65c2d57e56eecca8143d73771432cf7dd386bccd36ae658950e5923a661886",
      sourceCommit: "07628619c7b5b5f74de1536df16dab0bc62676b6",
      buildHash: "88e840e1b8e7f09edf3464ee33df8753fd5107838de15bccb6ea59e0dd6cc9c3",
      toolchain: "Nix kitty +runpy",
      lockSha256: "282d1098337a5705a7c1d13188a74d2fe34565766619e8d6b21a48d5b67451be",
    },
  }
  const kittyWarnings: string[] = []
  expect(readNativeArtifactTreeOid("@termless/kitty")).toBeUndefined()
  expect(readNativeArtifactTreeOid("@termless/kitty", "kitty")).toBeUndefined()
  expect(() =>
    assertDeclaredNativeSha(
      "kitty",
      kittyIdentity,
      undefined,
      readNativeArtifactTreeOid("@termless/kitty", "kitty"),
      "pass-qd5XqF/lib-kitty-unknown.draft.json",
      (line) => kittyWarnings.push(line),
    ),
  ).not.toThrow()
  expect(kittyWarnings).toEqual([])
})

// 31387: Ghostty native's adapter reports an empty title after OSC 2, so the title-stack round trip observes
// nothing. A rowless inconclusive was folded to TEST FAILURE as a callback defect; an unobservable setup takes
// the headless observable review instead, with the three empty readings retained as raw state.
const TITLE_STACK_IDS = ["device.xtwinops-22", "device.xtwinops-23"] as const

function expectTitleSetupReview(batch: Awaited<ReturnType<typeof collectBatch>>): void {
  expect(batch.results).toMatchObject(
    TITLE_STACK_IDS.map((featureId) => ({
      featureId,
      status: "test-todo",
      criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
      tests: [
        {
          id: "review",
          status: "test-todo",
          reason: "Title setup was not observable, so this run cannot decide it",
        },
      ],
    })),
  )
  expect(batch.observations).toEqual([])
  expect(batch.assertions).toEqual([])
  for (const id of TITLE_STACK_IDS) {
    expect(JSON.parse(batch.rawReplies[id]!)).toEqual({ original: "", changed: "", restored: "" })
  }
}

test("an adapter that reports no title gives the title-stack cells a headless observable review", async () => {
  const batch = await collectBatch(
    async () => {
      const value = createXtermBackend()
      vi.spyOn(value, "getTitle").mockReturnValue("")
      return value
    },
    "xtermjs",
    registryDefinitions(TITLE_STACK_IDS),
  )
  expectTitleSetupReview(batch)
})

test.skipIf(!ghosttyNativeAvailable)(
  `real Ghostty native title-stack cells are a headless observable review${ghosttyNativeAvailable ? "" : " (NOT MEASURED: native addon unavailable)"}`,
  async () => {
    const batch = await collectBatch(
      async () => createGhosttyNativeBackend(),
      "ghostty-native",
      registryDefinitions(TITLE_STACK_IDS),
    )
    expectTitleSetupReview(batch)
  },
)
