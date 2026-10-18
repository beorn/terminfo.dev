/**
 * @failure The Release 1 re-collection would silently drop a context that has no route (Windows, or
 *   an engine the Termless manifest stops exporting), hand a row a launcher flag no committed run
 *   carries (kitty takes `--preset baseline|current`, never the launcher's default, and a clipboard
 *   override is not `default`), or admit a run collected from a dirty tree, on a suite that is not
 *   the frozen one, or never admitted at all — so a row would land on the bar from a collection that
 *   does not count, and the census would read complete while it is not. Admission rejection must
 *   propagate from the single owner before the caller credits coverage.
 *   Collector output failures must retain the pass ledger and raw files already collected.
 * @level l2
 * @consumer Full catalog/backend collection census and existing admission owner (scripts/release1-collection.ts)
 * @reach fs-walk vendor/terminfo.dev/content/** vendor/terminfo.dev/.github/workflows/**
 * @testonly none
 */
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync, spawnSync } from "node:child_process"
import * as childProcesses from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"
import * as admission from "./admit-run.ts"
import { parseSuiteManifest } from "@terminfo/run-parser"
import * as versions from "../packages/admin/versions.ts"
import * as headless from "../packages/probes/collect-headless.ts"
import { buildReport } from "./decisive-share.ts"
import {
  admitProducedRuns,
  collectPass,
  clipboardProfileFor,
  linuxLedger,
  presetFor,
  release1Census,
  uncoveredContexts,
  type LinuxLedger,
  type ProducedRun,
} from "./release1-collection.ts"

// Replace only the external terminal process owner; parsing and classification remain real.
vi.mock("../packages/probes/collect-headless.ts", () => ({ collectHeadlessRuns: vi.fn() }))
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

/** One fixture Linux row: a committed run the census reads the launcher flags back from. */
const ledgerRow = (id: string, overrides: Partial<LinuxLedger[string]> = {}): LinuxLedger[string] => ({
  runId: `${id}-fixture`
    .replace(/[^a-z0-9]/g, "")
    .padEnd(32, "0")
    .slice(0, 32),
  file: `probes-apps/${id}-0.0.0-linux-fixture.json`,
  version: "0.0.0",
  preset: "default",
  clipboardProfile: "default",
  ids: null,
  selection: "site-selected",
  exclusion: null,
  ...overrides,
})

/**
 * A fixture ledger: the five Linux rows with the flags a committed run yields. The census takes the
 * ledger in rather than reading content, so the pure tests never touch the corpus.
 */
const LEDGER: LinuxLedger = {
  kitty: ledgerRow("kitty", { version: "0.49.2", preset: "current" }),
  ghostty: ledgerRow("ghostty", { version: "1.3.1" }),
  xterm: ledgerRow("xterm", { version: "411" }),
  alacritty: ledgerRow("alacritty", {
    version: "0.17.0",
    selection: "newest-admitted",
    exclusion: "identity-replies-mismatch",
  }),
  wezterm: ledgerRow("wezterm", {
    version: "0-unstable-2026-09-17",
    selection: "newest-admitted",
    exclusion: "identity-no-profile",
  }),
}

const census = (engineBackends: readonly string[] = ENGINE_BACKENDS) => release1Census(engineBackends, LEDGER)

/** The committed corpus this repository ships, as the CLI reads it. */
const CONTENT = join(dirname(fileURLToPath(import.meta.url)), "..", "content")

/** The Termless manifest's engine names, as a fixture: the census takes them in, it never guesses. */
const ENGINE_BACKENDS = [
  "alacritty",
  "ghostty",
  "ghostty-native",
  "kitty",
  "libvterm",
  "vt100",
  "vt100-rust",
  "vt220",
  "vterm",
  "wezterm",
  "xtermjs",
]

const cleanRun = (overrides: Partial<ProducedRun> = {}): ProducedRun => ({
  target: { kind: "app", id: "xterm", os: "linux" },
  ...overrides,
})

// The dispatch boundary must use the CURRENT in-memory suite, even when the corpus already
// declares the returned run's old suite. Projection parity does not cover this collection seam.
it.each([
  ["different", "none"],
  ["matching", "none"],
  ["matching", "rewrite"],
  ["matching", "remove"],
  ["matching", "blocked-hosted"],
  ["matching", "blocked-macos"],
] as const)("retains a private %s-suite pass after %s without admission", async (suite, inputChange) => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-development-pass-"))
  const input = join(directory, "suite-input.ts")
  writeFileSync(input, "original private suite input")
  const original = join(CONTENT, "probes-libs/xtermjs-6.0.0-linux-c19905bf-2d90-474c-9e1a-13805bb3c0c4.json")
  const originalBytes = readFileSync(original, "utf8")
  const raw = JSON.parse(originalBytes) as { probeHash: string; sourceRevision: string }
  raw.sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirname(CONTENT), encoding: "utf8" }).trim()
  const bytes = JSON.stringify(raw)
  const manifestPath = join(CONTENT, "suites", `${raw.probeHash}.json`)
  const snapshot =
    suite === "matching"
      ? vi.spyOn(versions, "probeSuiteSnapshot").mockReturnValue({
          ...parseSuiteManifest(manifestPath, readFileSync(manifestPath, "utf8")),
          sourcePaths: [relative(dirname(CONTENT), input)],
        })
      : undefined
  const planner = vi.spyOn(admission, "planAdmission").mockImplementation(() => {
    throw new Error("Development must not plan admission")
  })
  const writer = vi.spyOn(admission, "admitRun").mockImplementation(() => {
    throw new Error("Development must not write admission")
  })
  const collector = vi.spyOn(headless, "collectHeadlessRuns").mockImplementation(async (_selectors, output) => {
    if (!output) throw new Error("collection requires a private output directory")
    mkdirSync(output, { recursive: true })
    const raw = join(output, "xtermjs.json")
    writeFileSync(raw, bytes)
    // Use a private source canary: the failure must not delete or rewrite a real checkout input.
    if (inputChange === "remove") rmSync(input)
    if (inputChange === "rewrite") writeFileSync(input, "changed private suite input")
    if (inputChange === "blocked-hosted") writeFileSync(join(dirname(output), "hosted"), "private obstruction")
    if (inputChange === "blocked-macos") {
      mkdirSync(join(dirname(output), "hosted"))
      writeFileSync(join(dirname(output), "hosted", "macos"), "private obstruction")
    }
    return { directory: output, requested: ENGINE_BACKENDS, runs: [raw], failures: [] }
  })
  // The real launcher owns containers and receipts. Its process boundary is replaced here;
  // a failed Kitty launch and other malformed raw outputs must remain separate, retained failures.
  const launcher = vi.spyOn(childProcesses, "spawnSync").mockImplementation((command, args, options) => {
    if (!Array.isArray(args)) throw new Error("expected explicit Linux launcher argv")
    const stdio = options?.stdio
    const respond = (stdout: string, status = 0) => {
      if (Array.isArray(stdio) && typeof stdio[1] === "number") writeSync(stdio[1], stdout)
      return { pid: 1, output: [], stdout: "", stderr: "", status, signal: null }
    }
    if (command === "git") {
      if (args[0] === "symbolic-ref") return respond("fixture-collection\n")
      if (args[0] === "ls-remote") return respond(`${raw.sourceRevision}\trefs/heads/fixture-collection\n`)
      throw new Error(`unexpected Git command ${args.join(" ")}`)
    }
    if (command === "gh") {
      if (args[0] === "workflow") {
        return respond(
          `https://github.com/beorn/terminfo.dev/actions/runs/${args[2] === "macos-measurement.yml" ? "9001" : "9002"}\n`,
        )
      }
      const mac = args[2] === "9001"
      if (args[1] === "view") {
        return respond(
          JSON.stringify({
            headSha: suite === "different" ? "0".repeat(40) : raw.sourceRevision,
            headBranch: "fixture-collection",
            event: "workflow_dispatch",
            workflowName: mac ? "macos-measurement" : "windows-measurement",
          }),
        )
      }
      if (args[1] === "watch") return respond("workflow fixture result", mac ? 0 : 1)
      if (args[1] === "download") {
        const artifacts = args[args.indexOf("--dir") + 1]
        if (typeof artifacts !== "string") throw new Error("expected hosted artifact output directory")
        for (const id of mac ? ["terminal-app", "iterm2", "ghostty", "alacritty"] : ["windows-terminal"]) {
          const folder = join(artifacts, `${mac ? "macos" : "win32"}-${id}-${args[2]}-1`)
          mkdirSync(folder, { recursive: true })
          writeFileSync(join(folder, "run.json"), "{}")
          writeFileSync(
            join(folder, "collector-bun.lock"),
            id === "terminal-app" ? "wrong lock" : readFileSync(join(CONTENT, "../bun.lock")),
          )
          writeFileSync(
            join(folder, "collector-build.json"),
            JSON.stringify({
              collectorRevision: raw.sourceRevision,
              probeHash: raw.probeHash,
              bundleSha256: createHash("sha256").update("fixture collector bundle").digest("hex"),
            }),
          )
          writeFileSync(join(folder, "collector-bundle.mjs"), "fixture collector bundle")
        }
        return respond("downloaded fixture artifacts")
      }
      throw new Error(`unexpected GitHub command ${args.join(" ")}`)
    }
    const output = args.at(-1)
    if (typeof output !== "string") throw new Error("expected private Linux output directory")
    const isKitty = args.includes("kitty")
    if (!isKitty) {
      const raw = join(output, "fixture-run", "raw")
      mkdirSync(raw, { recursive: true })
      writeFileSync(join(raw, "v2-run.json"), "{}")
    }
    if (Array.isArray(stdio) && typeof stdio[2] === "number") writeSync(stdio[2], "launcher fixture diagnostic")
    return { pid: 1, output: [], stdout: "", stderr: "", status: isKitty ? 17 : 0, signal: null }
  })
  try {
    const pass = await collectPass(directory)
    expect(pass.mode).toBe("development")
    expect(pass.contexts).toHaveLength(33)
    const engine = pass.contexts.find((row) => row.context.kind === "headless" && row.context.id === "xtermjs")
    if (suite === "different") {
      expect(engine?.status).toBe("failed")
      expect(engine?.error).toMatch(/xtermjs.*unknown suite 267a5d166f08; missing trusted manifest/)
    } else {
      expect(engine?.status, engine?.error).toBe("classified")
      expect(engine?.classification?.mode).toBe("development")
      expect(engine?.classification?.states["extensions.osc2-title"]).toBe("supported")
    }
    expect(engine?.rawRun && readFileSync(engine.rawRun, "utf8")).toBe(bytes)
    expect(JSON.parse(readFileSync(join(pass.directory, "pass.json"), "utf8"))).toEqual(pass)
    if (inputChange === "rewrite" || inputChange === "remove") {
      expect(pass.errors.some((error) => error.includes(input) && /changed|ENOENT/.test(error))).toBe(true)
    }
    expect(collector).toHaveBeenCalledTimes(1)
    expect(launcher.mock.calls.filter(([command]) => command === "bash")).toHaveLength(5)
    for (const id of Object.keys(LEDGER)) {
      const row = pass.contexts.find(
        (entry) => entry.context.kind === "app" && entry.context.id === id && entry.context.os === "linux",
      )
      const output = join(pass.directory, "linux", id)
      expect(launcher).toHaveBeenCalledWith(
        "bash",
        [
          "scripts/linux-container-run.sh",
          "--target",
          id,
          "--preset",
          id === "kitty" ? "current" : "default",
          "--clipboard-profile",
          "default",
          output,
        ],
        expect.anything(),
      )
      expect(row?.status).toBe("failed")
      expect(row?.error).toContain(`${id}/linux`)
      expect(readFileSync(join(output, "launcher.stderr.log"), "utf8")).toBe("launcher fixture diagnostic")
      if (id === "kitty") expect(row?.error).toMatch(/exited 17/)
      else expect(row?.rawRun && readFileSync(row.rawRun, "utf8")).toBe("{}")
    }
    expect(planner).not.toHaveBeenCalled()
    expect(writer).not.toHaveBeenCalled()
    expect(readFileSync(original, "utf8")).toBe(originalBytes)
    if (inputChange === "blocked-hosted" || inputChange === "blocked-macos") {
      const affected = pass.contexts.filter(
        (row) =>
          row.context.route === "hosted-workflow" && (inputChange === "blocked-hosted" || row.context.os === "macos"),
      )
      expect(affected).toHaveLength(inputChange === "blocked-hosted" ? 5 : 4)
      expect(affected.every((row) => row.status === "failed" && row.error?.includes("EEXIST"))).toBe(true)
      expect(launcher.mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === "workflow")).toHaveLength(
        inputChange === "blocked-hosted" ? 0 : 1,
      )
      return
    }
    for (const os of ["macos", "windows"]) {
      expect(launcher).toHaveBeenCalledWith(
        "gh",
        ["workflow", "run", `${os}-measurement.yml`, "--repo", "beorn/terminfo.dev", "--ref", "fixture-collection"],
        expect.anything(),
      )
      const hosted = pass.contexts.filter((row) => row.context.route === "hosted-workflow" && row.context.os === os)
      expect(hosted).toHaveLength(os === "macos" ? 4 : 1)
      if (suite === "different") expect(hosted.every((row) => row.error?.includes("source revision"))).toBe(true)
    }
    expect(launcher.mock.calls.filter(([, args]) => Array.isArray(args) && args[0] === "workflow")).toHaveLength(2)
    if (suite === "matching") {
      // Remote platforms must start independently before either wait can block the other dispatch.
      const dispatch = launcher.mock.calls.findLastIndex(
        ([command, args]) => command === "gh" && Array.isArray(args) && args[0] === "workflow",
      )
      const wait = launcher.mock.calls.findIndex(
        ([command, args]) => command === "gh" && Array.isArray(args) && args[1] === "watch",
      )
      expect(wait, "both platform workflows dispatch before waiting").toBeGreaterThan(dispatch)
      expect(launcher).toHaveBeenCalledWith(
        "gh",
        [
          "run",
          "download",
          "9002",
          "--repo",
          "beorn/terminfo.dev",
          "--dir",
          join(pass.directory, "hosted", "windows", "artifacts"),
        ],
        expect.anything(),
      )
      expect(pass.errors.some((error) => error.includes("windows-measurement") && error.includes("exited 1"))).toBe(
        true,
      )
      const mac = pass.contexts.find((row) => row.context.id === "terminal-app")
      expect(mac?.error).toMatch(/dependency lock/)
      const windows = pass.contexts.find((row) => row.context.id === "windows-terminal")
      expect(windows?.rawRun && readFileSync(windows.rawRun, "utf8")).toBe("{}")
      expect(windows?.error).toContain("run.json: missing backend/terminal")
    }
  } finally {
    collector.mockRestore()
    launcher.mockRestore()
    planner.mockRestore()
    writer.mockRestore()
    snapshot?.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("release 1 collection census", () => {
  it("covers every catalog app/mux platform plus the engine family, with no missing or duplicate context", () => {
    const all = census()
    // full-census.test.ts owns membership. This boundary owns route coverage and the actual CLI.
    const contexts = all.map((entry) => `${entry.kind}:${entry.id}/${entry.os}`)
    expect(new Set(contexts).size).toBe(33)
    expect(all.filter((entry) => entry.kind === "app")).toHaveLength(18)
    expect(all.filter((entry) => entry.kind === "mux")).toHaveLength(4)
    expect(all.filter((entry) => entry.kind === "headless")).toHaveLength(11)
    expect(all).toHaveLength(33)
    // The CLI ledger must name the mux population as well; this is the real stdout boundary.
    const command = spawnSync(process.execPath, ["scripts/release1-collection.ts", "--plan"], {
      cwd: dirname(CONTENT),
      encoding: "utf8",
    })
    expect(command.status, command.stderr).toBe(0)
    expect(command.stdout.split("\n")[0]).toContain("18 app, 4 mux, 11 headless")
  }, 30_000)

  it("refuses a manifest that is not the eleven engines the collector asserts", () => {
    expect(() => census(ENGINE_BACKENDS.slice(0, 10))).toThrow(/Expected 11 headless engines/)
    expect(() => census([...ENGINE_BACKENDS, "extra"])).toThrow(/Expected 11 headless engines/)
    expect(() => census([...ENGINE_BACKENDS.slice(0, -1), "not-in-catalog"])).toThrow(
      /engine membership differs.*not-in-catalog/s,
    )
  })

  it("names every context that has no route instead of dropping it", () => {
    const all = census()
    const windows = all.find((entry) => entry.id === "windows-terminal")
    // Windows is collectable: windows-measurement.yml is a hosted workflow that produced an
    // admissible row at db5558cf8d6c (run 38074622083), so the old "no owner and no hosted
    // workflow yet" gap is gone and the row carries a route and its dispatch command.
    expect(windows?.route).toBe("hosted-workflow")
    expect(windows?.command).toMatch(
      /gh workflow run windows-measurement\.yml --repo beorn\/terminfo\.dev --ref <exact-source-ref>/,
    )
    expect(windows?.uncollectable).toBeNull()
    for (const entry of all) {
      if (entry.route === null) expect(entry.uncollectable).not.toBeNull()
      else expect(entry.command).toBeTruthy()
    }
  })

  it("retains every missing app route as required work, never inventing a hosted dispatch", () => {
    // The workflow's matrix is terminal-app/iterm2/ghostty/alacritty only — there is no kitty job — and
    // Chief bbf8eff9 retains all eight unresolved routes as expected work; no old ship-as-measured cut applies.
    const kitty = census().find((entry) => entry.id === "kitty" && entry.os === "macos")
    expect(kitty?.route).toBeNull()
    expect(kitty?.command).toBeNull()
    expect(kitty?.uncollectable).toMatch(/required route work/)
    const missing = census().filter((entry) => entry.route === null)
    expect(missing).toHaveLength(8)
    expect(missing.every((entry) => entry.uncollectable?.includes("required route work"))).toBe(true)
    for (const id of ["terminal-app", "iterm2", "ghostty", "alacritty"]) {
      expect(census().find((entry) => entry.id === id && entry.os === "macos")?.route).toBe("hosted-workflow")
    }
  })

  it("names each context that produced no run, with its own reason", () => {
    const all = census()
    const uncovered = uncoveredContexts(all, [cleanRun()])
    expect(uncovered).toHaveLength(32)
    expect(uncovered.find((entry) => entry.context.id === "windows-terminal")?.reason).toMatch(
      /no run produced by the hosted-workflow route/,
    )
    expect(uncovered.find((entry) => entry.context.id === "kitty" && entry.context.os === "linux")?.reason).toMatch(
      /linux-container/,
    )
    // A produced run carries the os it was MEASURED on: an app its own, a headless engine the host's.
    const measured = all.map((entry) =>
      cleanRun({ target: { kind: entry.kind, id: entry.id, os: entry.kind === "headless" ? "linux" : entry.os } }),
    )
    expect(uncoveredContexts(all, measured)).toHaveLength(0)
  })

  it("credits an admitted headless engine run to its engine row, whatever host os it records (#27929 D7)", () => {
    // The census keys an engine row at os "unknown", while the run itself records the host it ran on
    // ("linux"), so a key of id/os matched no headless run and every engine row read "no run produced"
    // right after its run was admitted (rehearsed on 950882d4f34d, xtermjs 7866d892).
    const all = census()
    const headless = cleanRun({ target: { kind: "headless", id: "xtermjs", os: "linux" } })
    const uncovered = uncoveredContexts(all, [headless]).map((entry) => `${entry.context.kind}:${entry.context.id}`)
    expect(uncovered).not.toContain("headless:xtermjs")
    expect(uncovered).toContain("app:xterm")
    expect(uncovered).toHaveLength(32)
  })

  it("leaves a Linux row uncollectable, named, when no committed run can be read", () => {
    const all = release1Census(ENGINE_BACKENDS, { ...LEDGER, kitty: undefined as never })
    const kitty = all.find((entry) => entry.id === "kitty" && entry.os === "linux")
    expect(kitty?.route).toBe("linux-container")
    expect(kitty?.command).toBeNull()
    expect(kitty?.uncollectable).toMatch(/no committed run to read the launcher flags from/)
  })
})

describe("release 1 Linux launcher flags", () => {
  it("reads the clipboard profile back from the permissions the launcher wrote", () => {
    expect(clipboardProfileFor(null, "kitty/linux")).toBe("default")
    expect(clipboardProfileFor(undefined, "kitty/linux")).toBe("default")
    expect(clipboardProfileFor("clipboard: read=allow,write=allow", "kitty/linux")).toBe("allow")
    expect(clipboardProfileFor("clipboard: read=deny,write=allow", "kitty/linux")).toBe("deny-read")
    expect(() => clipboardProfileFor("clipboard: read=ask,write=allow; OSC52=not-run", "kitty/linux")).toThrow(
      /not one the launcher declares/,
    )
  })

  it("gives kitty a preset and every other target the only one the launcher accepts", () => {
    expect(presetFor("kitty", "0.49.2")).toBe("current")
    expect(presetFor("kitty", "0.46.2")).toBe("baseline")
    expect(() => presetFor("kitty", "")).toThrow(/records no version/)
    expect(presetFor("alacritty", "0.17.0")).toBe("default")
    expect(presetFor("xterm", "411")).toBe("default")
  })

  // linuxLedger reads the whole committed corpus, which grows with every admitted run, so this row carries the
  // budget the corpus-reading consumer-selection rows use (CI took 5054 ms against the 5000 ms default).
  it("reads the five Linux invocations back from the committed runs in the corpus", () => {
    // Retiring the old freeze preference leaves multiple current Kitty profiles. Refuse the
    // real ambiguity before exercising launcher readback on an explicit historical witness.
    const ambiguous = buildReport({ contentDir: CONTENT }).barRows.find(
      (row) => row.context.os === "linux" && !row.measured && row.reason.includes("ambiguous current selection"),
    )
    const liveLedger = ambiguous ? undefined : linuxLedger(CONTENT)
    if (ambiguous) {
      expect(() => linuxLedger(CONTENT)).toThrow(
        new RegExp(`${ambiguous.context.terminalId}/linux:.*more than one run.*refusing to guess`),
      )
    }
    const fixture = mkdtempSync(join(tmpdir(), "release1-historical-launchers-"))
    const historicalSuite = vi.spyOn(versions, "probeHash").mockReturnValue("c3d1fbb77561")
    try {
      for (const name of readdirSync(CONTENT)) {
        if (name !== "suites") symlinkSync(join(CONTENT, name), join(fixture, name))
      }
      mkdirSync(join(fixture, "suites"))
      for (const name of readdirSync(join(CONTENT, "suites"))) {
        const path = join(CONTENT, "suites", name)
        const manifest = { ...parseSuiteManifest(path, readFileSync(path, "utf8")) }
        delete manifest.freeze
        // Restore only the historical fixture's declaration, as committed at d7c37731.
        if (name === "c3d1fbb77561.json") {
          manifest.freeze = { release: "candidate2", at: "2026-10-12T03:33:42.000Z" }
        }
        writeFileSync(join(fixture, "suites", name), JSON.stringify(manifest))
      }
      // Every measured run and policy remains byte-identical to the complete committed corpus.
      const ledger = linuxLedger(fixture)
      expect(ledger.kitty?.runId).toBe("dfd4cd08416fb5f3be3eaeed5acce782")
      expect(Object.keys(ledger).sort()).toEqual(["alacritty", "ghostty", "kitty", "wezterm", "xterm"])
      // Every assertion here is a property of the READ-BACK, not of today's corpus: which run the site
      // selects changes as clean runs land (alacritty and wezterm linux moved from excluded to selected
      // while this change was in flight), so a test that pinned that would fail for a non-regression.
      for (const [id, row] of [...Object.entries(ledger), ...Object.entries(liveLedger ?? {})]) {
        expect(row.version).not.toBe("")
        expect(row.file).toMatch(/^probes-apps\/.+-linux-.+\.json$/)
        expect(existsSync(join(CONTENT, row.file))).toBe(true)
        expect(["default", "allow", "deny-read"]).toContain(row.clipboardProfile)
        expect(["default", "baseline", "current"]).toContain(row.preset)
        // A row outside the site's selection must name why it is; a selected row carries no exclusion.
        if (row.selection === "newest-admitted") expect(row.exclusion).toBeTruthy()
        else expect(row.exclusion).toBeNull()
        if (id === "kitty") expect(row.preset).not.toBe("default")
      }
    } finally {
      historicalSuite.mockRestore()
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 30_000)

  it("puts the read flags into the row's command", () => {
    const all = census()
    const kitty = all.find((entry) => entry.id === "kitty" && entry.os === "linux")
    expect(kitty?.command).toBe(
      "bash scripts/linux-container-run.sh --target kitty --preset current --clipboard-profile default <outdir>",
    )
    expect(kitty?.sourceRun).toMatch(/\(site-selected\)$/)
    const alacritty = all.find((entry) => entry.id === "alacritty" && entry.os === "linux")
    expect(alacritty?.sourceRun).toMatch(/\((?:site-selected|newest-admitted — the site excludes it: .+)\)$/)
  })
})

// Requirement: admission is the only authority for coverage credit. The former pure refusal
// cases never invoked the owner, so they missed a caller ignoring an admission rejection.
describe("release collection hands every produced run to the admission owner", () => {
  const source = "/private/produced-xterm.json"
  const frozenSuiteId = "frozen01"
  const plan: admission.AdmissionPlan = {
    source,
    destination: "/private/admitted-xterm.json",
    probeHash: frozenSuiteId,
    target: { kind: "app", id: "xterm", version: "411", os: "linux" },
    runId: "c3".repeat(16),
  }
  it.each([frozenSuiteId, undefined])(
    "credits the owner's target after candidate2 admission with assertion %s",
    (assertedSuiteId) => {
      const planner = vi.spyOn(admission, "planAdmission").mockReturnValue(plan)
      const writer = vi.spyOn(admission, "admitRun").mockReturnValue({
        manifest: "existing",
        run: "created",
        screenshots: { created: 0, existing: 0 },
        textSnapshots: { created: 0, existing: 0 },
        receipt: { placed: "none", detail: "fixture" },
      })
      try {
        const produced = admitProducedRuns([source], assertedSuiteId)
        expect(planner).toHaveBeenCalledWith(source, undefined, {
          release: "candidate2",
          ...(assertedSuiteId === undefined ? {} : { frozenSuiteId: assertedSuiteId }),
        })
        expect(writer).toHaveBeenCalledWith(plan)
        expect(produced).toEqual([{ target: plan.target }])
        expect(
          uncoveredContexts(census(), produced).some(({ context }) => context.id === "xterm" && context.os === "linux"),
        ).toBe(false)
      } finally {
        planner.mockRestore()
        writer.mockRestore()
      }
    },
  )
  it.each([
    ["planning", 1],
    ["planning", 2],
    ["placement", 1],
    ["placement", 2],
  ] as const)(
    "plans every input before placement, retaining partial progress for %s failure at %s",
    (phase, failureAt) => {
      const rejection = new Error("Owner refused xterm/linux: required receipt is absent")
      let planned = 0
      let placed = 0
      const planner = vi.spyOn(admission, "planAdmission").mockImplementation(() => {
        planned += 1
        if (phase === "planning" && planned === failureAt) throw rejection
        return plan
      })
      const writer = vi.spyOn(admission, "admitRun").mockImplementation(() => {
        placed += 1
        if (phase === "placement" && placed === failureAt) throw rejection
        return {
          manifest: "existing",
          run: "created",
          screenshots: { created: 0, existing: 0 },
          textSnapshots: { created: 0, existing: 0 },
          receipt: { placed: "none", detail: "fixture" },
        }
      })
      const progress = vi.fn()
      try {
        let produced: ProducedRun[] | undefined
        let failure: unknown
        try {
          produced = admitProducedRuns([source, "/private/later.json"], frozenSuiteId, "candidate2", progress)
        } catch (error) {
          failure = error
        }
        expect(failure).toBe(rejection)
        expect(produced).toBeUndefined()
        expect(planner).toHaveBeenCalledTimes(phase === "planning" ? failureAt : 2)
        expect(writer).toHaveBeenCalledTimes(phase === "planning" ? 0 : failureAt)
        expect(progress).toHaveBeenCalledTimes(phase === "placement" ? failureAt - 1 : 0)
      } finally {
        planner.mockRestore()
        writer.mockRestore()
      }
    },
  )
})

it("requires an existing declared freeze before final collection dispatch", () => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-final-missing-freeze-"))
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release1-collection.ts",
        "--collect",
        "--admit",
        "--frozen-suite",
        "000000000000",
        "--output",
        directory,
      ],
      { cwd: dirname(CONTENT), encoding: "utf8" },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("declared frozen suite 000000000000")
    expect(readdirSync(directory)).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
