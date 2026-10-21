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
import { createKittyBackend, isKittyAvailable } from "@termless/kitty"
import { ALL_PROBES, type ProbeDefinition } from "@terminfo/probe-defs"
import { fakeProbeResult } from "@terminfo/probe-defs/testing/fake-probe-result"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { collectBatch, createTermlessContext } from "./headless-batch.ts"

async function backend() {
  return createXtermBackend()
}

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
    expect(result.checks, result.featureId).toContainEqual(
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

// Final-return checks miss hard death during the active callback; its checkpoint must already exist.
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
  termless: ProbeDefinition["termless"],
  markers: Pick<ProbeDefinition, "termObservationEvidence" | "termlessObservationEvidence"> = {},
): ProbeDefinition {
  return { id, termless, term: null, ...markers }
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
        evidence: "parser-state",
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
      await collectBatch(async () => value, name, [
        definition("capture", (ctx) => {
          ctx.feed("\x1b[6n") // This reply belongs to the previous listener.
          replies.push(ctx.feedCapture("\x1b[2;3H\x1b[6n"))
          replies.push(ctx.feedCapture("\x1b[4;5H\x1b[6n"))
          ctx.reset()
          replies.push(ctx.feedCapture("\x1b[6n"))
          return fakeProbeResult()
        }),
      ])
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

test("real vterm grades interior-region SU without moving the row above into history", async () => {
  const id = "scrollback.scroll-up"
  const probe = ALL_PROBES.find((item) => item.id === id)
  if (!probe) throw new Error(`Missing ${id} registry definition`)
  const value = createVtermBackend()
  const batch = await collectBatch(async () => value, "vterm", [probe])
  expect(batch.observations).toMatchObject([{ featureId: id, outcome: "supported", evidence: "parser-state" }])
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
    definition("marked", throws, { termObservationEvidence: "query", termlessObservationEvidence: "parser-state" }),
    definition("app-only", throws, { termObservationEvidence: "query" }),
    definition("legacy", throws),
  ])
  expect(batch.observations).toEqual([
    {
      featureId: "marked",
      outcome: "error",
      reason: "collector-error",
      evidence: "parser-state",
      note: "headless xtermjs probe marked: Callback failed",
    },
  ])
  expect(batch.ungradedDiagnostics).toEqual({
    "app-only": {
      kind: "collector-error",
      name: "TypeError",
      message: "headless xtermjs probe app-only: Callback failed",
    },
    legacy: { kind: "collector-error", name: "TypeError", message: "headless xtermjs probe legacy: Callback failed" },
  })
  expect(batch.rawReplies).toEqual({})
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
  expect(
    batch.observations.map(({ featureId, outcome, reason, evidence }) => ({ featureId, outcome, reason, evidence })),
  ).toEqual([
    { featureId: "sgr.bold", outcome: "error", reason: "collector-error", evidence: "parser-state" },
    { featureId: "cursor.move.absolute", outcome: "error", reason: "collector-error", evidence: "parser-state" },
    { featureId: "device.primary-da", outcome: "error", reason: "collector-error", evidence: "query" },
    { featureId: "extensions.osc133-a", outcome: "error", reason: "collector-error", evidence: "consumed" },
    { featureId: "sgr.reset", outcome: "error", reason: "collector-error", evidence: "parser-state" },
    { featureId: "cursor.save-restore", outcome: "error", reason: "collector-error", evidence: "parser-state" },
    { featureId: "cursor.cup-scroll-region", outcome: "error", reason: "collector-error", evidence: "parser-state" },
    { featureId: "extensions.truecolor", outcome: "error", reason: "collector-error", evidence: "parser-state" },
  ])
  expect(Object.keys(batch.ungradedDiagnostics).sort()).toEqual(ids.slice(8).sort())
  expect(batch.assertions).toEqual([])
  expect(batch.rawReplies).toEqual({})
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
    [definition("setup", callback, { termlessObservationEvidence: "parser-state" })],
  )
  expect(callback).not.toHaveBeenCalled()
  if (stage === "init") expect(destroy).toHaveBeenCalledOnce()
  expect(batch).toMatchObject({
    observations: [
      {
        featureId: "setup",
        outcome: "error",
        reason: "collector-error",
        evidence: "parser-state",
        note: `headless xtermjs probe setup: ${stage} failed`,
      },
    ],
    assertions: [],
    notTested: [],
    rawReplies: {},
    ungradedDiagnostics: {},
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
      [definition("declines", callback, { termlessObservationEvidence: "none" })],
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
  expect(ligatures?.termlessObservationEvidence).toBe("none")
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
        return fakeProbeResult("query")
      },
      { termlessObservationEvidence: "query" },
    ),
  ])
  expect(value.onResponse).toBe(previous)
  expect(batch).toMatchObject({
    observations: [
      {
        featureId: "query",
        outcome: "error",
        reason: "collector-error",
        evidence: "query",
        note: "headless xtermjs probe query: Feed failed",
      },
    ],
    assertions: [],
    notTested: [],
    rawReplies: {},
    ungradedDiagnostics: {},
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
    definition("first", callback, { termlessObservationEvidence: "parser-state" }),
    definition("second", callback, { termlessObservationEvidence: "query" }),
  ])
  expect(batch.observations).toMatchObject([
    { featureId: "first", outcome: "error", reason: "collector-error", evidence: "parser-state" },
    { featureId: "second", outcome: "error", reason: "collector-error", evidence: "query" },
  ])
  expect(batch.observations[0]?.note).toContain("headless xtermjs probe first:")
  expect(batch.observations[0]?.note).toContain("no initialized row 0 grid")
  expect(callback).not.toHaveBeenCalled()
})

test("rejects a returned method that disagrees with the marker and preserves matching or unmeasured refusals", async () => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "wrong",
      () => ({
        pass: false,
        observation: { outcome: "inconclusive", reason: "no-response", evidence: "query" },
      }),
      { termlessObservationEvidence: "parser-state" },
    ),
    definition(
      "matching",
      () => ({
        pass: false,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "parser-state" },
      }),
      { termlessObservationEvidence: "parser-state" },
    ),
    definition(
      "refused",
      () => ({
        pass: false,
        observation: { outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
      }),
      { termlessObservationEvidence: "parser-state" },
    ),
  ])
  expect(batch).toMatchObject({
    observations: [
      {
        featureId: "wrong",
        outcome: "error",
        reason: "collector-error",
        evidence: "query",
        note: "Termless callback wrong declares parser-state evidence but returned query",
      },
      { featureId: "matching", outcome: "inconclusive", reason: "insufficient-evidence", evidence: "parser-state" },
      { featureId: "refused", outcome: "inconclusive", reason: "insufficient-evidence", evidence: "none" },
    ],
    assertions: [],
    notTested: [],
    rawReplies: {},
    ungradedDiagnostics: {},
  })
})

test.each(["supported", "error", "raw", "assertion"] as const)(
  "rejects a marked none result with %s instead of an unmeasured inconclusive refusal",
  async (variant) => {
    const batch = await collectBatch(backend, "xtermjs", [
      definition(
        "invalid-none",
        (ctx) => {
          ctx.feed("X")
          const observed = ctx.getCell(0, 0).char
          return {
            pass: variant === "supported",
            observation: {
              outcome: variant === "supported" ? "supported" : variant === "error" ? "error" : "inconclusive",
              evidence: "none",
              ...(variant !== "supported" && { reason: "insufficient-evidence" as const }),
            },
            ...((variant === "supported" || variant === "raw") && { response: observed }),
            ...((variant === "supported" || variant === "assertion") && {
              assertions: [{ kind: "positive" as const, expected: "X", observed }],
            }),
          }
        },
        { termlessObservationEvidence: "parser-state" },
      ),
    ])
    expect(batch).toMatchObject({
      observations: [],
      assertions: [],
      notTested: [],
      rawReplies: {},
      // `none` cannot carry an error: the canonical parser admits it only as an inconclusive
      // refusal, so this contradiction stays a named ungraded diagnostic.
      ungradedDiagnostics: {
        "invalid-none": {
          kind: "collector-error",
          name: "Error",
          message:
            "Termless callback invalid-none declares parser-state evidence but returned none without an unmeasured refusal",
        },
      },
    })
  },
)

test("refuses a callback result that is neither a measurement nor a coverage record", async () => {
  // The union makes this unreachable from a typed callback; an untyped caller still gets a loud refusal.
  const untyped = (() => ({ pass: true, note: "Legacy conclusion" })) as unknown as ProbeDefinition["termless"]
  const batch = await collectBatch(backend, "xtermjs", [
    definition("legacy", untyped, { termlessObservationEvidence: "parser-state" }),
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
      { termlessObservationEvidence: "parser-state" },
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
      { termlessObservationEvidence: "parser-state" },
    ),
  ])
  expect(batch.notTested).toEqual([])
  expect(batch.observations).toMatchObject([
    { featureId: "modes.bracketed-paste", outcome: "error", reason: "collector-error" },
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
      { termlessObservationEvidence: "parser-state" },
    ),
  ])
  expect(batch.notTested).toEqual([])
  expect(batch.observations).toMatchObject([
    { featureId: "modes.bracketed-paste", outcome: "error", reason: "collector-error" },
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
          evidence: "parser-state",
          note: "backend read failed",
        },
      })) as unknown as ProbeDefinition["termless"],
      { termlessObservationEvidence: "parser-state" },
    ),
    definition(
      "modes.focus-events",
      () => ({
        pass: false,
        response: JSON.stringify({ mode: false }),
        notTested: { reason: "no-semantic-observable", noObservable: "input events" },
      }),
      { termlessObservationEvidence: "parser-state" },
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
  expect(batch.observations).toMatchObject([
    { featureId: "modes.bracketed-paste", outcome: "error", reason: "collector-error", evidence: "parser-state" },
  ])
  expect(batch.observations[0]?.note).toContain(
    "beside observation(outcome=error, reason=collector-error, evidence=parser-state",
  )
  expect(batch.rawReplies["modes.bracketed-paste"]).toBe(JSON.stringify({ mode: false }))
  expect(batch.observations[0]?.rawReplyRef).toBe("modes.bracketed-paste")
  expect(batch.observations[0]?.note).toContain('note="backend read failed"')
})

test("refuses named coverage that arrives beside supported observation and assertions", async () => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition(
      "modes.bracketed-paste",
      (() => ({
        pass: true,
        response: JSON.stringify({ mode: true }),
        notTested: { reason: "no-semantic-observable", noObservable: "input events" },
        observation: { outcome: "supported", evidence: "parser-state" },
        assertions: [{ kind: "positive", expected: "mode=true", observed: JSON.stringify({ mode: true }) }],
      })) as unknown as ProbeDefinition["termless"],
      { termlessObservationEvidence: "parser-state" },
    ),
  ])
  expect(batch.notTested).toEqual([])
  expect(batch.assertions).toEqual([])
  expect(batch.observations).toMatchObject([
    { featureId: "modes.bracketed-paste", outcome: "error", reason: "collector-error", evidence: "parser-state" },
  ])
  expect(batch.rawReplies["modes.bracketed-paste"]).toBe(JSON.stringify({ mode: true }))
  expect(batch.observations[0]?.note).toContain("assertion(kind=positive")
  expect(batch.observations[0]?.note).toContain("expected=")
  expect(batch.observations[0]?.note).toContain("observed=")
})

// AC3: feature support cannot authorize metadata readback. Existing tests grade
// outcomes but do not catch a placeholder hyperlink=null presented as reported.
test("OSC 8 feature without metadata extension omits the cell field", () => {
  const value = createXtermBackend({ cols: 80, rows: 24 })
  try {
    value.capabilities.extensions.delete("hyperlinks")
    value.feed(new TextEncoder().encode("\x1b]8;;https://example.com/observed\x07L"))
    expect(value.capabilities.osc8Hyperlinks).toBe(true)
    expect(createTermlessContext(value).getCell(0, 0)).not.toHaveProperty("hyperlink")
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
    expect(() => createTermlessContext(value).getCell(0, 0)).toThrow(`${value.name} declares OSC 8 metadata`)
  } finally {
    value.destroy()
  }
})

// Runtime status must preserve attempted failure separately from an unstarted implementation;
// old observation/coverage tests cannot express a catalogue member with no callback.
test("records a complete explicit catalogue and retains probe attempt failure", async () => {
  const { initializeRunDraft } = await import("@terminfo/probe-defs")
  const draft = initializeRunDraft({
    runId: "headless-status-contract",
    sourceRevision: "a".repeat(40),
    intendedContext: { kind: "headless", id: "xtermjs" },
    manifest: {
      probeHash: "runtime-suite",
      adapterVersion: "3",
      catalogIds: ["attempted", "unimplemented"],
      probes: { app: [], mux: [], headless: ["attempted"] },
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
        { termlessObservationEvidence: "parser-state" },
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
