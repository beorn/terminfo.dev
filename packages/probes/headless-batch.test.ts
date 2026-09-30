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
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { collectBatch } from "./headless-batch.ts"

async function backend() {
  return createXtermBackend()
}

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
      expect(batch.observations.find((item) => item.featureId === "modes.reverse-video")).toMatchObject({
        outcome: "inconclusive",
        reason: "insufficient-evidence",
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
        return { pass: true }
      }),
    ])
    expect(replies).toEqual(["\x1b[2;3R", "\x1b[4;5R", "\x1b[1;1R"])
    expect(previous.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes)).join("")).toBe("\x1b[1;1R")
    expect(value.onResponse).toBe(previous)
  })
}

test("real vterm grades interior-region SU without creating scrollback history", async () => {
  const id = "scrollback.scroll-up"
  const probe = ALL_PROBES.find((item) => item.id === id)
  if (!probe) throw new Error(`Missing ${id} registry definition`)
  const value = createVtermBackend()
  const batch = await collectBatch(async () => value, "vterm", [probe])
  expect(batch.observations).toMatchObject([{ featureId: id, outcome: "supported", evidence: "parser-state" }])
  expect(batch.assertions).toMatchObject([{ featureId: id, kind: "positive" }])
  const raw = batch.rawReplies[id]
  if (!raw) throw new Error(`Missing ${id} raw measurement`)
  expect(JSON.parse(raw)).toMatchObject({
    seed: ["A", "B", "C", "D", "E"],
    beforeScroll: { totalLines: 24, screenLines: 24 },
    afterScroll: { totalLines: 24, screenLines: 24 },
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
    const child = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" })
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
  if (stage === "init")
    vi.spyOn(value, "init").mockImplementation(() => {
      throw failure
    })
  const callback = vi.fn(() => ({ pass: true }))
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
  expect(batch).toEqual({
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
    rawReplies: {},
    ungradedDiagnostics: {},
  })
})

// AC3: cleanup failure cannot leave a worker collecting and sealing apparently valid data.
test("aborts the batch on failed cleanup before invoking another probe", async () => {
  const value = await backend()
  vi.spyOn(value, "destroy").mockImplementationOnce(() => {
    throw new Error("Cleanup failed")
  })
  const next = vi.fn(() => ({ pass: true }))
  try {
    await expect(
      collectBatch(async () => value, "xtermjs", [
        definition("first", () => ({ pass: true })),
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
        return { pass: false }
      },
      { termlessObservationEvidence: "query" },
    ),
  ])
  expect(value.onResponse).toBe(previous)
  expect(batch).toEqual({
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
    rawReplies: {},
    ungradedDiagnostics: {},
  })
})

test("attributes unavailable fixture grids to each probe without invoking callbacks", async () => {
  const callback = vi.fn(() => ({ pass: false }))
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
  expect(batch).toEqual({
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
    expect(batch).toEqual({
      observations: [
        {
          featureId: "invalid-none",
          outcome: "error",
          reason: "collector-error",
          evidence: "none",
          note: "Termless callback invalid-none declares parser-state evidence but returned none without an unmeasured refusal",
        },
      ],
      assertions: [],
      rawReplies: {},
      ungradedDiagnostics: {},
    })
  },
)

test("does not promote a marked legacy callback's conclusion into an observation", async () => {
  const batch = await collectBatch(backend, "xtermjs", [
    definition("legacy", () => ({ pass: true, note: "Legacy conclusion" }), {
      termlessObservationEvidence: "parser-state",
    }),
  ])
  expect(batch).toEqual({
    observations: [],
    assertions: [],
    rawReplies: {},
    ungradedDiagnostics: { legacy: { kind: "legacy-callback", pass: true, note: "Legacy conclusion" } },
  })
})
