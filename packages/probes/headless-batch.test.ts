/**
 * @failure Headless exceptions borrow an app marker, mismarked observations enter a batch of probe results, or a missing worker artifact is hidden by a stack line.
 * @level l1
 * @consumer Production headless batch collector
 * @reach imports headless-batch.ts and collect-headless.ts at the production backend/worker boundary
 * @testonly none
 */
/* oxlint-disable typescript/no-deprecated -- Exercise the production TerminalBackend adapter boundary. */
import { createXtermBackend } from "@termless/xtermjs"
import { createAlacrittyBackend } from "@termless/alacritty"
import { createVt100RustBackend } from "@termless/vt100-rust"
import { createVt100Backend } from "@termless/vt100"
import { createVt220Backend } from "@termless/vt220"
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
  isDeclaredUntestable,
  type CapturedRunDraft,
  type HeadlessRuntimeIdentity,
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
import { OWNED_LAYOUT } from "./fixtures/owned-layout.fixture.ts"

// @failure A declared pointer-state reader is dropped or its buffer_state result is refused by collection.
// @level l1
// @consumer Existing backend -> source binding -> registered OSC22 callback -> finalizer; not an engine grade.
test.each(["working", "target", "unknown", "restore", "inert"] as const)(
  "R3 pointer reader %s crosses the collector with qualified controls",
  async (fault) => {
    const batch = await collectBatch(
      async () => {
        const value = createXtermBackend()
        let shape = "text"
        const feed = value.feed.bind(value)
        value.feed = (bytes) => {
          const text = new TextDecoder().decode(bytes)
          const requested = /^\x1b\]22;([^\x07]+)\x07$/.exec(text)?.[1]
          if (fault !== "inert" && requested) {
            if (requested === "text" && !(fault === "restore" && shape === "pointer")) shape = "text"
            if (requested === "wait") shape = "wait"
            if (requested === "pointer" && fault !== "target") shape = "pointer"
            if (requested === "terminfo-unknown-shape" && fault === "unknown") shape = "wait"
          }
          feed(bytes)
        }
        Object.assign(value, { getMouseShape: () => shape })
        value.capabilities.extensions.add("mouse-shape")
        return value
      },
      "xtermjs",
      registryDefinitions(["extensions.osc22-pointer"]),
    )
    if (fault === "working") {
      expect(batch.results).toMatchObject([{ status: "supported", assertionType: "buffer_state" }])
      expect(batch.observations).toMatchObject([{ outcome: "supported", assertionType: "buffer_state" }])
    } else if (fault === "target") {
      expect(batch.results).toMatchObject([{ status: "unsupported", assertionType: "buffer_state" }])
    } else {
      expect(batch.results).toMatchObject([{ status: "probe-todo" }])
      expect(batch.observations).toEqual([])
    }
  },
)

test("R3 pointer capability with a missing method fails loudly; undeclared readers remain unwired", () => {
  const value = createXtermBackend({ cols: 80, rows: 24 })
  try {
    value.capabilities.extensions.add("mouse-shape")
    expect(() => createLibProbeSource(value, undefined, undefined, undefined)).toThrow(
      /declares mouse-shape without getMouseShape/,
    )
    value.capabilities.extensions.delete("mouse-shape")
    Object.assign(value, { getMouseShape: () => "pointer" })
    const result = registryDefinitions(["extensions.osc22-pointer"])[0]!.lib!(
      createLibProbeSource(value, undefined, undefined, undefined),
    )
    expect(result.observation).toBeUndefined()
  } finally {
    value.destroy()
  }
})

// @failure Rebuilt native readers work in isolation but fail the registered R3 callbacks or result finalizer.
// @level l1
// @consumer The actual owned Ghostty addon -> existing collector source -> twelve shipping library rows.
test.runIf(OWNED_LAYOUT)(
  "real Ghostty native R3 readers decide the twelve registered rows and measured collateral",
  async () => {
    const rows = [
      ["extensions.osc133-a", "supported"],
      ["extensions.osc133-b", "supported"],
      ["extensions.osc133-c", "supported"],
      ["extensions.osc133-d", "supported"],
      ["extensions.osc133-p", "supported"],
      ["extensions.semantic-prompts", "supported"],
      ["extensions.osc22-pointer", "supported"],
      ["extensions.kitty-graphics.display", "untestable"],
      ["extensions.kitty-graphics.transmit", "untestable"],
      ["extensions.osc52-write", "supported"],
      ["extensions.osc52-read", "untestable"],
      ["extensions.osc52-clipboard", "untestable"],
      ["extensions.osc633-a", "unsupported"],
      ["extensions.osc633-b", "unsupported"],
      ["extensions.osc633-c", "unsupported"],
      ["extensions.osc633-d", "unsupported"],
      ["extensions.osc633-e", "untestable"],
      ["extensions.osc633-p", "unsupported"],
      ["extensions.osc-633-vscode", "untestable"],
    ] as const
    const backend = createGhosttyNativeBackend()
    const runtimeIdentity = {
      ...(await headlessIdentity.headlessRuntimeIdentity("ghostty-native", "@termless/ghostty-native", "native")),
      adapterSources: headlessIdentity.readAdapterSources("ghostty-native", backend),
    }
    const clipboardReads: unknown[] = []
    const definitions = registryDefinitions(rows.map(([id]) => id)).map((definition) => ({
      ...definition,
      lib: (ctx: LibProbeSource) => {
        const query = ctx.queryWithSentinelOutcome?.bind(ctx)
        return definition.lib!({
          ...ctx,
          runtimeIdentity,
          ...(query && definition.id.startsWith("extensions.osc52-")
            ? {
                queryWithSentinelOutcome(sequence: string, pattern: RegExp) {
                  const before = ctx.getClipboardState?.().pasteSelector
                  const outcome = query(sequence, pattern)
                  clipboardReads.push({
                    id: definition.id,
                    before,
                    after: ctx.getClipboardState?.().pasteSelector,
                    outcome,
                  })
                  return outcome
                },
              }
            : {}),
        })
      },
    }))
    const batch = await collectBatch(async () => createGhosttyNativeBackend(), "ghostty-native", definitions)
    expect(
      batch.results.map(({ featureId, status }) => [featureId, status]),
      JSON.stringify({ results: batch.results, clipboardReads }),
    ).toEqual(rows)
    expect(batch.results.filter((row) => row.status === "supported").map((row) => row.assertionType)).toEqual([
      ...Array.from({ length: 7 }, () => "buffer_state"),
      "query_reply",
    ])
    for (const id of ["extensions.osc52-read", "extensions.osc52-clipboard"]) {
      expect(batch.results.find((row) => row.featureId === id)?.reason).toContain("passed to the app")
    }
    for (const id of ["extensions.kitty-graphics.display", "extensions.kitty-graphics.transmit"]) {
      expect(batch.results.find((row) => row.featureId === id)?.reason).toContain("ghostty-vt forces oniguruma off")
    }
  },
)

// @failure WezTerm's stored cells, Kitty placement or clipboard callbacks never reach the shipping library arms.
// @level l0
// @consumer Existing WezTerm native backend -> headless source -> literal shipping probe callbacks.
test.runIf(OWNED_LAYOUT)("real WezTerm readers expose semantic cells, image placement and clipboard writes", () => {
  for (const id of [
    "extensions.osc133-a",
    "extensions.osc133-b",
    "extensions.osc133-c",
    "extensions.osc133-p",
    "extensions.kitty-graphics.transmit",
    "extensions.kitty-graphics.display",
    "extensions.osc52-write",
  ]) {
    const value = createWeztermBackend()
    try {
      value.init({ cols: 80, rows: 24, pixelGeometry: { cellWidth: 10, cellHeight: 20 } })
      expect(feedCapture(value, "\x1b[6n", undefined)).toBe("\x1b[1;1R")
      const source = createLibProbeSource(value, { graceMs: 0, onSentinel() {} }, undefined, undefined)
      const definition = ALL_PROBES.find((probe) => probe.id === id)
      if (!definition?.lib) throw new Error(`Missing WezTerm library arm ${id}`)
      const result = definition.lib(source)
      expect.soft(result.observation?.outcome, `${id}: ${JSON.stringify(result)}`).toBe("supported")
      if (id === "extensions.kitty-graphics.display") {
        expect.soft(result.observation?.assertionType).toBe("buffer_state")
        expect.soft(result.note).toContain("pixels were not tested")
      }
    } finally {
      value.destroy()
    }
  }
})

// Native positive coverage cannot detect an inert reader or report-only admission of a silent transfer.
// @failure A constant image count, a lost placement, or a report without image state receives Supported.
// @level l0
// @consumer The Kitty display library arm through the real WezTerm parser.
test.runIf(OWNED_LAYOUT)(
  "WezTerm image placement requires a changing reader and an inert unknown-image control",
  () => {
    for (const fault of ["zero", "one", "placement", "report-only"] as const) {
      const value = createWeztermBackend()
      try {
        value.init({ cols: 80, rows: 24, pixelGeometry: { cellWidth: 10, cellHeight: 20 } })
        const source = createLibProbeSource(value, { graceMs: 0, onSentinel() {} }, undefined, undefined)
        let transferWasSilent = false
        const controlled: LibProbeSource = {
          ...source,
          getCellImageCount:
            fault === "report-only"
              ? undefined
              : fault === "zero"
                ? () => 0
                : fault === "one"
                  ? () => 1
                  : source.getCellImageCount,
          getUnhandledSequences: fault === "report-only" ? () => [] : source.getUnhandledSequences,
          queryWithSentinelOutcome(sequence, pattern) {
            const silentTransfer = fault === "report-only" && sequence.includes("a=t,")
            const outcome = source.queryWithSentinelOutcome!(
              silentTransfer
                ? sequence.replace("a=t,", "a=d,")
                : fault === "placement"
                  ? sequence.replace("a=p,", "a=d,")
                  : sequence,
              pattern,
            )
            if (silentTransfer) transferWasSilent = outcome.match === null && outcome.reason === "sentinel"
            return outcome
          },
        }
        const definition = ALL_PROBES.find((probe) => probe.id === "extensions.kitty-graphics.display")!
        const result = definition.lib!(controlled)
        expect(result.observation?.outcome, `${fault}: ${JSON.stringify(result)}`).not.toBe("supported")
        expect(result.notTested, `${fault}: ${JSON.stringify(result)}`).toBeDefined()
        if (fault === "report-only") expect(transferWasSilent).toBe(true)
      } finally {
        value.destroy()
      }
    }
  },
)

// Existing mark-history controls cannot exercise the per-cell reader's negative decisions.
// @failure A dropped OSC133 target or broken unknown-letter control acquires Supported.
// @level l0
// @consumer Shipping semantic-cell library arms against the real WezTerm parser.
test.runIf(OWNED_LAYOUT)("real WezTerm R2 semantic-cell controls distinguish target no-op and inert readers", () => {
  for (const target of ["A", "B", "C", "P"] as const) {
    for (const fault of ["target", "unknown", "reader"] as const) {
      const value = createWeztermBackend()
      try {
        value.init({ cols: 80, rows: 24 })
        const source = createLibProbeSource(value, undefined, undefined, undefined)
        const controlled: LibProbeSource = {
          ...source,
          feed(text) {
            source.feed(
              fault === "target"
                ? text.replace(`\x1b]133;${target}\x07`, "\x1b]133;Z\x07")
                : fault === "unknown"
                  ? text.replace("\x1b]133;Z\x07", "\x1b]133;C\x07")
                  : text,
            )
          },
          getCellSemanticType: fault === "reader" ? () => "output" : source.getCellSemanticType,
        }
        const definition = ALL_PROBES.find((probe) => probe.id === `extensions.osc133-${target.toLowerCase()}`)!
        const result = definition.lib!(controlled)
        if (fault === "target") expect(result.observation?.outcome, JSON.stringify(result)).toBe("unsupported")
        else expect(result.notTested, JSON.stringify(result)).toBeDefined()
      } finally {
        value.destroy()
      }
    }
  }
})

/** Feature payloads only; collector records use the reserved collector.* namespace. */
function probeReplies(batch: Awaited<ReturnType<typeof collectBatch>>) {
  return Object.fromEntries(Object.entries(batch.rawReplies).filter(([key]) => !key.startsWith("collector.")))
}

async function backend() {
  return createXtermBackend()
}

// @failure The approved nine mode observations stay TODO despite a controlled report, public state or effect.
// @level l5
// @consumer Registered mode callbacks on the owned real engines; prior tests cover only DECRPM and two state opt-ins.
test.runIf(OWNED_LAYOUT).each([
  { name: "vt100", create: createVt100Backend, type: "js", id: "modes.decsclm", number: 4, expected: "unsupported" },
  { name: "vt220", create: createVt220Backend, type: "js", id: "modes.decsclm", number: 4, expected: "unsupported" },
  ...[
    { id: "modes.bracketed-paste", number: 2004 },
    { id: "modes.mouse-tracking", number: 1000 },
    { id: "modes.mouse-all", number: 1003 },
    { id: "modes.mouse-sgr", number: 1006 },
    { id: "modes.utf8-mouse-1005", number: 1005 },
    { id: "modes.application-cursor", number: 1 },
  ].map((row) => ({
    name: "vt100-rust",
    create: createVt100RustBackend,
    type: "native" as const,
    ...row,
    expected: "supported",
  })),
  {
    name: "alacritty",
    create: createAlacrittyBackend,
    type: "native",
    id: "modes.synchronized-output",
    number: 2026,
    expected: "supported",
  },
] as const)("controlled modes: $name $id", async ({ name, create, type, id, number, expected }) => {
  const value = await create()
  try {
    await value.init({ cols: 80, rows: 24 })
    const identity = await headlessIdentity.headlessRuntimeIdentity(name, `@termless/${name}`, type)
    identity.adapterSources = headlessIdentity.readAdapterSources(name, value)
    const source = createLibProbeSource(value, undefined, identity, undefined)
    const definition = registryDefinitions([id])[0]!
    const result = definition.lib!(source)
    expect(result.observation, result.response ?? result.note).toMatchObject({
      outcome: expected,
      assertionType: "buffer_state",
    })
    expect(
      result.assertions?.some((assertion) => assertion.kind === (expected === "supported" ? "positive" : "negative")),
    ).toBe(true)
    if (expected === "supported") {
      const disabled = definition.lib!({
        ...source,
        feed(text) {
          source.feed(text.replaceAll(`\x1b[?${number}h`, ""))
        },
      })
      expect(disabled.observation?.outcome, disabled.response ?? disabled.note).not.toBe("supported")
    }
  } finally {
    value.destroy()
  }
})

// @failure OSC22's library arm checks CPR instead of its pointer query; a target no-op,
// absent control, or silent reader must not acquire Supported, and the incoming shape must survive.
// @level l5
// @consumer Kitty library extensions.osc22-pointer, through the production reply transport
test.runIf(OWNED_LAYOUT && isKittyAvailable())(
  "Kitty OSC22 uses controlled native pointer replies and restores its incoming shape",
  () => {
    const definition = ALL_PROBES.find((entry) => entry.id === "extensions.osc22-pointer")!
    for (const [fault, initial] of [
      ["none", "0"],
      ["none", "text"],
      ["none", "pointer"],
      ["none", "wait"],
      ["target", "wait"],
      ["control", "wait"],
      ["silence", "wait"],
    ] as const) {
      const value = createKittyBackend({ cols: 80, rows: 24 })
      try {
        const source = createLibProbeSource(value, undefined, undefined, undefined)
        source.feed(`\x1b]22;${initial === "0" ? "" : initial}\x07`)
        const feed = source.feed.bind(source)
        const capture = source.feedCapture.bind(source)
        const controlled: LibProbeSource = {
          ...source,
          feed(text) {
            if (fault === "target" && text === "\x1b]22;pointer\x07") return
            if (fault === "control" && text === "\x1b]22;text\x07") return
            feed(text)
          },
          feedCapture(text) {
            const raw = capture(text)
            return fault === "silence" ? "" : raw
          },
        }
        const result = definition.lib!(controlled)
        if (fault === "none" || fault === "target") {
          expect(result.observation?.outcome, JSON.stringify(result)).toBe(
            fault === "none" ? "supported" : "unsupported",
          )
        } else {
          expect(result.notTested).toEqual({ reason: "no-semantic-observable", noObservable: NO_SAME_PATH_CONTROL })
        }
        expect(capture("\x1b]22;?__current__\x07")).toBe(`\x1b]22;${initial}\x1b\\`)
      } finally {
        value.destroy()
      }
    }
  },
  20_000,
)

// @failure A native rejection is mistaken for host delivery, lost at collector binding,
// or used outside the literal Kitty cohort. Each candidate must qualify its own payload.
// @level l5
// @consumer Kitty D2 rejection and H-4 context cells through collectBatch; undeclared cells retain TODO
test.runIf(OWNED_LAYOUT && process.env.KITTY_BINARY !== undefined && isKittyAvailable())(
  "Kitty report qualifies its eleven literal candidates while delivered OSC9 stays unreported",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "terminfo-kitty-report-"))
    vi.stubEnv("KITTY_CONFIG_DIRECTORY", join(directory, "kitty"))
    vi.stubEnv("XDG_CACHE_HOME", join(directory, "cache"))
    try {
      const identity = await headlessIdentity.headlessRuntimeIdentity("kitty", "@termless/kitty", "native")
      const value = createKittyBackend({ cols: 80, rows: 24 })
      try {
        identity.adapterSources = headlessIdentity.readAdapterSources("kitty", value)
        const source = createLibProbeSource(value, undefined, identity, undefined)
        source.feed("\x1b]9;terminfo-delivery-control\x07")
        expect(source.getUnhandledSequences!()).toEqual([])
        expect(source.getNotifications!()).toContain("terminfo-delivery-control")
      } finally {
        value.destroy()
      }
      const candidates = [
        "extensions.osc633-b",
        "extensions.osc633-e",
        "extensions.osc-633-vscode",
        "extensions.osc113-reset-pointer-fg",
        "extensions.osc114-reset-pointer-bg",
        "extensions.osc176-app-id",
        "extensions.osc440-audio",
        "extensions.osc555-flash",
        "extensions.osc666-termprop",
        "extensions.osc710-font-normal",
        "modes.decsscls",
      ]
      const semantic = ["extensions.osc133-b", "extensions.semantic-prompts"]
      const ids = [...candidates, ...semantic, "extensions.osc3008-context"]
      const draft = initializeRunDraft({
        source: { kind: "live" },
        runId: "kitty-d2-report-fixture",
        sourceRevision: "a".repeat(40),
        intendedSubject: { kind: "lib", id: "kitty" },
        manifest: {
          schemaVersion: 4,
          probeHash: "kitty-d2-report-fixture",
          adapterVersion: "fixture",
          catalogIds: ids,
          probes: { term: [], mux: [], lib: ids },
        },
      })
      const batch = await collectBatch(
        async () => createKittyBackend(),
        "kitty",
        registryDefinitions(ids),
        draft,
        undefined,
        {
          identity,
          adapterPackage: "@termless/kitty",
          adapterType: "native",
          adapterPath: fileURLToPath(import.meta.resolve("@termless/kitty")),
        },
      )
      expect(batch.results).toHaveLength(14)
      for (const result of batch.results) {
        expect(result.status, JSON.stringify(result)).toBe(
          candidates.includes(result.featureId)
            ? "unsupported"
            : result.featureId === "extensions.osc3008-context"
              ? "untestable"
              : result.featureId === "extensions.osc133-b"
                ? "unsupported"
                : "supported",
        )
        if (candidates.includes(result.featureId)) {
          expect(result.reason).toBe("library reported this sequence as unhandled")
        }
        if (result.featureId === "extensions.osc3008-context") {
          expect(result.reason).toBe(
            "Kitty 0.49.2 hands the OSC 3008 text to the app; our bridge does not keep it and exposes no context effect to read.",
          )
        }
      }
    } finally {
      vi.unstubAllEnvs()
      rmSync(directory, { recursive: true, force: true })
    }
  },
  60_000,
)

// D2's callback-only tests missed this collector boundary: a truthful parser
// rejection was invalidated by the registered query-only assertion declaration.
// This fixture tests declaration admission, not a native engine or its verdict.
test("D2 reply declarations admit parser-report evidence only when its reader exists", async () => {
  const registered = ALL_PROBES.find((probe) => probe.id === "cursor.position-report")!
  const definition: ProbeDefinition = {
    ...registered,
    lib: () => ({
      pass: false,
      response: "measured parser rejection",
      observation: { outcome: "unsupported", assertionType: "buffer_state" },
      assertions: [
        {
          assertionType: "buffer_state",
          kind: "negative",
          expected: "query handled",
          observed: "measured parser rejection",
        },
      ],
    }),
  }
  for (const present of [true, false]) {
    const carrier = async () => {
      const value = createXtermBackend()
      if (present) {
        value.capabilities.extensions.add("osc-metadata")
        Object.assign(value, { getUnhandledSequences: () => [] })
      }
      return value
    }
    const batch = await collectBatch(carrier, "declaration-fixture", [definition])
    expect(batch.results[0]?.status, JSON.stringify(batch.results[0])).toBe(present ? "unsupported" : "probe-invalid")
  }
})

/** Failure fixtures start after the real engine's independent, healthy path control. */
function afterReplyControl(factory: typeof backend): typeof backend {
  let control = true
  return async () => {
    if (control) {
      control = false
      return backend()
    }
    return factory()
  }
}

// @failure Reply qualification replaces native observations or repeats a callback that yields no controlled negative.
// @level l1
// @consumer Real Ghostty-native colour/icon callbacks and Alacritty synchronized-output through collectBatch
for (const scenario of [
  {
    name: "ghostty-native",
    create: async () => createGhosttyNativeBackend(),
    available: isGhosttyNativeAvailable(),
    ids: [
      "extensions.osc0-icon-title",
      "extensions.osc10-fg-color",
      "extensions.osc11-bg-color",
      "extensions.osc12-cursor-color",
    ],
  },
  {
    name: "alacritty",
    create: async () => createAlacrittyBackend(),
    available: true,
    ids: ["modes.synchronized-output"],
  },
]) {
  test.skipIf(!OWNED_LAYOUT || !scenario.available)(
    `preserves ${scenario.name} native observations without fresh-instance repeats`,
    async () => {
      const measured = await scenario.create()
      measured.init({ cols: 80, rows: 24 })
      const adapterPackage = `@termless/${scenario.name}`
      const identity = await headlessIdentity.headlessRuntimeIdentity(scenario.name, adapterPackage, "native")
      identity.adapterSources = headlessIdentity.readAdapterSources(scenario.name, measured)
      measured.destroy()
      const draft = initializeRunDraft({
        source: { kind: "live" },
        runId: `native-review-fixture-${scenario.name}`,
        sourceRevision: "a".repeat(40),
        intendedSubject: { kind: "lib", id: scenario.name },
        manifest: {
          schemaVersion: 4,
          probeHash: "native-review-fixture",
          adapterVersion: "fixture",
          catalogIds: scenario.ids,
          probes: { term: [], mux: [], lib: scenario.ids },
        },
      })
      let instances = 0
      const batch = await collectBatch(
        async () => {
          instances++
          return scenario.create()
        },
        scenario.name,
        registryDefinitions(scenario.ids),
        draft,
        undefined,
        {
          identity,
          adapterPackage,
          adapterPath: fileURLToPath(import.meta.resolve(adapterPackage)),
          adapterType: "native",
        },
      )
      const expected = scenario.ids.map((featureId) => {
        const slot =
          featureId === "extensions.osc10-fg-color" ? 10 : featureId === "extensions.osc11-bg-color" ? 11 : 12
        const nativeDeclaration = scenario.name === "ghostty-native"
        const colour = slot === 10 ? "foreground" : slot === 11 ? "background" : "cursor"
        const status = nativeDeclaration ? "untestable" : scenario.name === "alacritty" ? "supported" : "probe-todo"
        const reason = nativeDeclaration
          ? featureId === "extensions.osc0-icon-title"
            ? "Untestable (no way): the library offers no reading or input our test could use for this feature: Ghostty 1.3.1 updates the window title but ignores icon names and keeps no icon label."
            : `Untestable (app): the app supplies Ghostty's initial ${colour} colour. This headless library starts without one; a colour set later can be read, but it does not reveal the app's default.`
          : scenario.name === "alacritty"
            ? "buffered effect measured; rendered tearing unmeasured"
            : "Open: asking for the icon name (CSI 20 t, a short window name) got no answer within our wait, and no reply control worked in this test. With these readings, our test cannot tell whether OSC 0 set both names."
        return {
          featureId,
          status,
          reason,
          criterionBranch: nativeDeclaration ? HEADLESS_OBSERVABLE_REVIEW : undefined,
          rawReplyRef: featureId,
          tests: [
            {
              id: nativeDeclaration ? "declared-untestable" : "criterion",
              status,
              reason,
              rawReplyRef: featureId,
            },
          ],
        }
      })
      expect(
        batch.results.map(({ featureId, status, reason, criterionBranch, rawReplyRef, tests }) => ({
          featureId,
          status,
          reason,
          criterionBranch,
          rawReplyRef,
          tests: tests.map(({ id, status, reason, rawReplyRef }) => ({ id, status, reason, rawReplyRef })),
        })),
      ).toEqual(expected)
      expect(instances).toBe(scenario.ids.length + 1)
    },
  )
}

// @failure A non-native engine's ordinary silent queries lose their controlled negatives merely because a native host recipe exists.
// @level l1
// @consumer Production collectBatch with the six real xterm.js host-recipe registry rows
test.runIf(OWNED_LAYOUT)("keeps non-native host-recipe queries on the measured reply path", async () => {
  const ids = [
    "device.xtwinops-14",
    "extensions.osc10-fg-color",
    "extensions.osc11-bg-color",
    "extensions.osc12-cursor-color",
    "extensions.osc4-palette",
    "extensions.osc52-read",
    "extensions.osc104-reset-palette",
  ]
  const definitions = ids.map((id) => {
    const probe = ALL_PROBES.find((entry) => entry.id === id)
    if (!probe) throw new Error(`Missing registry probe ${id}`)
    return probe
  })
  const measured = await backend()
  measured.init({ cols: 80, rows: 24 })
  const identity = await headlessIdentity.headlessRuntimeIdentity("xtermjs", "@termless/xtermjs", "js")
  identity.adapterSources = headlessIdentity.readAdapterSources("xtermjs", measured)
  measured.destroy()
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "non-native-host-route-fixture",
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "xtermjs" },
    manifest: {
      schemaVersion: 4,
      probeHash: "non-native-host-route-fixture",
      adapterVersion: "fixture",
      catalogIds: ids,
      probes: { term: [], mux: [], lib: ids },
    },
  })
  const batch = await collectBatch(backend, "xtermjs", definitions, draft, undefined, {
    identity,
    adapterPackage: "@termless/xtermjs",
    adapterType: "js",
    adapterPath: fileURLToPath(import.meta.resolve("@termless/xtermjs")),
  })
  expect(batch.results.map(({ featureId, status }) => ({ featureId, status }))).toEqual(
    ids.map((featureId) => ({
      featureId,
      status: featureId === "extensions.osc104-reset-palette" ? "supported" : "unsupported",
    })),
  )
  const manifest = {
    schemaVersion: 4 as const,
    probeHash: "non-native-host-route-fixture",
    adapterVersion: "fixture",
    catalogIds: ids,
    probes: { term: [], mux: [], lib: ids },
  }
  const captured = {
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
  expect(
    parseRun(
      "non-native-host-route.capture.json",
      JSON.stringify(captured),
      ids,
      new Map([[manifest.probeHash, manifest]]),
    ).results,
  ).toEqual(batch.results)
})

// @failure A real engine's answered CPR path is ignored because no hash declaration qualifies its silent query.
// @level l1
// @consumer Existing device.secondary-da probe through the production headless collector
test.skipIf(!OWNED_LAYOUT || !isGhosttyNativeAvailable()).each([
  ["healthy", "unsupported"],
  ["missing", "probe-todo"],
  ["wrong-coordinate", "probe-todo"],
  ["disagree", "probe-invalid"],
  ["late", "probe-todo"],
] as const)("qualifies a real Ghostty-native silent query with %s controls", async (fault, expected) => {
  const measured = createGhosttyNativeBackend()
  measured.init({ cols: 80, rows: 24 })
  const identity = await headlessIdentity.headlessRuntimeIdentity(
    "ghostty-native",
    "@termless/ghostty-native",
    "native",
  )
  identity.adapterSources = headlessIdentity.readAdapterSources("ghostty-native", measured)
  measured.destroy()
  const id = "device.secondary-da"
  const draft = initializeRunDraft({
    source: { kind: "live" },
    runId: "silent-reply-native-fixture",
    sourceRevision: "a".repeat(40),
    intendedSubject: { kind: "lib", id: "ghostty-native" },
    manifest: {
      schemaVersion: 4,
      probeHash: "silent-reply-native-fixture",
      adapterVersion: "fixture",
      catalogIds: [id],
      probes: { term: [], mux: [], lib: [id] },
    },
  })
  let instance = 0
  const cleanups: ReturnType<typeof vi.spyOn>[] = []
  const batch = await collectBatch(
    async () => {
      const value = createGhosttyNativeBackend()
      const index = instance++
      const feed = value.feed.bind(value)
      cleanups.push(vi.spyOn(value, "destroy"))
      // Fault injection changes the transport to a real engine; it supplies no fabricated replies.
      value.feed = (bytes) => {
        const text = new TextDecoder().decode(bytes)
        if (fault === "missing" && index === 0 && text.includes("\x1b[6n")) return
        if (fault === "wrong-coordinate" && index >= 2 && text.includes("\x1b[6n")) {
          feed(new TextEncoder().encode(text.replace(/;([0-9]+)H/, (_, col) => `;${Number(col) + 1}H`)))
          return
        }
        if (fault === "disagree" && index === 2 && text === "\x1b[>c") {
          feed(new TextEncoder().encode("\x1b[5n"))
          return
        }
        feed(bytes)
        if (fault === "late" && index === 3 && text === "\x1b[>c") {
          setTimeout(() => feed(new TextEncoder().encode("\x1b[5n")), 0)
        }
      }
      return value
    },
    "ghostty-native",
    registryDefinitions(["device.secondary-da"]),
    draft,
    undefined,
    {
      adapterPackage: "@termless/ghostty-native",
      adapterPath: fileURLToPath(import.meta.resolve("@termless/ghostty-native")),
      adapterType: "native",
      identity,
    },
  )
  expect(batch.results).toHaveLength(1)
  expect(batch.results[0]).toMatchObject({ featureId: "device.secondary-da", status: expected })
  if (fault === "healthy") {
    // A no-wait repeat must not describe the configured third-pass window as elapsed evidence.
    const repeats = JSON.parse(batch.rawReplies["collector.repeatPasses"] ?? "") as {
      secondAssertions: { observed: string }[]
      thirdAssertions: { observed: string }[]
    }
    expect(repeats.secondAssertions.map((assertion: { observed: string }) => assertion.observed)).toEqual([
      expect.stringContaining("no grace wait"),
    ])
    expect(repeats.thirdAssertions.map((assertion: { observed: string }) => assertion.observed)).toEqual([
      expect.stringContaining(" ms window"),
    ])
  }
  for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledTimes(1)
})

// Required legacy encodeKey can be host-backed; mouse/paste binding checks do not qualify key bytes.
test("exposes key input only for a declared library encoder and preserves binding failures", async () => {
  const value = await createXtermBackend()
  value.init({ cols: 80, rows: 24 })
  const bytes = new Uint8Array([1])
  const encode = vi.spyOn(value, "encodeKey").mockReturnValue(bytes)
  try {
    value.capabilities.extensions.delete("key-encoding")
    expect(createLibProbeSource(value, undefined, undefined, undefined).encodeKey).toBeUndefined()
    expect(encode).not.toHaveBeenCalled()

    value.capabilities.extensions.add("key-encoding")
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    expect(source.encodeKey).toBeTypeOf("function")
    expect(source.encodeKey!({ key: "a", ctrl: true })).toBe(bytes)
    expect(encode).toHaveBeenCalledWith({ key: "a", ctrl: true })
    expect(encode.mock.contexts[0]).toBe(value)

    const broken = Object.assign(Object.create(Object.getPrototypeOf(value)), value, { encodeKey: undefined })
    expect(() => createLibProbeSource(broken, undefined, undefined, undefined)).toThrow(
      /declares capability extension "key-encoding" without an encodeKey function/,
    )
    encode.mockImplementation(() => {
      throw new Error("native key capture failed")
    })
    expect(() => source.encodeKey!({ key: "a" })).toThrow("native key capture failed")
  } finally {
    encode.mockRestore()
    value.destroy()
  }
})

// Declared absences must use adapter names, not package names. Callback fixtures with hand-written
// backendName values missed xtermjs's actual factory name "xterm" and left its declared cells TODO.
test("key-encoder absence declarations cover every actual adapter factory name", () => {
  const definitions = registryDefinitions(["input.modify-other-keys", "input.modify-other-keys-3", "input.xtest-key"])
  for (const create of [
    createAlacrittyBackend,
    createVt100Backend,
    createVt220Backend,
    createVt100RustBackend,
    createVtermBackend,
    createXtermBackend,
  ]) {
    const actual = create()
    try {
      // #32308 (@cto e4f1c5bd): the absence map runs first, so a later declaration here would be silently shadowed.
      expect(actual.capabilities.extensions.has("key-encoding"), actual.name).toBe(false)
      for (const definition of definitions) {
        const result = definition.lib!({ kind: "live", backendName: actual.name } as LibProbeSource)
        expect(result.tests?.[0], `${actual.name} ${definition.id}`).toMatchObject({
          id: "declared-untestable",
          status: "untestable",
        })
      }
    } finally {
      actual.destroy()
    }
  }
})

// #32308: callback fixtures cannot show the real libvterm encoder reaches input.xtest-key through the collector.
test("libvterm input.xtest-key is graded through its native key encoder", async () => {
  const batch = await collectBatch(resolveLibvterm, "libvterm", registryDefinitions(["input.xtest-key"]))
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.results.map(({ featureId, status }) => ({ featureId, status }))).toEqual([
    { featureId: "input.xtest-key", status: "supported" },
  ])
  expect(JSON.parse(batch.rawReplies["input.xtest-key"]!)).toEqual({
    control: "a",
    controlBytes: [97],
    report: "\x01",
    reportBytes: [1],
  })
})

test("xterm key-encoder absence survives actual adapter collection", async () => {
  const ids = ["input.modify-other-keys", "input.modify-other-keys-3", "input.xtest-key"]
  const batch = await collectBatch(backend, "xtermjs", registryDefinitions(ids))
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.results.map(({ featureId, status }) => ({ featureId, status }))).toEqual(
    ids.map((featureId) => ({ featureId, status: "untestable" })),
  )
  expect(batch.observations).toEqual([])
  expect(batch.assertions).toEqual([])
})

// The collector must retain the measured library cell result through its final checkpoint.
// Callback-only tests cannot catch losing that result between execution and checkpoint delivery.
test.each([
  { name: "xtermjs", create: backend, expected: "supported" },
  { name: "vterm", create: async () => createVtermBackend(), expected: "supported" },
] as const)("records $name SGR cell criterion before checkpoint", async ({ name, create, expected }) => {
  const definition = registryDefinitions(["sgr.bold"])[0]!
  const draft = {
    runId: "library-cell-criterion-fixture",
    rawReplies: {},
    results: [
      { featureId: definition.id, status: "probe-todo" as const, attempt: { scope: "none" as const }, tests: [] },
    ],
  }
  const checkpoints: string[] = []
  const batch = await collectBatch(create, name, [definition], draft, (value) => {
    checkpoints.push(value.results[0]!.status)
  })
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.results[0]!.status).toBe(expected)
  expect(draft.results[0]!.status).toBe(expected)
  expect(checkpoints.at(-1)).toBe(expected)
  expect(batch.observations[0]).toMatchObject({
    featureId: definition.id,
    outcome: "supported",
    assertionType: "buffer_state",
  })
})

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
    { status: "probe-todo", tests: [{ id: "criterion", reason: "adapter binding xterm syncOutput" }] },
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
    reflowSetting?: { enabled: boolean }
    phases: Array<{ outcome: string }>
    historyPhases: Array<{ id: string; status: string; outcome: string; reason: string }>
    alternatePhases: Array<{ id: string; status: string; outcome: string; reason: string }>
    alternateRoundtrips: Record<
      string,
      { roundtrip: { pass: boolean; response: string; note?: string }; identity: Record<string, boolean | null> }
    >
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
test.each([
  { declared: false, enabled: true },
  { declared: true, enabled: false },
  { declared: false, enabled: undefined },
  { declared: true, enabled: undefined },
])(
  "production reflow controls ignore the capability declaration ($declared, setting $enabled)",
  async ({ declared, enabled }) => {
    const definition = registryDefinitions(["extensions.reflow"])[0]!
    const batch = await collectBatch(
      async () => {
        const value = createXtermBackend()
        // The reported instance setting and declared support are independent evidence.
        if (enabled !== undefined) {
          Object.defineProperty(value, "getReflowState", {
            value() {
              expect(this).toBe(value)
              return { enabled }
            },
          })
        }
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
    expect(
      batch.assertions.filter(({ expected }) => expected.startsWith("alternate-")).map(({ kind }) => kind),
    ).toEqual(["negative", "negative"])
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
    if (enabled === undefined) expect(observed).not.toHaveProperty("reflowSetting")
    else expect(observed.reflowSetting).toEqual({ enabled })
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
  },
)

// @failure A genuine non-reflowing engine truncates on shrink and is mislabeled as a broken probe.
// @level l1
// @consumer Real collector phase rows and the required-test fold; xterm-only cases miss this negative.
// CTO F4d: a measured main negative cannot skip missing history; the old placeholders hid that precedence.
test.each([
  ["vt100", resolveVt100],
  ["libvterm", resolveLibvterm],
] as const)("reflow retains measured engine limits on %s without failing the feature", async (name, producer) => {
  const batch = await collectBatch(producer, name, registryDefinitions(["extensions.reflow"]))
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.results).toMatchObject([
    {
      featureId: "extensions.reflow",
      status: "unsupported",
      reason: expect.stringContaining("main-grow"),
      tests: expect.arrayContaining([
        // The combined libvterm artifact enables native main reflow while
        // retained physical history still supplies a measured negative.
        expect.objectContaining({ id: "main-grow", status: name === "libvterm" ? "supported" : "unsupported" }),
        expect.objectContaining({ id: "main-shrink", status: name === "libvterm" ? "supported" : "unsupported" }),
        ...["history-grow", "history-shrink"].map((id) =>
          expect.objectContaining({
            id,
            status: "unsupported",
          }),
        ),
      ]),
    },
  ])
  expect(batch.results[0]!.reason).toContain("main-shrink")
  expect(reflowEvidence(batch)).toMatchObject({
    phases:
      name === "libvterm"
        ? [{ outcome: "reflow" }, { outcome: "reflow" }]
        : [{ outcome: "preserved-wraps" }, { outcome: "truncated" }],
  })
  expect(
    batch.assertions.filter((assertion) => assertion.expected.startsWith("main-")).map((assertion) => assertion.kind),
  ).toEqual(name === "libvterm" ? ["positive", "positive"] : ["negative", "negative"])
  const history = reflowEvidence(batch).historyPhases
  if (name === "libvterm") {
    expect(history).toMatchObject([
      { outcome: "preserved-wraps", status: "unsupported" },
      { outcome: "truncated", status: "unsupported" },
    ])
    expect(mainAndHistoryAssertions(batch)).toHaveLength(4)
    expect(reflowEvidence(batch).reflowSetting).toEqual({ enabled: true })
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
  expect(batch.results[0]!.status).toBe(corrupt ? "probe-invalid" : "probe-todo")
  expect(mainAndHistoryAssertions(batch)).toHaveLength(2)
  expect(reflowEvidence(batch).historyPhases).toMatchObject(
    corrupt
      ? [
          { status: "probe-invalid", reason: expect.stringContaining("does not match the fed tail") },
          { status: "probe-invalid", reason: expect.stringContaining("does not match the fed tail") },
        ]
      : [
          { status: "probe-todo", reason: `target not fully retained (H=${limit}, need 28)` },
          { status: "probe-todo", reason: `target not fully retained (H=${limit}, need 27)` },
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
    expect(batch.results[0]!.status).toBe(fault === "viewport" ? "supported" : "probe-invalid")
    const observed = reflowEvidence(batch)
    expect(observed.historyPhases.map((phase: { status: string }) => phase.status)).toEqual(
      fault === "viewport" ? ["supported", "supported"] : ["probe-invalid", "probe-invalid"],
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

// @failure Cursor placement across resize vetoes a sound alternate reflow measurement or triggers a reference replay.
// @level l1
// @consumer Registered reflow callback through the real headless source and canonical batch projection.
// Existing layout controls lack independently reflowed and unadjusted saved cursors; ordinary 1049 defect controls live in modes-observations.
test.each(["reflowed", "unadjusted", "stayed-alternate"] as const)(
  "alternate reflow leaves resize cursor placement ungraded (%s)",
  async (scenario) => {
    const definition = registryDefinitions(["extensions.reflow"])[0]!
    let referenceReplayed = false
    const batch = await collectBatch(backend, "xtermjs", [
      {
        ...definition,
        lib(ctx: LibProbeSource) {
          const feed = ctx.feed
          const resize = ctx.resize!
          const reset = ctx.reset
          const cursor = ctx.getCursor
          const mode = ctx.getMode
          let columns = ctx.cols
          let alternateShrank = false
          let restored = false
          let primaryParked = false
          let referenceResized = false
          ctx.feed = (text) => {
            feed(text)
            if (text === "\x1b[5;7H") primaryParked = mode("altScreen") === false
            if (text === "\x1b[?1049h") primaryParked = false
            if (text === "\x1b[?1049l" && alternateShrank) restored = true
          }
          ctx.resize = (cols, rows) => {
            const alternate = mode("altScreen") === true
            resize(cols, rows)
            if (columns === 20 && cols === 12) {
              if (alternate) alternateShrank = true
              else if (primaryParked) referenceReplayed = referenceResized = true
            }
            columns = cols
          }
          ctx.reset = () => {
            reset()
            alternateShrank = restored = primaryParked = referenceResized = false
          }
          ctx.getMode = (name) =>
            name === "altScreen" && restored && scenario === "stayed-alternate" ? true : mode(name)
          ctx.getCursor = () => {
            if (referenceResized) return { ...cursor(), x: 6, y: 3 }
            return restored ? { ...cursor(), x: scenario === "unadjusted" ? 6 : 2, y: 4 } : cursor()
          }
          return definition.lib!(ctx)
        },
      },
    ])
    expect(batch.ungradedDiagnostics).toEqual({})
    const observed = reflowEvidence(batch)
    const phase = observed.alternatePhases.find(({ id }) => id === "alternate-shrink")!
    const roundtrip = observed.alternateRoundtrips["alternate-shrink"]
    if (!roundtrip) throw new Error("Missing alternate-shrink roundtrip evidence")
    if (scenario === "stayed-alternate") {
      expect(phase.status).toBe("probe-invalid")
      expect(roundtrip.identity).toMatchObject({ restored: true, after: true })
    } else {
      expect(phase).toMatchObject({ status: "unsupported", outcome: "truncated" })
      expect(roundtrip.roundtrip.pass).toBe(true)
    }
    expect(JSON.parse(roundtrip.roundtrip.response)).toMatchObject({
      before: { x: 6, y: 4 },
      after: { x: scenario === "unadjusted" ? 6 : 2, y: 4 },
    })
    expect(JSON.parse(roundtrip.roundtrip.response)).not.toHaveProperty("reference")
    expect(referenceReplayed).toBe(false)
  },
)

// @failure Qualified alternate positives are omitted, or their polarity is folded against another buffer.
// @level l1
// @consumer Actual vterm alternate resize/readback; the xterm case above supplies complete physical negatives.
// CTO F4b: main positive/history negative is an engine limit, not a cross-buffer failure or perpetual TODO.
// Real collector grace and layout reads measured 4.15 s focused and exceeded 5 s under fleet load.
test("alternate reflow records real vterm logical layouts without deciding a probe result from another buffer", async () => {
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
}, 10_000)

// @failure An unqualified alternate buffer or corrupt target/control becomes a reflow assertion.
// @level l1
// @consumer Alternate-only raw evidence through the registered callback and production source.
// Existing main/history tests never enter alternate; mode tests never resize its target.
// CTO F4e: invalid alternate evidence remains reported but cannot veto four qualified measured phases.
// Prior aggregate TODO assertions could not detect an accidental alternate-failure fold.
// F2/F3: require the deciding reason; setup failures must stay invalid even when mode identity
// is false or unavailable. Status-only cases miss a removed identity check or the wrong failing control.
test.each([
  { fault: "missing-mode", status: "probe-todo", reason: "alternate buffer identity unavailable" },
  { fault: "target-mode-missing", status: "probe-todo", reason: "alternate buffer identity unavailable" },
  { fault: "no-entry", status: "probe-todo", reason: "alternate buffer not entered" },
  {
    fault: "bogus-mode",
    status: "probe-invalid",
    reason: expect.stringContaining("did not clear the seeded primary spans"),
  },
  {
    fault: "hard-row",
    status: "probe-invalid",
    reason: "Alternate resize matched neither complete layout, including hard rows and blank tails",
  },
  {
    fault: "blank-tail",
    status: "probe-invalid",
    reason: "Alternate resize matched neither complete layout, including hard rows and blank tails",
  },
  {
    fault: "control-switch",
    status: "probe-invalid",
    reason: "Post-resize alternate width control did not wrap at the requested column",
  },
  {
    fault: "control-identity",
    status: "probe-invalid",
    reason: "Alternate buffer identity changed during target or width-control readback",
  },
  { fault: "slot-read", status: "probe-invalid", reason: "Alternate measurement failed: alternate slot read failed" },
  { fault: "restore", status: "probe-invalid", reason: expect.stringContaining("PRIMARY-A not restored") },
  {
    fault: "marker-missing-false",
    status: "probe-invalid",
    reason: "Alternate isolation did not qualify: Alternate marker was not measured",
  },
  {
    fault: "marker-readback-false",
    status: "probe-invalid",
    reason: "Alternate isolation did not qualify: Alternate-marker readback failed",
  },
  {
    fault: "marker-missing-null",
    status: "probe-invalid",
    reason: "Alternate isolation did not qualify: Alternate marker was not measured",
  },
  {
    fault: "marker-readback-null",
    status: "probe-invalid",
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
    expect(batch.results[0]!.status).toBe("probe-invalid")
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
        expect.objectContaining({ id: "criterion", status: "probe-invalid", assertionRefs: [0, 1] }),
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
      expect(missing.tests).toMatchObject([{ id: "review", status: "probe-todo" }])
      expect(missing.observation).toBeUndefined()
      expect(missing.assertions).toBeUndefined()
      expect(feed).not.toHaveBeenCalled()
    } finally {
      value.destroy()
    }
  },
)

// @failure #32053: an engine declaring osc-metadata for notifications only (kitty) has no cwd reader; the OSC 7
// criterion must read that as missing adapter evidence, never as a claim about the library's public interface.
// @level l1
// @consumer extensions.osc7-cwd through the actual LibProbeSource
test("an osc-metadata engine without getCwd leaves the OSC 7 criterion a probe-todo, never unsupported", async (context) => {
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
    expect(cwd.tests).toMatchObject([{ id: "review", status: "probe-todo" }])
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

// @failure A generic tap payload is graded Supported without an engine declaration, or payload forwarding is lost.
// @level l1
// @consumer extensions.osc777-notify through the real vterm and xterm adapters and existing source forwarding.
test.each([
  ["vterm", createVtermBackend],
  ["xterm", createXtermBackend],
] as const)("%s OSC777 tap keeps payloads but cannot decide support without an engine declaration", (_name, create) => {
  const value = create({ cols: 80, rows: 24 })
  try {
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    source.feed("\x1b]777;preexec\x07")
    const definition = registryDefinitions(["extensions.osc777-notify"])[0]!
    const result = definition.lib!(source)
    expect(result.notTested?.noObservable).toContain("engine identity")
    expect(result.observation).toBeUndefined()
    source.feed("\x1b]777;terminfo-777-control\x07")
    source.feed("\x1b]777;notify;terminfo-777-title-A;terminfo-777-body-A\x07")
    source.feed("\x1b]777;notify;terminfo-777-title-B;terminfo-777-body-B\x07")
    const expected = [
      "preexec",
      "terminfo-777-control",
      "notify;terminfo-777-title-A;terminfo-777-body-A",
      "notify;terminfo-777-title-B;terminfo-777-body-B",
    ]
    expect(source.getOsc777Payloads!()).toEqual(expected)
  } finally {
    value.destroy()
  }
})

// @failure #32053: Kitty receives every OSC 777 payload but its binding dropped them, so OSC 777 notify stayed a
// grid-only probe-todo; a stale or inert reader stays PROBE TODO, and an absent reader keeps the old route.
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

    // A stale or inert reader records no control, so it stays PROBE TODO, never Unsupported (@cto cd6b67d9).
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

// Standalone component CI checks out terminfo.dev alone and resolves the published @termless 0.10.2, whose Kitty and
// Ghostty native backends predate osc-metadata getProgress (#32271); CI run 41794400168 failed both rows there. Every
// row runs in both homes: OWNED_LAYOUT picks the owned Termless contract (reader declared and tested) or the published
// one (no reader, PROBE TODO), so a broken owned reader still fails.
// @failure #32053, #32272: engine stores parsed toasts only; OSC 9 and 777;notify;X arrive identical. WezTerm
// (performer.rs:904-933) and Ghostty (osc.zig:94-98) keep {title, body} toasts, so no raw reader can attribute the
// code or rebuild the payload (@cto 94631c52, 91f6fd75). The owned Termless exposes that store as getToasts, tested by
// single-sequence deltas with a cross control (@cto 3cc4a3ae); the published 0.10.2 has no reader, so its cells stay
// PROBE TODO, never Unsupported. The owned ghostty-web WASM keeps the same toasts as the native engine (@cto c65d2a67).
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

// The OSC 9 title each engine stores: Ghostty builds "" (osc9.zig:279-281), WezTerm reports none (performer.rs:904-911).
test.for([
  ["wezterm", weztermNativeAvailable(), OWNED_LAYOUT, null, async () => createWeztermBackend()],
  ["ghostty-native", isGhosttyNativeAvailable(), OWNED_LAYOUT, "", async () => createGhosttyNativeBackend()],
  ["ghostty wasm", true, OWNED_LAYOUT, "", () => resolveGhosttyWasm()],
] as const)(
  "%s parsed-toast engine records OSC 9 and OSC 777 probe results only through its toast reader",
  async ([name, available, reader, osc9Title, create], context) => {
    if (!available) context.skip(`${name} native addon unavailable (NOT MEASURED)`)
    const value = await create()
    value.init({ cols: 80, rows: 24 })
    try {
      expect(hasExtension(value, "osc-metadata")).toBe(reader)
      const source = createLibProbeSource(value, undefined, undefined, undefined)
      expect(source.getNotifications).toBeUndefined()
      expect(source.getOsc777Payloads).toBeUndefined()
      const [notifications, osc777] = registryDefinitions(["extensions.notifications", "extensions.osc777-notify"]).map(
        (definition) => definition.lib!(source),
      )
      if (reader) {
        for (const result of [notifications!, osc777!]) {
          expect(result.notTested).toBeUndefined()
          expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
        }
        // Each step's added toasts are the engine's own fields: the OSC 9 title is recorded verbatim, never used to decide the probe result.
        expect(JSON.parse(notifications!.response!)).toMatchObject({
          noToast: { added: [] },
          cross: { added: [{ title: "terminfo-9-cross-title", body: "terminfo-9-cross-body" }] },
          graded: { added: [{ title: osc9Title, body: "terminfo-9-toast" }] },
        })
        expect(JSON.parse(osc777!.response!)).toMatchObject({
          noToast: { added: [] },
          cross: { added: [{ title: osc9Title, body: "terminfo-777-cross-body" }] },
          graded: { added: [{ title: "terminfo-777-toast-title", body: "terminfo-777-toast-body" }] },
        })
        return
      }
      expect(source.getToasts).toBeUndefined()
      expect(notifications!.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
      expect(notifications!.tests).toMatchObject([{ id: "review", status: "probe-todo" }])
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
// criterion stayed grid-only. WezTerm exposes current state only: initial/clear/pause all read state0/null
// (CTO f7cf72f9); the callback must qualify transitions and restore incoming progress. The owned ghostty-web WASM
// stores the last report like the native engine (@cto c65d2a67); the published 0.10.2 has no reader.
// @level l1
// @consumer extensions.osc9-progress through the actual LibProbeSource
test.for([
  ["kitty", isKittyAvailable(), OWNED_LAYOUT, async () => createKittyBackend()],
  ["ghostty-native", isGhosttyNativeAvailable(), OWNED_LAYOUT, async () => createGhosttyNativeBackend()],
  ["wezterm", weztermNativeAvailable(), OWNED_LAYOUT, async () => createWeztermBackend()],
  ["ghostty wasm", true, OWNED_LAYOUT, () => resolveGhosttyWasm()],
] as const)(
  "%s OSC 9;4 progress probe results are decided through the stored-report reader only where the engine stores one",
  async ([name, available, reader, create], context) => {
    if (!available) context.skip(`${name} engine unavailable (NOT MEASURED)`)
    const configDirectory = name === "kitty" ? mkdtempSync(join(tmpdir(), "terminfo-kitty-config-")) : undefined
    if (configDirectory) vi.stubEnv("KITTY_CONFIG_DIRECTORY", configDirectory)
    const value = await create()
    value.init({ cols: 80, rows: 24 })
    try {
      const source = createLibProbeSource(value, undefined, undefined, undefined)
      // Existing default-state tests missed stale controls and destruction of incoming progress.
      if (reader) source.feed("\x1b]9;4;1;37\x07")
      const result = registryDefinitions(["extensions.osc9-progress"])[0]!.lib!(source)
      if (reader) {
        expect(result.notTested).toBeUndefined()
        expect(result.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
        // Probe cleanup restores the incoming report, including a value matching its first control.
        expect(source.getProgress!()).toEqual({ state: 1, value: 37 })
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

// @failure The native WezTerm mouse bridge is not reached by the registered callbacks, or an unbound path is graded.
// @level l5
// @consumer Real native WezTerm through the production collector's per-probe backend/source boundary.
test.runIf(OWNED_LAYOUT)("WezTerm native mouse callbacks decide six cells and retain one unbound path", () => {
  for (const [id, outcome] of [
    ["input.xtest-click", "supported"],
    ["input.xtest-wheel", "supported"],
    ["input.button-event-mouse", "supported"],
    ["input.x10-mouse", "unsupported"],
    ["input.urxvt-mouse", "unsupported"],
    ["input.pixel-mouse", null],
    ["input.kitty-click-events", "unsupported"],
  ] as const) {
    // collectBatch likewise constructs and initializes one fresh backend inside its per-probe loop.
    const value = createWeztermBackend({ cols: 80, rows: 24 })
    try {
      const result = registryDefinitions([id])[0]!.lib!(createLibProbeSource(value, undefined, undefined, undefined))
      if (outcome === null) {
        expect(result.notTested, id).toBeDefined()
        expect(result.observation, id).toBeUndefined()
      } else {
        expect(result.observation, id).toMatchObject({ outcome, assertionType: "input_bytes" })
      }
    } finally {
      value.destroy()
    }
  }
})

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
// Real native readback exceeded the 5 s default in a whole run (5.21 s); preserve every lifecycle check.
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
  10_000,
)

// @failure A native semantic reader loses fresh positioned starts or accepts cached/wrong raw status as a new D event.
// @level l1
// @consumer Registered OSC133D and start callbacks through the actual Kitty collector source.
// Existing private callback tests cannot observe the public reader binding or the deciding callback route.
// Native Kitty I/O can exceed Vitest's 5-second default under fleet load; use the native sibling's budget.
test.skipIf(!isKittyAvailable())(
  "Kitty semantic readers witness fresh starts and raw command-end statuses",
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
      for (const [id, type] of [
        ["extensions.osc133-a", "prompt"],
        ["extensions.osc133-c", "output"],
      ] as const) {
        const start = registryDefinitions([id])[0]!.lib!(source)
        expect(start.observation, id).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
        const marks = JSON.parse(start.response!) as { first: unknown[]; second: unknown[] }
        expect(marks.first.at(-1), id).toEqual({ type, startRow: 0, startCol: 0 })
        expect(marks.second.at(-1), id).toEqual({ type, startRow: 1, startCol: 2 })
      }
      const umbrella = registryDefinitions(["extensions.semantic-prompts"])[0]!.lib!(source)
      expect(umbrella.observation).toMatchObject({ outcome: "supported", assertionType: "buffer_state" })
      const lifecycle = JSON.parse(umbrella.response!) as {
        prompt: unknown[]
        output: unknown[]
        end: unknown[]
        unknown: unknown[]
      }
      expect(lifecycle.prompt.at(-1)).toEqual({ type: "prompt", startRow: 0, startCol: 0 })
      expect(lifecycle.output.at(-1)).toEqual({ type: "output", startRow: 1, startCol: 2 })
      expect(lifecycle.end.at(-1)).toEqual({ type: "command-end", rawStatus: "17" })
      expect(lifecycle.unknown).toEqual(lifecycle.end)
      if (OWNED_LAYOUT) {
        expect(registryDefinitions(["extensions.osc-633-vscode"])[0]!.lib!(source).observation).toMatchObject({
          outcome: "unsupported",
        })
      } else {
        expect(registryDefinitions(["extensions.osc-633-vscode"])[0]!.lib!(source).tests).toEqual([
          {
            id: "criterion",
            status: "probe-todo",
            reason:
              "Open: our test saw only some of the shell cycle's steps (prompt start, command start, output start, command end with exit status), so it cannot judge the whole cycle yet.",
          },
        ])
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
      expect(undeclared.getSemanticMarks).toBeTypeOf("function")
      expect(definition.lib!(undeclared).criterionBranch).toBe(SEMANTIC_PROMPT_SOURCE_REVIEW)
      value.capabilities.extensions.delete("semantic-marks")
      const noReaders = createLibProbeSource(value, undefined, undefined, undefined)
      expect(noReaders.getSemanticMarks).toBeUndefined()
      expect(definition.lib!(noReaders).criterionBranch).toBe(SEMANTIC_PROMPT_SOURCE_REVIEW)
      value.capabilities.extensions.add("semantic-marks")
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
  20_000,
)

// @failure A registered semantic callback decides a probe result from consumption or cached records instead of new typed, positioned marks.
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
      expect(missing.tests).toMatchObject([{ id: "review", status: "probe-todo" }])
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
test("real vterm Sixel storage sharpens the TODO reason without deciding a rendering probe result", () => {
  const value = createVtermBackend({ cols: 80, rows: 24 })
  try {
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    const definition = registryDefinitions(["extensions.sixel"])[0]!
    const result = definition.lib!(source)
    expect(result.note).toBe(
      "Open: our test cannot check the image, for two reasons. The library stores the image data at the right screen position, but drawing it is the app's job; and our test does not measure the character cell size needed to check the image's size.",
    )
    expect(result.criterionBranch).toBe(HEADLESS_OBSERVABLE_REVIEW)
    expect(result.tests).toMatchObject([{ status: "probe-todo" }])
    expect(result.observation).toBeUndefined()
    expect(JSON.parse(result.response!)).toMatchObject({ storage: { retained: true } })
    vi.spyOn(source, "getSixelImages").mockReturnValue([])
    const stale = definition.lib!(source)
    expect(stale.tests).toMatchObject([{ status: "probe-todo" }])
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
  "%s reads the no-setup declaration through the actual collector and parser",
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
        status: "untestable",
        tests: [{ id: "declared-untestable", status: "untestable" }],
      },
    ])
    expect(parsed.results?.[0]?.criterionBranch).toBe("headless-observable-review")
  },
)

// 31770 @cto a60bc57e N2: the unit cases in extensions-osc0-observations.test.ts call the OSC 0 callback
// directly, so the collector wrapping of its control and getter failures was never fault-injected.
// Real xterm backend, audited identity, registered callback and collectBatch on one path: a failed control
// or a throwing getter must leave PROBE INVALID with both labels restored and no support or negative claim.
test.each([
  { fault: "none" },
  { fault: "icon-control" },
  { fault: "title-control" },
  { fault: "icon-readback" },
  { fault: "title-readback" },
] as const)("audited xterm OSC 0 $fault survives the collector without a false result", async ({ fault }) => {
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
  expect(result).toMatchObject({ status: "probe-invalid" })
  expect(observation?.outcome).not.toBe("supported")
  expect(observation?.outcome).not.toBe("unsupported")
  expect(batch.assertions.filter((entry) => entry.featureId === id)).toEqual([])
  if (fault.endsWith("-control")) {
    expect(batch.ungradedDiagnostics).toEqual({})
    expect(result!.tests).toMatchObject([
      {
        status: "probe-invalid",
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
// former source review is PROBE TODO coverage, which must still survive collection and parsing.
// Canonical source validation lazily fetches historical Git blobs in CI's partial clones; this is not a speed test.
test("DECSSCLS real-vterm parser-state PROBE TODO survives collection and canonical parsing", async () => {
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
  // #32246: no source review decides DECSSCLS; the parser-state cell is PROBE TODO coverage with no negative assertion.
  expect(batch.results).toMatchObject([
    { featureId: id, status: "probe-todo", tests: [{ id: "criterion", status: "probe-todo" }] },
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
    { featureId: id, status: "probe-todo", tests: [{ id: "criterion", status: "probe-todo" }] },
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

// @failure A D/633 prompt result at the formerly audited WezTerm identity becomes a collector error, or its probe result is decided
//   from source instead of staying PROBE TODO (#32246).
// @level l1 @consumer collectBatch plus capture parser; callback tests cannot catch declaration rejection.
test("Wezterm prompt PROBE TODO rows survive actual collection and capture binding", async () => {
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
    // The mocked historical WezTerm identity has no cwd reader.
    delete (value as Partial<OscMetadataExtension>).getCwd
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
  // #32246: the formerly audited WezTerm identity decides no prompt-mark result from source; each stays PROBE TODO, untyped.
  for (const id of ids) {
    const row = captured.results.find((entry) => entry.featureId === id)!
    expect(row).toMatchObject({ featureId: id, status: "probe-todo" })
    expect(row.criterionBranch).not.toBe("source-negative-review")
    // osc633-d/-p report their reader route as an inconclusive observation (#32247); still PROBE TODO, never a terminal support claim.
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
    parsed.results?.every((row) => row.criterionBranch !== "source-negative-review" && row.status === "probe-todo"),
  ).toBe(true)
})

// #32099: callback-only tests miss a result rejected by an inherited query_reply declaration. Real engines must take
// different branches through the same definitions, including xterm's actual mode2031 Ps0 negative; since #32246 the
// vterm engines' former source reviews are untyped PROBE TODO rows that must still survive collection and parsing.
test("measured mode and mouse criteria survive collection and capture parsing", async () => {
  const ids = ["modes.synchronized-output", "modes.color-scheme-reporting", "input.pixel-mouse"]
  for (const [name, producer] of [
    ["vt100", resolveVt100],
    ["vt220", resolveVt220],
    ["xtermjs", backend],
  ] as const) {
    if (name !== "xtermjs" && !OWNED_LAYOUT) continue
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
          ? { status: "unsupported", assertionType: "buffer_state" }
          : {
              status: id === "modes.color-scheme-reporting" ? "unsupported" : "supported",
              assertionType: id === "input.pixel-mouse" ? "input_bytes" : "query_reply",
            },
      )
      // DEC1: historical source metadata cannot select the current measured report criterion.
      if (name !== "xtermjs") {
        const row = captured.results.find((entry) => entry.featureId === id)!
        expect(row, id).not.toHaveProperty("criterionBranch")
        expect(row, id).toHaveProperty("assertionType", "buffer_state")
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
                setReply: (id === "modes.synchronized-output" ? "\x1b[?2026;1$y" : "\x1b[?2031;0$y") + "\x1b[?1;2c",
              },
        )
      } else if (id === "input.pixel-mouse") {
        expect(JSON.parse(batch.rawReplies[id]!), id).toMatchObject({
          unhandled: { target: { kind: "csi", code: "?1016h" } },
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
          ? { status: "unsupported", assertionType: "buffer_state" }
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
test("retains registered reply failure evidence when the path control is silent", async () => {
  const id = "device.dsr-996-color-scheme"
  const definition = ALL_PROBES.find((entry) => entry.id === id)!
  let initial = true
  const factory = async () => {
    const value = await backend()
    if (initial) {
      initial = false
      vi.spyOn(value, "feed").mockImplementationOnce(() => {})
    }
    return value
  }
  const batch = await collectBatch(factory, "xtermjs", [definition])
  expect(JSON.parse(batch.rawReplies["collector.replyPath"]!)).toMatchObject({
    decisions: {
      [id]: {
        member: false,
        reason: "same-run CPR path control did not answer",
      },
    },
  })
  const result = batch.results[0]!
  expect(result.status).toBe("probe-invalid")
  expect(result.reason).toContain(`sent ${JSON.stringify("\x1b[?996n")}; received ""`)
  expect(result.reason).toContain("synchronous feed and getCursor boundary; timeout not applicable")
  expect(result.tests).toMatchObject([{ id: "criterion", status: "probe-invalid", rawReplyRef: id }])
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
          : { pass: false, tests: [{ id: "criterion", status: "probe-invalid", reason: "No probe reply" }] }
      },
    },
  ])
  const result = batch.results[0]!
  expect(result.status).toBe("probe-invalid")
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
  expect(batch.results).toMatchObject([{ status: "probe-invalid", reason, tests: [{ reason }] }])
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
    expect(batch.results).toMatchObject([{ status: disagree ? "probe-invalid" : "unsupported" }])
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
  expect(legacy.results).toMatchObject([{ status: "probe-invalid" }])
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
        status: "probe-todo",
        criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
        tests: [{ id: "review", status: "probe-todo", reason: declaration!.reason }],
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
  // Margin wrapping retains both calibrated controls and libvterm's observed unbounded target.
  expect.soft(JSON.parse(batch.rawReplies["modes.left-right-margin"]!)).toMatchObject({
    placement: { wrapped: "E", unbounded: " " },
    control: { wrapped: " ", unbounded: "E" },
    margins: "3-6",
    target: { wrapped: " ", unbounded: "E" },
  })
  for (const id of ["modes.altscreen-47", "modes.altscreen-1047"]) {
    expect.soft(JSON.parse(batch.rawReplies[id]!), id).toMatchObject({ seedA: "PRIMARY-A", seedB: "PRIMARY-B" })
  }
  expect(batch.results.find((row) => row.featureId === "modes.application-keypad")).toMatchObject({
    status: "probe-todo",
    reason: "Open: our libvterm adapter cannot read the application keypad mode yet.",
  })
})

// The callback criterion can name the Ps while the collector must still keep the exact transport bytes.
test.each([0, 1, 4] as const)(
  "OSC 5522 Ps %s retains detection and raw bytes through the production batch recorder",
  async (ps) => {
    const id = "extensions.osc5522-clipboard"
    const reply = `\x1b[?5522;${ps}$y`
    const response = reply + "\x1b[?1;2c"
    const value = await backend()
    const feed = value.feed.bind(value)
    vi.spyOn(value, "feed").mockImplementation((bytes) => {
      if (new TextDecoder().decode(bytes) === "\x1b[?5522$p") {
        value.onResponse?.(new TextEncoder().encode(reply))
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
  const declaredInputIds = new Set([
    "input.xtest-key",
    "extensions.clipboard-paste",
    "input.modify-other-keys",
    "input.modify-other-keys-3",
  ])
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
    if (declaredInputIds.has(result.featureId)) {
      expect(result.status, result.featureId).toBe("untestable")
      expect(result.tests, result.featureId).toContainEqual(
        expect.objectContaining({ id: "declared-untestable", status: "untestable", reason: expect.any(String) }),
      )
      continue
    }
    throw new Error(`Unclassified input fixture ${result.featureId}`)
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

// @failure A Vterm input cell at the formerly audited identity has a probe result decided from source, or its PROBE TODO coverage record
//   is lost when recorded as a real headless batch (#32246).
// @consumer The four registered Vterm input callbacks through collectBatch; no capture or attestation.
test("formerly audited Vterm input cells record PROBE TODO coverage through the collector", async () => {
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
  const vtermKeyEncoderAbsence =
    "vterm.js 0.13.1 exports createVtermScreen and its Screen byte parser and state readers, and no key-event-to-byte encoder"
  expect(batch.ungradedDiagnostics).toEqual({})
  expect(batch.results).toHaveLength(ids.length)
  expect(batch.notTested).toEqual([
    {
      featureId: "input.modify-other-keys",
      reason: "no-semantic-observable",
      noObservable: vtermKeyEncoderAbsence,
      rawReplyRef: "input.modify-other-keys",
    },
    {
      featureId: "input.modify-other-keys-3",
      reason: "no-semantic-observable",
      noObservable: vtermKeyEncoderAbsence,
      rawReplyRef: "input.modify-other-keys-3",
    },
    {
      featureId: "input.xtest-key",
      reason: "no-semantic-observable",
      noObservable: `OS-level XTEST key injection: ${vtermKeyEncoderAbsence}`,
      rawReplyRef: "input.xtest-key",
    },
    {
      featureId: "input.kitty-click-events",
      reason: "no-semantic-observable",
      noObservable: NO_SAME_PATH_CONTROL,
      rawReplyRef: "input.kitty-click-events",
    },
  ])
  for (const id of ids) {
    const row = batch.results.find((entry) => entry.featureId === id)
    if (id === "input.kitty-click-events") {
      expect(row).toMatchObject({ status: "probe-todo" })
      expect(row?.criterionBranch).toBeUndefined()
    } else {
      expect(row).toMatchObject({ status: "untestable", criterionBranch: "headless-observable-review" })
    }
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
  // #32246: the former source review of the kitty click encoder is PROBE TODO coverage with no same-path control.
  expect(kitty.results).toMatchObject([{ status: "probe-todo", reason: NO_SAME_PATH_CONTROL }])
  const id = "input.pixel-mouse"
  const reset = "\x1b[?9;1000;1002;1003;1005;1006;1015;1016l"
  const cases: { state: boolean | null; error?: string; expected: string }[] = [
    { state: null, expected: "probe-todo" },
    { state: true, expected: "unsupported" },
    {
      state: true,
      error: "mouse encoding unavailable: fixture pixel binding unavailable",
      expected: "probe-todo",
    },
    { state: true, error: "broken encoder invariant", expected: "probe-invalid" },
  ]
  for (const { state, error, expected } of cases) {
    const backend = createVtermBackend()
    const feed = vi.spyOn(backend, "feed")
    vi.spyOn(backend, "getMode").mockReturnValue(state)
    vi.spyOn(backend, "encodeMouse")
      .mockReturnValueOnce(null)
      .mockImplementation((event) => {
        if (event.action !== "press") return null
        if (!event.pixel) return new TextEncoder().encode("\x1b[<0;5;3M")
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
    { featureId: id, status: "probe-invalid", reason: expect.stringContaining("tracking reset") },
  ])
  expect(new TextDecoder().decode(feed.mock.calls.at(-1)![0])).toBe(reset)
})

// @failure Cell coordinates are falsely accepted as a pixel-coordinate witness.
// @level l1
// @consumer The production pixel library criterion with explicit cell and pixel coordinates.
test("pixel library arm never uses a cell-coordinate encoder report to decide a probe result", async () => {
  const backend = createVtermBackend()
  const encode = vi
    .spyOn(backend, "encodeMouse")
    .mockReturnValueOnce(null)
    .mockReturnValueOnce(null)
    .mockReturnValue(new TextEncoder().encode("\x1b[<0;5;3M"))
  const batch = await collectBatch(async () => backend, "vterm", registryDefinitions(["input.pixel-mouse"]))
  expect(batch.results).toMatchObject([{ status: "unsupported", assertionType: "input_bytes" }])
  expect(JSON.parse(batch.rawReplies["input.pixel-mouse"]!)).toMatchObject({
    tracking: true,
    negativeControl: null,
    report: "\x1b[<0;5;3M",
  })
  expect(encode).toHaveBeenCalledTimes(6)
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
  const withoutReport = async () => {
    const value = await resolveVt100()
    delete (value as Partial<OscMetadataExtension>).getUnhandledSequences
    return value
  }
  const batch = await collectBatch(withoutReport, "vt100", registryDefinitions(ids))
  expect(batch.results.map((row) => row.featureId)).toEqual(ids)
  for (const row of batch.results) {
    expect(row.status).toBe("probe-todo")
    expect(row.reason).toBe("Open: our vt100 adapter has no hook for sending mouse events yet.")
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

  // C3: encodeMouse method present without "mouse-encoding" in capabilities.extensions stays unwired -> PROBE TODO.
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
      status: "probe-todo",
      criterionBranch: SEMANTIC_PROMPT_SOURCE_REVIEW,
      rawReplyRef: id,
      tests: [
        expect.objectContaining({ id: "review", status: "probe-todo", attempt: { scope: "none" }, rawReplyRef: id }),
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

// The no-response probe result hid that no F4 engine can read a colour back headless (#30547, @cto D-B): a silent first
// readback must ask for review with its raw query retained, while an engine that answers keeps its measured probe result.
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

// @failure Real CSI warnings never reach registered, canonical collector decisions.
// @consumer Owned Ghostty web palette-stack, DECSACE and DECSSCLS collector; hosted resolves an older adapter.
test.runIf(OWNED_LAYOUT)("real Ghostty CSI reports decide exactly the registered cells", async () => {
  const ids = ["modes.xtpushcolors", "modes.xtpopcolors", "editing.decsace", "modes.decsscls"]
  const measured = await resolveGhosttyWasm()
  measured.init({ cols: 80, rows: 24 })
  const identity = await headlessIdentity.headlessRuntimeIdentity("ghostty", "@termless/ghostty", "wasm")
  identity.adapterSources = headlessIdentity.readAdapterSources("ghostty", measured)
  measured.destroy()
  const runtime = {
    identity,
    adapterPath: fileURLToPath(import.meta.resolve("@termless/ghostty")),
    adapterPackage: "@termless/ghostty",
    adapterType: "wasm",
  }
  const batch = await collectBatch(
    resolveGhosttyWasm,
    "ghostty",
    registryDefinitions(ids),
    undefined,
    undefined,
    runtime,
  )
  expect(
    batch.results.map(({ featureId, status }) => ({ featureId, status })),
    JSON.stringify({ identity, results: batch.results, replies: batch.rawReplies }),
  ).toEqual(ids.map((featureId) => ({ featureId, status: "unsupported" })))
  for (const [featureId, code] of [
    [ids[0]!, "#P"],
    [ids[1]!, "#Q"],
    [ids[2]!, "*2x"],
    [ids[3]!, " p"],
  ] as const) {
    expect(JSON.parse(batch.rawReplies[featureId]!)).toMatchObject({
      unhandled: {
        control: featureId.startsWith("modes.xt") ? "\x1b[?7l" : "\x1b[0m\x1b[1mC",
        target: { kind: "csi", code },
        added: [{ kind: "csi", code }],
      },
    })
  }
  // Removing only the new producer records must lose both conclusions; native effects stay real.
  const withoutCsi = async () => {
    const value = await resolveGhosttyWasm()
    if (!hasExtension<OscMetadataExtension>(value, "osc-metadata") || !value.getUnhandledSequences) {
      throw new Error("Owned Ghostty report reader missing")
    }
    const read = value.getUnhandledSequences.bind(value)
    value.getUnhandledSequences = () => read().filter(({ kind }) => kind !== "csi")
    return value
  }
  const missing = await collectBatch(withoutCsi, "ghostty", registryDefinitions(ids), undefined, undefined, runtime)
  expect(missing.results.map(({ status }) => status)).toEqual(ids.map(() => "probe-todo"))
})

// @failure Ghostty's repeated allocator/rejection reports fail to decide their scalar reset code, or shell reports are lost.
// @consumer Owned monorepo Ghostty WASM collector; published Termless does not yet expose this report reader.
test.runIf(OWNED_LAYOUT)(
  "real Ghostty web decides seven shell report cells and allocator-limited resets by their reports",
  async () => {
    const negatives = [
      "extensions.osc633-a",
      "extensions.osc633-b",
      "extensions.osc633-c",
      "extensions.osc633-d",
      "extensions.osc633-e",
      "extensions.osc133-p",
      "extensions.osc-633-vscode",
    ]
    const resets = [
      "extensions.osc113-reset-pointer-fg",
      "extensions.osc114-reset-pointer-bg",
      "extensions.osc117-reset-highlight-bg",
      "extensions.osc119-reset-highlight-fg",
    ]
    const batch = await collectBatch(resolveGhosttyWasm, "ghostty", registryDefinitions([...negatives, ...resets]))
    expect(batch.results).toHaveLength(11)
    for (const result of batch.results) {
      expect(result.status, result.featureId).toBe("unsupported")
    }
    expect(
      batch.observations
        .filter((row) => row.outcome === "unsupported")
        .map((row) => row.featureId)
        .sort(),
    ).toEqual([...negatives, ...resets].sort())
  },
)

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
    // queries remain silent and now declare no setup after their own control.
    const cellWitnessIds = engine === "xtermjs" ? ["extensions.osc104-reset-palette"] : []
    // libvterm and the owned DEC adapters report the two pointer resets as unhandled.
    // Published DEC adapters lack that reader; other silent resets keep their review and raw query.
    const unhandledReportIds =
      engine === "libvterm" || (OWNED_LAYOUT && (engine === "vt100" || engine === "vt220"))
        ? [
            "extensions.osc104-reset-palette",
            "extensions.osc110-reset-fg",
            "extensions.osc111-reset-bg",
            "extensions.osc112-reset-cursor",
            "extensions.osc113-reset-pointer-fg",
            "extensions.osc114-reset-pointer-bg",
            "extensions.osc30001-color-stack-push",
            "extensions.osc30101-color-stack-pop",
          ]
        : []
    expect(batch.observations).toEqual([
      ...cellWitnessIds.map((featureId) =>
        expect.objectContaining({ featureId, outcome: "supported", assertionType: "buffer_state" }),
      ),
      ...unhandledReportIds.map((featureId) =>
        expect.objectContaining({ featureId, outcome: "unsupported", assertionType: "buffer_state" }),
      ),
    ])
    expect(batch.assertions).toEqual([
      ...cellWitnessIds.map((featureId) =>
        expect.objectContaining({ featureId, kind: "positive", assertionType: "buffer_state" }),
      ),
      ...unhandledReportIds.map((featureId) =>
        expect.objectContaining({ featureId, kind: "negative", assertionType: "buffer_state" }),
      ),
    ])
    for (const result of batch.results) {
      if (cellWitnessIds.includes(result.featureId)) {
        expect(result.status, result.featureId).toBe("supported")
        expect(result.criterionBranch, result.featureId).toBeUndefined()
        continue
      }
      if (unhandledReportIds.includes(result.featureId)) {
        expect(result.status, result.featureId).toBe("unsupported")
        expect(result.criterionBranch, result.featureId).toBeUndefined()
        continue
      }
      const publishedDec = !OWNED_LAYOUT && (engine === "vt100" || engine === "vt220")
      const noSetup = engine === "xtermjs" || (publishedDec && result.featureId !== "extensions.osc104-reset-palette")
      expect(result.status, result.featureId).toBe(noSetup ? "untestable" : "probe-todo")
      expect(result.criterionBranch, result.featureId).toBe(
        noSetup ? "headless-observable-review" : "color-readback-review",
      )
      expect(result.rawReplyRef, result.featureId).toBe(result.featureId)
      const retained = JSON.parse(batch.rawReplies[result.featureId]!) as { body: string }
      const raw = (noSetup ? JSON.parse(retained.body) : retained) as {
        query: string
        originalRaw?: string
        initialSentinel?: unknown
        initialReadback?: unknown
      }
      expect(raw.query, result.featureId).toMatch(/^\x1b\]1?\d;/)
      if (Object.hasOwn(raw, "originalRaw")) expect(raw.originalRaw, result.featureId).toBe("")
      else {
        expect(raw.initialSentinel ?? raw.initialReadback, result.featureId).toMatchObject({
          match: null,
          reason: "sentinel",
          raw: expect.stringMatching(/^\x1b\[\?[0-9;]+c$/),
        })
      }
      const noObservableByFeature: Record<string, string> = {
        "extensions.osc104-reset-palette":
          "Open: the colour query (OSC 4) did not confirm the colour we set, leaving the reset (OSC 104) with no verified setup",
        "extensions.osc110-reset-fg":
          "Open: the colour query (OSC 10) did not confirm the colour we set, leaving the reset (OSC 110) with no verified setup",
        "extensions.osc111-reset-bg":
          "Open: the colour query (OSC 11) did not confirm the colour we set, leaving the reset (OSC 111) with no verified setup",
        "extensions.osc112-reset-cursor":
          "Open: the colour query (OSC 12) did not confirm the colour we set, leaving the reset (OSC 112) with no verified setup",
        "extensions.osc113-reset-pointer-fg":
          "Open: the colour query (OSC 13) got no answer, though the reply control came back. The query is silent and the reset itself stays unseen",
        "extensions.osc114-reset-pointer-bg":
          "Open: the colour query (OSC 14) got no answer, though the reply control came back. The query is silent and the reset itself stays unseen",
        "extensions.osc30001-color-stack-push":
          "Open: the text-colour query (OSC 10) got no answer, leaving saving and restoring colours unseen",
        "extensions.osc30101-color-stack-pop":
          "Open: the text-colour query (OSC 10) got no answer, leaving saving and restoring colours unseen",
      }
      expect(batch.notTested, result.featureId).toContainEqual({
        featureId: result.featureId,
        reason: "no-semantic-observable",
        noObservable: noSetup
          ? expect.stringMatching(/Untestable \(no setup\):/)
          : noObservableByFeature[result.featureId],
        rawReplyRef: result.featureId,
      })
      expect(result.tests, result.featureId).toContainEqual(
        expect.objectContaining({
          id: noSetup ? "declared-untestable" : "review",
          status: noSetup ? "untestable" : "probe-todo",
          rawReplyRef: result.featureId,
        }),
      )
    }
  },
)

// @failure @cto's DEC Case 2 ruling R3 (09:00) corrected this test's own claim: a fake that records only
//   OSC says nothing about the SGR ids it lists. A VT100-shaped report - OSC entries for every terminated
//   OSC, one numeric SGR entry per operand the engine drops, nothing for a colon group - must move exactly
//   the twelve shell cells, the four named colour resets, OSC 777 notify, OSC 9 progress and four numeric SGR cells (faint 2m, italic
//   3m, strikethrough 9m, double underline 21m), and nothing else: blink (5) is in the engine's handled
//   list, the three colon underline forms record nothing, and the two delivery cells are never decided by
//   the report. @dev/8 Case 2 consumer: 32369.
//   Owned layout only: this boundary needs the linked @termless/vt100 generation. Hosted unit packs
//   @termless/core from source-siblings.json but takes registry @termless/vt100 0.10.2, whose vt100.js
//   0.7.0 applies the OSC 2 title, so the Case 2 fallback is unreachable.
// @level l2
// @consumer 32369 consumer boundary for the VT100 ignored-report producer (32364).
// @testonly none
test.runIf(OWNED_LAYOUT)("a VT100-shaped report moves the claimed OSC and SGR cells and nothing else", async () => {
  const ids = [
    "extensions.osc133-a",
    "extensions.osc133-b",
    "extensions.osc133-c",
    "extensions.osc133-d",
    "extensions.osc133-p",
    "extensions.semantic-prompts",
    "extensions.osc633-a",
    "extensions.osc633-b",
    "extensions.osc633-c",
    "extensions.osc633-d",
    "extensions.osc633-e",
    "extensions.osc-633-vscode",
    "extensions.osc113-reset-pointer-fg",
    "extensions.osc114-reset-pointer-bg",
    "extensions.osc117-reset-highlight-bg",
    "extensions.osc119-reset-highlight-fg",
    "sgr.blink",
    "sgr.faint",
    "sgr.italic",
    "sgr.strikethrough",
    "sgr.underline.double",
    "sgr.underline.curly",
    "sgr.underline.dotted",
    "sgr.underline.dashed",
    "extensions.osc7-cwd",
    "extensions.osc9-progress",
    "extensions.osc633-p",
    "extensions.osc777-notify",
  ]
  const definitions = registryDefinitions(ids)
  // Keep the same real engine and capabilities, withholding only the report reader.
  // The native adapter now exposes it, so using resolveVt100 directly compares two positives.
  const baseline = await collectBatch(
    async () => {
      const value = await resolveVt100()
      Object.assign(value, { getUnhandledSequences: undefined })
      return value
    },
    "vt100",
    definitions,
  )
  let reported = 0
  // What the VT100 engine's own ignore loop reports: a numeric SGR operand outside its handled list
  // (0/1/4/5/7/22/24/25/27), one entry per operand. A colon group is NaN and records nothing.
  const handledSgr = new Set(["0", "1", "4", "5", "7", "22", "24", "25", "27"])
  const declaring = async () => {
    const value = await resolveVt100()
    const report: { kind: "osc" | "csi"; code: string }[] = []
    value.capabilities.extensions.add("osc-metadata")
    const feed = value.feed.bind(value)
    Object.assign(value, { getUnhandledSequences: () => report.slice() })
    value.feed = (data: Uint8Array) => {
      const text = new TextDecoder().decode(data)
      for (const match of text.matchAll(/\x1b\](\d+)/g)) {
        report.push({ kind: "osc", code: match[1]! })
        reported += 1
      }
      for (const match of text.matchAll(/\x1b\[(\d+)m/g)) {
        if (handledSgr.has(match[1]!)) continue
        report.push({ kind: "csi", code: `${match[1]}m` })
        reported += 1
      }
      feed(data)
    }
    // The variant must carry the declaration and only this member; otherwise the proof is vacuous.
    expect(hasExtension(value, "osc-metadata")).toBe(true)
    expect(typeof (value as Partial<OscMetadataExtension>).getUnhandledSequences).toBe("function")
    return value
  }
  const variant = await collectBatch(declaring, "vt100", definitions)
  const rows = (batch: Awaited<ReturnType<typeof collectBatch>>) =>
    batch.results.map((result) => ({
      featureId: result.featureId,
      status: result.status,
      criterionBranch: result.criterionBranch ?? null,
      reason: result.reason ?? null,
      // Timing fields differ between any two runs; the criterion verdict is what a row comparison reads.
      tests: (result.tests ?? []).map((entry) => ({
        id: entry.id,
        status: entry.status,
        reason: entry.reason ?? null,
      })),
    }))
  // Non-vacuous: the variant really fed sequences its own report recorded, of both kinds.
  expect(reported).toBeGreaterThan(0)
  const moved = rows(variant).filter((row, index) => JSON.stringify(row) !== JSON.stringify(rows(baseline)[index]))
  const expectedMoves = [
    "extensions.osc-633-vscode",
    "extensions.osc113-reset-pointer-fg",
    "extensions.osc114-reset-pointer-bg",
    "extensions.osc117-reset-highlight-bg",
    "extensions.osc119-reset-highlight-fg",
    "extensions.osc133-a",
    "extensions.osc133-b",
    "extensions.osc133-c",
    "extensions.osc133-d",
    "extensions.osc133-p",
    "extensions.osc633-a",
    "extensions.osc633-b",
    "extensions.osc633-c",
    "extensions.osc633-d",
    "extensions.osc633-e",
    "extensions.osc633-p",
    "extensions.osc777-notify",
    "extensions.osc9-progress",
    "extensions.semantic-prompts",
    "sgr.faint",
    "sgr.italic",
    "sgr.strikethrough",
    "sgr.underline.double",
  ]
  expect(moved.map((row) => row.featureId).sort()).toEqual(expectedMoves)
  for (const row of moved) {
    expect(row.status, row.featureId).toBe("unsupported")
    expect(JSON.stringify(row), row.featureId).toContain("library reported this sequence as unhandled")
  }
  // Blink, the three colon underline forms and the remaining delivery cell keep the baseline result exactly.
  const still = (batch: Awaited<ReturnType<typeof collectBatch>>, keep: (id: string) => boolean) =>
    rows(batch).filter((row) => keep(row.featureId))
  const unchanged = (id: string) => !expectedMoves.includes(id)
  expect(still(variant, unchanged)).toEqual(still(baseline, unchanged))
  expect(
    still(variant, unchanged)
      .map((row) => row.featureId)
      .sort(),
  ).toEqual(["extensions.osc7-cwd", "sgr.blink", "sgr.underline.curly", "sgr.underline.dashed", "sgr.underline.dotted"])
  expect(JSON.stringify(still(variant, unchanged))).not.toContain("library reported this sequence as unhandled")
})

test("keeps the measured probe result when the engine answers its colour readback", async () => {
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
    status: "probe-todo",
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
// The adapters above report no such callback, so no existing collector test could decide such a probe result.
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
])("records a probe result for a capture that reached an unreproduced callback ($name)", async ({ query, harness }) => {
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
  expect(result?.status).toBe("probe-invalid")
  expect(result?.tests).toEqual([
    expect.objectContaining({
      id: HARNESS_INCOMPLETE_TEST,
      status: "probe-invalid",
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

test("real vterm records an interior-region SU probe result without moving the row above into history", async () => {
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

test("attributes headless exceptions only to the headless marker and retains legacy throws as diagnostics", async () => {
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
    expect(batch.results.find((result) => result.featureId === id)?.status).toBe("probe-invalid")
  }
  expect(probeReplies(batch)).toEqual({})
  expect(batch.assertions).toEqual([])
})

test("routes real registry constructor markers while multi-method callbacks remain diagnostics", async () => {
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
  const batch = await collectBatch(
    afterReplyControl(async () => value),
    "xtermjs",
    definitions,
  )
  expect(batch.observations).toEqual([])
  expect(Object.keys(batch.ungradedDiagnostics).sort()).toEqual([...ids].sort())
  for (const id of ids) {
    expect(batch.ungradedDiagnostics[id]).toMatchObject({
      message: "headless xtermjs probe " + id + ": Registry setup failed",
    })
    expect(batch.results.find((result) => result.featureId === id)?.status).toBe("probe-invalid")
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
    afterReplyControl(async () => {
      if (stage === "factory") throw failure
      return value
    }),
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
  "retains a declared-none setup failure as a diagnostic at %s instead of emitting an unparsable error",
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
      afterReplyControl(async () => {
        if (stage === "factory") throw failure
        return value
      }),
      "xtermjs",
      [definition("declines", callback, { libAssertionType: null })],
    )
    expect(callback).not.toHaveBeenCalled()
    // The canonical parser admits none only as an inconclusive refusal, so a collector failure on a
    // none arm stays a named diagnostic without a probe result instead of becoming an error observation.
    expect(batch.observations).toEqual([])
    expect(batch.ungradedDiagnostics).toEqual({
      declines: { kind: "collector-error", name: "Error", message: `headless xtermjs probe declines: ${stage} failed` },
    })
  },
)

test("a real none-declaring probe retains its setup failure as a diagnostic", async () => {
  const ligatures = ALL_PROBES.find((probe) => probe.id === "extensions.font-ligatures")
  expect(ligatures?.libAssertionType).toBeNull()
  const batch = await collectBatch(
    afterReplyControl(async () => {
      throw new Error("engine unavailable")
    }),
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
      collectBatch(
        afterReplyControl(async () => value),
        "xtermjs",
        [definition("first", () => fakeProbeResult()), definition("next", next)],
      ),
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
  const batch = await collectBatch(
    afterReplyControl(async () => value),
    "xtermjs",
    [
      definition(
        "query",
        (ctx) => {
          ctx.feedCapture("\x1b[c")
          return fakeProbeResult("query_reply")
        },
        { libAssertionType: "query_reply" },
      ),
    ],
  )
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
    { featureId: "first", status: "probe-invalid" },
    { featureId: "second", status: "probe-invalid" },
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
        tests: [{ id: "criterion", status: "probe-todo", reason: "insufficient-evidence" }],
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
      // refusal, so this contradiction stays a named diagnostic without a probe result.
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
// assertions as text in the refusal, on every recorder branch, so the run file shows what the probe saw.
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
  // Route 2: the audited xterm OSC 52 writes declare an app handoff without a typed observation.
  expect(batch.results).toMatchObject([
    { featureId: ids[0], status: "supported", assertionType: "buffer_state" },
    { featureId: ids[1], status: "untestable", criterionBranch: "headless-observable-review" },
    { featureId: ids[2], status: "untestable", criterionBranch: "headless-observable-review" },
  ])
  for (const row of batch.results.slice(1)) {
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
  // A stray type cannot turn the app handoff declaration into a measured verdict.
  const mislabeled = structuredClone(captured)
  for (const result of mislabeled.results.slice(1)) result.assertionType = "query_reply"
  for (const assertion of mislabeled.assertions.filter((entry) => entry.featureId !== ids[0])) {
    assertion.assertionType = "query_reply"
  }
  const relabeled = read(mislabeled).results
  expect(relabeled?.slice(1).map((row) => row.status)).toEqual(["untestable", "untestable"])
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
        'Callback for legacy returned neither an observation nor a not-tested coverage record; no probe result can be decided; refused assertion(kind=positive, expected="X", observed="X")',
    },
  })
  expect(probeReplies(batch)).toStrictEqual({ legacy: "X" })
})

// 30585: a probe that got no reply names that as its reason, and the reason is the record of the missing raw.
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
      status: "probe-invalid",
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
          "Callback for legacy returned neither an observation nor a not-tested coverage record; no probe result can be decided",
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
    { featureId: "modes.bracketed-paste", status: "probe-invalid" },
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
    { featureId: "modes.bracketed-paste", status: "probe-invalid" },
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
    { featureId: "modes.bracketed-paste", status: "probe-invalid" },
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
    { featureId: "modes.bracketed-paste", status: "probe-invalid" },
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

// AC3: feature support cannot authorize metadata readback. Existing tests decide probe results from
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
      ids.map((featureId) => ({ featureId, status: metadataAvailable ? "supported" : "probe-todo" })),
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
      expect(instances[index + 1]!.writes).toEqual(writes)
    }
    const uri = "https://example.com/osc8-proof"
    expect(JSON.parse(batch.rawReplies["extensions.osc8"]!)).toEqual({
      chars: [..."ALINKZ"],
      links: [null, uri, uri, uri, uri, null].map((uri) => ({ reported: true, uri })),
    })
    expect(instances).toHaveLength(5)
    expect(instances[0]!.writes).toEqual(["\x1b[3;7H\x1b[6n"])
    expect(instances.map(({ replies }) => replies)).toEqual([[], [], [], [], []])
    expect(JSON.parse(batch.rawReplies["collector.replyControl"]!)).toMatchObject({
      answered: true,
      captures: [{ response: "\x1b[3;7R" }],
    })
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
    { featureId: "attempted", status: "probe-invalid" },
    { featureId: "unimplemented", status: "probe-todo" },
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
      tests: [{ id: "criterion", status: "probe-invalid", reason: "Timed out without a deciding observable" }],
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
  expect(result.results.map((entry) => entry.status)).toEqual(["probe-invalid", "probe-invalid"])
  expect(result.rawReplies).toMatchObject({ "execution-only": "retained refusal", "declared-null": "retained state" })
  expect(result.results[0]).toMatchObject({
    rawReplyRef: "execution-only",
    tests: [expect.objectContaining({ status: "probe-invalid" })],
  })
  expect(result.observations).toMatchObject([
    { featureId: "declared-null", outcome: "error", reason: "collector-error" },
  ])
})

// AC1: the old preflight refused an exact declared/loaded identity because it lacked
// audit-table membership; existing tests deliberately asserted that obsolete refusal.
test("a silent loaded binary uses the measured control and retains its observed buffer result", async () => {
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
  const definitions = registryDefinitions(["device.xtgettcap", "sgr.bold"]).map((definition) => ({
    ...definition,
    lib: (ctx: LibProbeSource) => definition.lib!({ ...ctx, runtimeIdentity: identity }),
  }))
  const batch = await collectBatch(backend, "xtermjs", definitions)
  expect(batch.results.find((row) => row.featureId === "device.xtgettcap")).toMatchObject({
    status: "unsupported",
    tests: [{ id: "criterion", status: "unsupported", reason: "negative by sentinel" }],
  })
  expect(batch.observations.find((row) => row.featureId === "sgr.bold")).toMatchObject({
    outcome: "supported",
    assertionType: "buffer_state",
  })
  expect(batch.results.find((row) => row.featureId === "sgr.bold")).toMatchObject({
    status: "supported",
  })
})

// 31387: An adapter reporting an empty title after OSC 2 leaves the title-stack round trip unobservable.
// A rowless inconclusive was folded to PROBE INVALID as a callback defect; an unobservable setup takes
// the headless observable review instead, retaining both fixtures' empty readings (#32282).
const TITLE_STACK_IDS = ["device.xtwinops-22", "device.xtwinops-23"] as const

function expectTitleSetupReview(batch: Awaited<ReturnType<typeof collectBatch>>): void {
  expect(batch.results).toMatchObject(
    TITLE_STACK_IDS.map((featureId) => ({
      featureId,
      status: "probe-todo",
      criterionBranch: HEADLESS_OBSERVABLE_REVIEW,
      tests: [
        {
          id: "review",
          status: "probe-todo",
          reason:
            "Open: this test first sets a window title, then tests whether the command under test changes it. We could not read the first title back, so this run cannot decide it",
        },
      ],
    })),
  )
  expect(batch.observations).toEqual([])
  expect(batch.assertions).toEqual([])
  for (const id of TITLE_STACK_IDS) {
    expect(JSON.parse(batch.rawReplies[id]!)).toEqual({
      before: "",
      popFixture: { original: "", changed: "", restored: "" },
      pushFixture: { original: "", changed: "", restored: "" },
    })
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
  `real Ghostty native title-stack fixtures retain their observed evidence${ghosttyNativeAvailable ? "" : " (NOT MEASURED: native addon unavailable)"}`,
  async () => {
    const batch = await collectBatch(
      async () => createGhosttyNativeBackend(),
      "ghostty-native",
      registryDefinitions(TITLE_STACK_IDS),
    )
    // The published addon exposes no title state; current source builds observe setup.
    // Each path retains both fixtures; only observable controls can decide the round trip.
    const firstFixture = JSON.parse(batch.rawReplies[TITLE_STACK_IDS[0]]!) as { popFixture: { original: string } }
    if (firstFixture.popFixture.original === "") {
      expectTitleSetupReview(batch)
      return
    }
    // Both OSC 2 controls work, but the joint push/pop round trip does not restore either title.
    expect(batch.results).toMatchObject(
      TITLE_STACK_IDS.map((featureId) => ({
        featureId,
        status: "unsupported",
        tests: [{ id: "criterion", status: "unsupported", reason: "push/pop round trip does not restore" }],
      })),
    )
    expect(batch.observations).toMatchObject(
      TITLE_STACK_IDS.map((featureId) => ({
        featureId,
        outcome: "unsupported",
        assertionType: "buffer_state",
        note: "push/pop round trip does not restore",
      })),
    )
    expect(batch.assertions).toMatchObject(
      TITLE_STACK_IDS.map((featureId) => ({ featureId, kind: "negative", assertionType: "buffer_state" })),
    )
    for (const id of TITLE_STACK_IDS) {
      expect(JSON.parse(batch.rawReplies[id]!)).toEqual({
        before: "",
        popFixture: { original: "pushed-title", changed: "new-title", restored: "new-title" },
        pushFixture: { original: "new-title", changed: "next-title", restored: "next-title" },
      })
    }
  },
)

test("paste-encoding forwarding requires declaration and function, binds the backend, and fails loudly on a broken declaration", async () => {
  const value = await createXtermBackend()
  value.init({ cols: 80, rows: 24 })
  const native = vi.fn(function (this: typeof value, text: string) {
    expect(this).toBe(value)
    return new TextEncoder().encode(text)
  })
  Object.assign(value, { encodePaste: native })
  try {
    expect(createLibProbeSource(value, undefined, undefined, undefined).encodePaste).toBeUndefined()
    value.capabilities.extensions.add("paste-encoding")
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    expect(source.encodePaste?.("native-paste")).toEqual(new TextEncoder().encode("native-paste"))
    expect(native).toHaveBeenCalledExactlyOnceWith("native-paste")
    Object.assign(value, { encodePaste: undefined })
    expect(() => createLibProbeSource(value, undefined, undefined, undefined)).toThrow(
      /declares capability extension "paste-encoding" without an encodePaste function/,
    )
  } finally {
    value.destroy()
  }
})

// #32318: callback-only checks miss a mixed reader rejected by the production declaration gate.
// Use the real libvterm SGR reporter whose faint field is unreported; no feature is implemented by the fixture.
test("records qualified SGR readback when the cell attribute is unreported", async () => {
  const definition = registryDefinitions(["sgr.faint"])[0]!
  const original = definition.lib!
  const batch = await collectBatch(resolveLibvterm, "libvterm", [
    {
      ...definition,
      lib(ctx) {
        return original({
          ...ctx,
          queryWithSentinelOutcome(sequence, pattern) {
            const raw = ctx.feedCapture(sequence)
            return { raw, rawBase64: Buffer.from(raw).toString("base64"), match: raw.match(pattern), reason: "reply" }
          },
        })
      },
    },
  ])
  expect(batch.results[0]?.reason).toBeUndefined()
  expect(batch.results).toMatchObject([{ featureId: "sgr.faint", status: "unsupported" }])
  expect(batch.observations).toMatchObject([
    { featureId: "sgr.faint", outcome: "unsupported", assertionType: "query_reply" },
  ])
  expect(JSON.parse(batch.rawReplies["sgr.faint"]!)).toMatchObject({
    sgrReadback: { control: expect.stringContaining("m"), target: expect.stringContaining("m") },
  })
})

// The three actual factory names are the approved subjects, not user-facing selectors.
test.each([
  ["xterm", "xtermjs", createXtermBackend, "@xterm/headless 6.0.0"],
  ["alacritty", "alacritty", createAlacrittyBackend, "alacritty_terminal 0.26.0"],
  ["vt100-rust", "vt100-rust", createVt100RustBackend, "vt100 0.16.2"],
] as const)(
  "real %s factory paste absence records the approved Untestable result",
  async (name, selector, create, library) => {
    const value = await create()
    value.init({ cols: 80, rows: 24 })
    expect(value.name).toBe(name)
    expect(value.capabilities.extensions.has("paste-encoding")).toBe(false)
    const definition = registryDefinitions(["extensions.clipboard-paste"])[0]!
    const draft = {
      runId: `paste-absence-${name}`,
      rawReplies: {},
      results: [
        { featureId: definition.id, status: "probe-todo" as const, attempt: { scope: "none" as const }, tests: [] },
      ],
    }
    const batch = await collectBatch(async () => value, selector, [definition], draft)
    expect(batch.ungradedDiagnostics).toEqual({})
    expect(batch.results).toMatchObject([{ status: "untestable", reason: expect.stringContaining(library) }])
    expect(batch.observations).toEqual([])
    expect(batch.assertions).toEqual([])
  },
)

// @cto routes-32 sections 3 and 4: the real engines decide slice C's measured kitty-click rows.
test.runIf(OWNED_LAYOUT).each([
  ["vt100", async () => createVt100Backend(), "library reported this sequence as unhandled"],
  ["vt220", async () => createVt220Backend(), "library reported this sequence as unhandled"],
  ["wezterm", async () => createWeztermBackend(), "kitty-click-events:1"],
] as const)("real %s reads input.kitty-click-events Unsupported", async (name, create, evidence) => {
  const value = await create()
  value.init({ cols: 80, rows: 24 })
  try {
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    const result = registryDefinitions(["input.kitty-click-events"])[0]!.lib!(source)
    expect(result.observation?.outcome, name).toBe("unsupported")
    expect(JSON.stringify(result), name).toContain(evidence)
  } finally {
    value.destroy()
  }
})

// @failure A real Alacritty mode reader is bypassed or a shared encoder grades urxvt mouse support.
// @consumer The registered urxvt callback through the production collector and native Alacritty reader.
test.runIf(OWNED_LAYOUT)("real Alacritty reads urxvt mouse Unsupported from its controlled mode query", async () => {
  const id = "input.urxvt-mouse"
  const batch = await collectBatch(async () => createAlacrittyBackend(), "alacritty", registryDefinitions([id]))
  expect(batch.results).toMatchObject([{ featureId: id, status: "unsupported", assertionType: "query_reply" }])
  expect(JSON.parse(batch.rawReplies[id]!)).toEqual({
    controlReset: "\x1b[?1006;2$y",
    controlSet: "\x1b[?1006;1$y",
    unknown: "\x1b[?9999;0$y",
    targetBefore: "\x1b[?1015;0$y",
    targetAfter: "\x1b[?1015;0$y",
  })
  expect(batch.assertions).toMatchObject([{ featureId: id, kind: "negative", assertionType: "query_reply" }])
})

// @cto 8c79b122: each engine's own report decides OSC 8. Hosted CI resolves published vt100 and vt220, which have no
// report and stay TODO, so this reads the owned layout only.
test.runIf(OWNED_LAYOUT).each([
  ["libvterm", resolveLibvterm],
  ["vt100", async () => createVt100Backend()],
  ["vt220", async () => createVt220Backend()],
  ["vt100-rust", async () => createVt100RustBackend()],
] as const)("real %s reads extensions.osc8 Unsupported by its own report", async (name, create) => {
  const value = await create()
  value.init({ cols: 80, rows: 24 })
  try {
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    const result = registryDefinitions(["extensions.osc8"])[0]!.lib!(source)
    expect(result.observation?.outcome, name).toBe("unsupported")
    expect(JSON.stringify(result), name).toContain("library reported this sequence as unhandled")
  } finally {
    value.destroy()
  }
})

// NR-A, @cto 947dcd40 slice A: the real engine's own reports decide these rows; the identity is the audited subject.
// Hosted resolves the published adapter, which is not that subject.
test.runIf(OWNED_LAYOUT)(
  "real vt100-rust reports NR-A and urxvt targets unhandled and declares Kitty display",
  async () => {
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
        toolchain: "fixture",
        lockSha256: "4cf037e4efa648ca41d08b30ef5c4ce7ada29ad61fcad45a7d1aa97bf55391c6",
      },
      adapterSources: [
        { path: "packages/vt100-rust/src/index.ts", blobOid: "3ddb74f3ae1f79bb356952103853232f69211268" },
        { path: "packages/vt100-rust/src/backend.ts", blobOid: "ddabecd4881be4f6b63f1c35f9c2265b53d35df4" },
      ],
    }
    const reported = [
      "editing.decsace",
      "extensions.osc5522-clipboard",
      "extensions.kitty-keyboard",
      "extensions.kitty-keyboard.disambiguate",
      "extensions.kitty-keyboard.report-events",
      "extensions.kitty-keyboard.report-alternate",
      "extensions.kitty-keyboard.report-all-keys",
      "extensions.kitty-keyboard.report-text",
      "input.csi-u",
      "input.pixel-mouse",
      "input.urxvt-mouse",
      "input.kitty-click-events",
    ]
    const read = async (id: string) => {
      const value = await createVt100RustBackend()
      value.init({ cols: 80, rows: 24 })
      try {
        const source = {
          ...createLibProbeSource(value, undefined, undefined, undefined),
          runtimeIdentity: identity,
        }
        return registryDefinitions([id])[0]!.lib!(source)
      } finally {
        value.destroy()
      }
    }
    for (const id of reported) {
      const result = await read(id)
      expect(result.observation?.outcome, id).toBe("unsupported")
      expect(JSON.stringify(result), id).toContain("library reported this sequence as unhandled")
    }
    expect(isDeclaredUntestable(await read("extensions.kitty-graphics.display"))).toBe(true)
  },
)

// A native DECRPM reply can save actual state even where the optional library getter is unavailable.
test.each([false, true])("libvterm paste mode query measures and restores actual incoming 2004=%s", async (initial) => {
  const value = await resolveLibvterm()
  value.init({ cols: 80, rows: 24 })
  try {
    const source = createLibProbeSource(value, undefined, undefined, undefined)
    expect(source.getMode("bracketedPaste")).toBeNull()
    source.feed(initial ? "\x1b[?2004h" : "\x1b[?2004l")
    const definition = registryDefinitions(["extensions.clipboard-paste"])[0]!
    const result = definition.lib!(source)
    expect(result.observation?.outcome).toBe("supported")
    expect(source.feedCapture("\x1b[?2004$p")).toContain(initial ? "\x1b[?2004;1$y" : "\x1b[?2004;2$y")
    const evidence = JSON.parse(result.response!) as { incomingMode: boolean; modeReads: Array<{ raw: string }> }
    expect(evidence.incomingMode).toBe(initial)
    expect(evidence.modeReads).toHaveLength(2)
    expect(evidence.modeReads.every((read) => read.raw.includes(initial ? ";1$y" : ";2$y"))).toBe(true)
  } finally {
    value.destroy()
  }
})

// AC4: these real adapters must reach the registered OSC consumer, including its
// buffer_state assertion admission. Callback-only tests miss collector INVALID.
test.each([["libvterm", resolveLibvterm]] as const)(
  "%s OSC22 report crosses the real collector boundary",
  async (engine, factory) => {
    const batch = await collectBatch(factory, engine, registryDefinitions(["extensions.osc22-pointer"]))
    expect(batch.results).toMatchObject([
      {
        featureId: "extensions.osc22-pointer",
        status: "unsupported",
        reason: "library reported this sequence as unhandled",
      },
    ])
    expect(batch.observations).toMatchObject([{ assertionType: "buffer_state", outcome: "unsupported" }])
  },
)

// R1: native callback tests cannot catch a registry route that still declares
// these cells unreadable, rejects buffer_state, or lets an old source-absence
// cohort shadow the rebuilt adapter's working retained-history reader.
test.runIf(OWNED_LAYOUT)(
  "libvterm R1 reports decide six cells while preserving measured retained history",
  async () => {
    const historyIds = ["erase.screen.scrollback", "scrollback.accumulate", "scrollback.total-lines"]
    const ids = [
      "modes.xtpushcolors",
      "modes.xtpopcolors",
      "modes.decsscls",
      "editing.decsace",
      "extensions.kitty-graphics.display",
      "extensions.kitty-graphics.transmit",
      ...historyIds,
    ]
    const measured = await resolveLibvterm()
    measured.init({ cols: 80, rows: 24 })
    const identity = await headlessIdentity.headlessRuntimeIdentity("libvterm", "@termless/libvterm", "wasm")
    identity.adapterSources = headlessIdentity.readAdapterSources("libvterm", measured)
    measured.destroy()
    const runtime = {
      identity,
      adapterPath: fileURLToPath(import.meta.resolve("@termless/libvterm")),
      adapterPackage: "@termless/libvterm",
      adapterType: "wasm",
    }
    const batch = await collectBatch(
      resolveLibvterm,
      "libvterm",
      registryDefinitions(ids),
      undefined,
      undefined,
      runtime,
    )
    expect(batch.results).toHaveLength(ids.length)
    for (const result of batch.results) {
      if (historyIds.includes(result.featureId)) {
        expect(result.status, result.featureId).toBe("supported")
        continue
      }
      const noWay = ["modes.xtpushcolors", "modes.xtpopcolors", "editing.decsace"].includes(result.featureId)
      expect(result.status, result.featureId).toBe(noWay ? "untestable" : "unsupported")
      if (noWay) {
        expect(result.reason).toBe(
          "libvterm 0.3.3 drops CSI with intermediate # or * in on_csi before its public fallback, and has no other hook.",
        )
      } else {
        expect(result.reason, result.featureId).toBe("library reported this sequence as unhandled")
      }
    }
    expect(batch.observations).toHaveLength(6)
    for (const observation of batch.observations) {
      expect(observation.assertionType).toBe("buffer_state")
      expect(observation.outcome).toBe(historyIds.includes(observation.featureId) ? "supported" : "unsupported")
    }
  },
)

test.runIf(OWNED_LAYOUT).each([
  ["vt100", resolveVt100],
  ["vt220", resolveVt220],
] as const)("%s OSC1 and OSC22 reports cross the real collector boundary", async (engine, factory) => {
  const ids = ["extensions.osc1-icon", "extensions.osc22-pointer"]
  const batch = await collectBatch(factory, engine, registryDefinitions(ids))
  expect(batch.results).toHaveLength(2)
  for (const result of batch.results) {
    expect(result.status, result.featureId).toBe("unsupported")
    expect(result.reason).toBe("library reported this sequence as unhandled")
  }
  expect(batch.observations).toHaveLength(2)
  for (const observation of batch.observations) expect(observation.assertionType).toBe("buffer_state")
})

// Route 2: the real collector must admit the report's buffer_state assertion
// for these query_reply definitions; callback-only tests cannot catch that boundary.
test.runIf(OWNED_LAYOUT).each([
  ["vt100", resolveVt100],
  ["vt220", resolveVt220],
] as const)("%s OSC52 write reports cross the real collector boundary", async (engine, factory) => {
  const ids = ["extensions.osc52-clipboard", "extensions.osc52-write"]
  const batch = await collectBatch(factory, engine, registryDefinitions(ids))
  expect(batch.results.map(({ featureId, status }) => [featureId, status])).toEqual(
    ids.map((id) => [id, "unsupported"]),
  )
  for (const result of batch.results) expect(result.reason).toBe("library reported this sequence as unhandled")
  expect(batch.observations.map(({ assertionType }) => assertionType)).toEqual(["buffer_state", "buffer_state"])
})

// NR-C: scalar-only reporting misses colour payload lists, while setup rejection
// must declare the dependent claim Untestable rather than grade the target.
test.runIf(OWNED_LAYOUT).each([
  ["vt100", resolveVt100],
  ["vt220", resolveVt220],
] as const)("%s DEC colour and setup reports decide the approved nineteen cells", async (engine, factory) => {
  const negatives = [
    "sgr.fg.standard",
    "sgr.bg.standard",
    "sgr.fg.bright",
    "sgr.bg.bright",
    "sgr.fg.default",
    "sgr.bg.default",
    "extensions.osc2-title",
    "sgr.fg.256",
    "sgr.bg.256",
    "sgr.fg.truecolor",
    "sgr.bg.truecolor",
    "extensions.truecolor",
    "extensions.osc633-p",
  ]
  const absences = [
    "erase.el-with-attrs",
    "device.xtwinops-22",
    "device.xtwinops-23",
    "modes.alt-screen.exit",
    "sgr.selective-reset.italic",
    "editing.decsace",
  ]
  const ids = [...negatives, ...absences]
  const adapterPackage = `@termless/${engine}`
  const identity = await headlessIdentity.headlessRuntimeIdentity(engine, adapterPackage, "js")
  const definitions = registryDefinitions(ids).map((definition) => ({
    ...definition,
    lib: (ctx: LibProbeSource) => definition.lib!({ ...ctx, runtimeIdentity: identity }),
  }))
  const batch = await collectBatch(factory, engine, definitions)
  expect(batch.results.map(({ featureId, status }) => [featureId, status])).toEqual(
    ids.map((id) => [id, negatives.includes(id) ? "unsupported" : "untestable"]),
  )
  for (const result of batch.results) {
    if (negatives.includes(result.featureId)) {
      expect(result.reason, result.featureId).toBe("library reported this sequence as unhandled")
    } else {
      expect(result.tests, result.featureId).toEqual([
        expect.objectContaining({ id: "declared-untestable", status: "untestable" }),
      ])
    }
  }
})
