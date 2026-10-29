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
import { resolve as resolveLibvterm } from "@termless/libvterm"
import { resolve as resolveVt100 } from "@termless/vt100"
import { resolve as resolveVt220 } from "@termless/vt220"
import { createKittyBackend, isKittyAvailable } from "@termless/kitty"
import { createGhosttyNativeBackend, isGhosttyNativeAvailable } from "@termless/ghostty-native"
import type { EmulatorWarning } from "@termless/core"
import {
  ALL_PROBES,
  HARNESS_INCOMPLETE_TEST,
  type ProbeCallbackResult,
  type ProbeDefinition,
} from "@terminfo/probe-defs"
import { fakeProbeResult } from "@terminfo/probe-defs/testing/fake-probe-result"
import { validateObservation, retainCaptureBinding } from "@terminfo/run-parser"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { collectBatch, createLibProbeSource, feedCapture } from "./headless-batch.ts"

/** Feature captures only; collector qualification metadata is asserted in sentinel-member.test.ts. */
function probeReplies(batch: Awaited<ReturnType<typeof collectBatch>>) {
  const { "collector.replyPath": _qualification, ...replies } = batch.rawReplies
  return replies
}

async function backend() {
  return createXtermBackend()
}

// libvterm exposes no mode getter; its real cell behavior still decides wrapping.
test("null mode metadata classes A/B retain measured wrapping, unknown cleanup and raw state", async () => {
  const writes: string[] = []
  const factory = async () => {
    const value = await resolveLibvterm()
    // libvterm's WASM bridge exposes no modes. Termless answers null only from #30549, which the
    // published @termless/libvterm 0.10.2 that CI installs predates, so pin the null reading here:
    // the subject is terminfo's null-mode consumers, not the termless version.
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
  expect.soft(writes).not.toContain("\x1b[?2031l")
  expect.soft(JSON.parse(batch.rawReplies["modes.application-keypad"]!)).toMatchObject({ on: null, off: null })
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
    criterionBranch: "os-input-review",
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
test("requests review for headless OS-input criteria without fabricating app delivery", async () => {
  const ids = [
    "input.xtest-key",
    "input.xtest-click",
    "input.xtest-wheel",
    "extensions.clipboard-paste",
    "input.modify-other-keys",
    "input.modify-other-keys-3",
    "input.pixel-mouse",
    "input.urxvt-mouse",
    "input.x10-mouse",
    "input.button-event-mouse",
    "input.kitty-click-events",
    "modes.alt-scroll-1007",
    "modes.application-keypad",
  ]
  const coverage = (id: string) =>
    id === "modes.application-keypad"
      ? { reason: /keypad input/, raw: { on: expect.any(Boolean), off: expect.any(Boolean) } }
      : { reason: /OS-level XTEST/, raw: { input: false } }
  const definitions = ids.map((id) => {
    const found = ALL_PROBES.find((probe) => probe.id === id)
    if (!found) throw new Error(`Missing registry definition ${id}`)
    return found
  })
  const batch = await collectBatch(backend, "xtermjs", definitions)
  expect(batch.results).toHaveLength(ids.length)
  expect(batch.observations).toEqual([])
  expect(batch.assertions).toEqual([])
  expect(batch.ungradedDiagnostics).toEqual({})
  for (const result of batch.results) {
    expect(result.status, result.featureId).toBe("test-todo")
    const expected = coverage(result.featureId)
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
      criterionBranch: "semantic-prompt-source-review",
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
  const binding = retainCaptureBinding(captured, id)
  expect(captured.rawReplies[binding.rawReplyRef]).toBe(binding.source)
  expect(JSON.parse(binding.source)).toMatchObject({
    featureId: id,
    criterionBranch: "semantic-prompt-source-review",
    rawReplyRefs: expect.arrayContaining([
      expect.objectContaining({ key: id, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]),
  })
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
    expect(batch.observations).toEqual([])
    expect(batch.assertions).toEqual([])
    for (const result of batch.results) {
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
for (const [name, create] of [
  ["libvterm", resolveLibvterm],
  ["xtermjs", async () => createXtermBackend()],
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
      expect(batch.observations.find((item) => item.featureId === "modes.reverse-video")).toBeUndefined()
      expect(batch.notTested.find((item) => item.featureId === "modes.reverse-video")).toMatchObject({
        reason: "no-semantic-observable",
        noObservable: "rendered colors (pixels)",
      })
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

// 30581: a refused callback result keeps its response under its feature id and its refused observation and
// assertions as text in the refusal, on every recorder branch, so the run file shows what the grader saw.
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
// The recorder admits it as measured, publishes no verdict and synthesizes nothing into rawReplies.
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
    expect.objectContaining({ featureId: "silent", status: "test-failure", reason: "no-response" }),
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
