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
import { basename, dirname, join, relative } from "node:path"
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
import { afterAll, describe, expect, it, vi } from "vitest"
import * as admission from "./admit-run.ts"
import * as catalog from "@terminfo/catalog"
import { parseRun, parseSuiteManifest } from "@terminfo/run-parser"
import * as versions from "../packages/admin/versions.ts"
import { frozenSuiteIdFor } from "../packages/admin/suite-manifest.ts"
import * as headless from "../packages/probes/collect-headless.ts"
import { textQualificationFixtures } from "@terminfo/probe-defs"
import { classifyDevelopmentRun } from "../docs/data/selected-results.ts"
import { buildReport } from "./decisive-share.ts"
import {
  admitProducedRuns,
  collectPass,
  clipboardProfileFor,
  linuxLedger,
  ownedAppCommand,
  ownedAppRunsDirectory,
  presetFor,
  readOwnedAppTransportProof,
  release1Census,
  uncoveredContexts,
  type CollectionContext,
  type LinuxLedger,
  type ProducedRun,
} from "./release1-collection.ts"

// Standalone checkouts have no superproject inputs; retain real hashing over private fixture bytes.
const fingerprintFixture = await vi.hoisted(async () => {
  const fs = await import("node:fs")
  const { join, resolve, dirname } = await import("node:path")
  const { tmpdir } = await import("node:os")
  const { fileURLToPath } = await import("node:url")
  const directory = fs.mkdtempSync(join(tmpdir(), "collection-fingerprint-"))
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const files = Object.fromEntries(
    ["bun.lock", "flake.lock", "flake.nix"].map((name) => {
      const fixture = join(directory, name)
      fs.writeFileSync(fixture, `private collection fingerprint fixture: ${name}\n`)
      return [resolve(root, "../..", name), fixture]
    }),
  )
  return { directory, files }
})
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    readFileSync: ((
      path: Parameters<typeof actual.readFileSync>[0],
      options?: Parameters<typeof actual.readFileSync>[1],
    ) => {
      const input = typeof path === "string" ? (fingerprintFixture.files[path] ?? path) : path
      return options === undefined ? actual.readFileSync(input) : actual.readFileSync(input, options)
    }) as typeof actual.readFileSync,
  }
})
afterAll(() => rmSync(fingerprintFixture.directory, { recursive: true, force: true }))

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

// Refusal must precede filesystem effects; census and private-success cases never used repository output.
it("refuses repository output before creating any directory", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "collection-output-refusal-"))
  const repositoryScratch = join(dirname(CONTENT), basename(scratch))
  const output = join(repositoryScratch, "not-created")
  try {
    expect(existsSync(repositoryScratch)).toBe(false)
    await expect(collectPass(output)).rejects.toThrow(/output must be private, outside the source repository/)
    expect(existsSync(repositoryScratch)).toBe(false)
  } finally {
    // Only this fixture's unique scratch path; no source input is edited or removed.
    rmSync(repositoryScratch, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

// The census-only cases cannot prove that collection preserves its shared owner's resource error.
it("propagates an unsupported catalog kind from the census owner before dispatch", async () => {
  const terminals = { ...catalog.loadTerminals(CONTENT) }
  const kitty = terminals.kitty
  if (!kitty) throw new Error("The committed catalog fixture must contain kitty")
  terminals.kitty = { ...kitty }
  Reflect.set(terminals.kitty, "kind", "unsupported-fixture")
  const load = vi.spyOn(catalog, "loadTerminals").mockReturnValue(terminals)
  const directory = mkdtempSync(join(tmpdir(), "collection-unsupported-kind-"))
  const collector = vi.mocked(headless.collectHeadlessRuns)
  collector.mockClear()
  try {
    await expect(collectPass(directory)).rejects.toThrow(
      'kitty: kind "unsupported-fixture" is not an app, mux or headless context',
    )
    expect(collector).not.toHaveBeenCalled()
  } finally {
    load.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
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
  ["matching", "text-qualified"],
  ["matching", "text-missing"],
  ["matching", "text-modified"],
  ["frozen", "none"],
] as const)("retains a private %s-suite pass after %s without admission", async (suite, inputChange) => {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-development-pass-"))
  const input = join(directory, "suite-input.ts")
  writeFileSync(input, "original private suite input")
  const original = join(CONTENT, "probes-libs/xtermjs-6.0.0-linux-c19905bf-2d90-474c-9e1a-13805bb3c0c4.json")
  const originalBytes = readFileSync(original, "utf8")
  const raw = JSON.parse(originalBytes) as { probeHash: string; sourceRevision: string }
  raw.sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirname(CONTENT), encoding: "utf8" }).trim()
  const bytes = JSON.stringify(raw)
  const frozenSuite = suite === "frozen" ? frozenSuiteIdFor(CONTENT, "candidate2") : undefined
  const textCase = inputChange.startsWith("text-")
  const manifestPath = join(CONTENT, "suites", `${frozenSuite ?? raw.probeHash}.json`)
  const snapshot =
    suite !== "different"
      ? vi.spyOn(versions, "probeSuiteSnapshot").mockReturnValue({
          ...parseSuiteManifest(manifestPath, readFileSync(manifestPath, "utf8")),
          ...(textCase && {
            probes: {
              app: ["text.overwrite"],
              headless: parseSuiteManifest(manifestPath, readFileSync(manifestPath, "utf8")).probes.headless,
              mux: [],
            },
            textClaims: ["text.overwrite"],
            textQualification: { version: 1, recipe: "macos-text-cells-v1" },
          }),
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
        for (const id of mac
          ? ["terminal-app", "iterm2", "ghostty", "alacritty", "wezterm", "cursor", "com.microsoft.VSCode"]
          : ["windows-terminal", "alacritty"]) {
          const folder = join(artifacts, `${mac ? "macos" : "win32"}-${id}-${args[2]}-1`)
          mkdirSync(folder, { recursive: true })
          writeFileSync(join(folder, "run.json"), "{}")
          // 30035: exercise the actual development collection boundary, including its retained bytes.
          // The recipe itself is tested independently; this case proves the caller passes verified context.
          if (textCase && id === "terminal-app") {
            const fixtureRows = textQualificationFixtures(4, 12)
            if (typeof fixtureRows === "string") throw new Error(fixtureRows)
            const artifactsDirectory = join(folder, "artifacts")
            mkdirSync(artifactsDirectory)
            const refs = new Set<string>()
            let capturedAt = 0
            const frame = (rows: readonly string[], role: "control" | "target") => {
              const bytes = Buffer.from(rows.join("\n"), "utf8")
              const ref = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
              refs.add(ref)
              writeFileSync(join(artifactsDirectory, `${ref.slice(7)}.txt`), bytes)
              return {
                kind: "text-cells",
                role,
                ref,
                capturedAt: ++capturedAt,
                label: role,
                cellDigest: ref,
                frameDigest: ref,
                cellRectangle: { top: 1, left: 1, bottom: 4, right: 12 },
              }
            }
            const shapes = fixtureRows.map((entry) => ({
              shape: entry.shape,
              frames: [frame(entry.controlRows, "control"), frame(entry.targetRows, "target")],
            }))
            const frames = shapes[0]!.frames
            const featureId = "text.overwrite"
            const appRun = {
              ...raw,
              runId: "qualified-development-text",
              target: {
                kind: "app",
                id,
                version: "1.0.0",
                os: "macos",
                osVersion: null,
                outerTerminal: null,
                mux: null,
                config: null,
                permissions: null,
              },
              runtimeIdentity: undefined,
              provenance: undefined,
              identity: "unverified",
              origin: { kind: "collector" },
              rawReplies: { [featureId]: "retained comparison" },
              notTested: [],
              assertions: [
                {
                  featureId,
                  kind: "positive",
                  rawReplyRef: featureId,
                  expected: "characters",
                  observed: frames[1]!.ref,
                },
              ],
              observations: [{ featureId, outcome: "supported", evidence: "text", rawReplyRef: featureId, frames }],
              screenshotRefs: [],
              textSnapshotRefs: [...refs],
              textQualification: { version: 1, recipe: "macos-text-cells-v1", grid: { rows: 4, cols: 12 }, shapes },
            }
            writeFileSync(join(folder, "run.json"), JSON.stringify(appRun))
            const artifact = join(artifactsDirectory, `${[...refs][0]!.slice(7)}.txt`)
            if (inputChange === "text-missing") rmSync(artifact)
            if (inputChange === "text-modified") writeFileSync(artifact, "modified retained bytes")
          }
          writeFileSync(
            join(folder, "collector-bun.lock"),
            id === "terminal-app" && !textCase ? "wrong lock" : readFileSync(join(CONTENT, "../bun.lock")),
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
    const pass = await collectPass(directory, frozenSuite)
    expect(pass.mode).toBe(frozenSuite ? "admit" : "development")
    if (frozenSuite) expect(pass.freeze?.id).toBe(frozenSuite)
    expect(pass.contexts).toHaveLength(33)
    if (textCase) {
      const terminal = pass.contexts.find(
        (row) => row.context.kind === "app" && row.context.id === "terminal-app" && row.context.os === "macos",
      )
      if (inputChange === "text-qualified") {
        expect(terminal?.status, terminal?.error).toBe("classified")
        expect(terminal?.classification?.states["text.overwrite"]).toBe("supported")
      } else {
        expect(terminal?.status).toBe("failed")
        expect(terminal?.error).toMatch(
          inputChange === "text-missing" ? /missing text snapshot artifact.*artifacts/u : /Text snapshot.*hashes to/u,
        )
      }
    }
    const engine = pass.contexts.find((row) => row.context.kind === "headless" && row.context.id === "xtermjs")
    if (suite === "different" || suite === "frozen") {
      expect(engine?.status).toBe("failed")
      expect(engine?.error).toMatch(/xtermjs.*unknown suite 267a5d166f08; missing trusted manifest/)
    } else {
      expect(engine?.status, engine?.error).toBe("classified")
      expect(engine?.classification?.mode).toBe("development")
      expect(engine?.classification?.states["extensions.osc2-title"]).toBe("supported")
    }
    expect(engine?.rawRun && readFileSync(engine.rawRun, "utf8")).toBe(bytes)
    expect(JSON.parse(readFileSync(join(pass.directory, "pass.json"), "utf8"))).toEqual(pass)
    if (suite === "matching" && inputChange === "none") {
      // Catalog scope and executed launcher/flake bytes must be reproducible from the private receipt.
      for (const path of [
        join(CONTENT, "features.json"),
        join(CONTENT, "../scripts/linux-container-run.sh"),
        join(CONTENT, "../../../flake.nix"),
      ]) {
        expect(pass.inputSha256[path], path).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"))
      }
    }
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
      expect(affected).toHaveLength(inputChange === "blocked-hosted" ? 11 : 8)
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
      expect(hosted).toHaveLength(os === "macos" ? 8 : 3)
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
      if (!textCase) expect(mac?.error).toMatch(/dependency lock/)
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

  it("compares the manifest's engine set with the catalog's instead of a hardcoded count", () => {
    // The catalog is the authority on how many engines exist; a dropped or added engine still
    // shows up by name, which is the check that prevents silently publishing a different family
    // (28385, area 15).
    expect(() => census(ENGINE_BACKENDS.slice(0, 10))).toThrow(/Catalog\/Termless engine membership differs/s)
    expect(() => census([...ENGINE_BACKENDS, "extra"])).toThrow(/engine membership differs.*extra/s)
    expect(() => census([...ENGINE_BACKENDS.slice(0, -1), "not-in-catalog"])).toThrow(
      /engine membership differs.*not-in-catalog/s,
    )
    expect(census([...ENGINE_BACKENDS])).toHaveLength(33)
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
    const alacrittyWin = all.find((entry) => entry.id === "alacritty" && entry.os === "windows")
    expect(alacrittyWin?.route).toBe("hosted-workflow")
    expect(alacrittyWin?.command).toMatch(/win32-alacritty-<run-id>-<attempt>/)
    expect(alacrittyWin?.uncollectable).toBeNull()
    for (const entry of all) {
      if (entry.route === null) expect(entry.uncollectable).not.toBeNull()
      else expect(entry.command).toBeTruthy()
    }
  })

  it("retains every missing app route as required work, never inventing a hosted dispatch", () => {
    // The workflow's matrix includes Warp and both editors alongside the existing five macOS apps and
    // windows-terminal/alacritty/wezterm on windows.
    // All remaining unresolved routes stay recorded as expected route work. kitty/macos is one of
    // them, with its own measured reason: the hosted runner has no usable OpenGL, so kitty opens no
    // window there (run 39302236007), and its owned codimac run was unadmitted for the missing
    // capture adapter. The reason is a fact, not a silent gap.
    const kitty = census().find((entry) => entry.id === "kitty" && entry.os === "macos")
    expect(kitty?.route).toBeNull()
    expect(kitty?.command).toBeNull()
    expect(kitty?.requires).toBeNull()
    expect(kitty?.sourceRun).toBe("39302236007")
    expect(kitty?.uncollectable).toMatch(/not measurable on the hosted runner.*39302236007/)
    const missing = census().filter((entry) => entry.route === null)
    expect(missing).toHaveLength(2)
    expect(missing.filter((entry) => entry.uncollectable?.includes("required route work"))).toHaveLength(1)
    for (const id of [
      "terminal-app",
      "iterm2",
      "ghostty",
      "alacritty",
      "wezterm",
      "cursor",
      "com.microsoft.VSCode",
      "warp",
    ]) {
      expect(census().find((entry) => entry.id === id && entry.os === "macos")?.route).toBe("hosted-workflow")
    }
    for (const id of ["windows-terminal", "alacritty", "wezterm"]) {
      expect(census().find((entry) => entry.id === id && entry.os === "windows")?.route).toBe("hosted-workflow")
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

  it("reads the same kitty/linux run on the site bar and in the census, through one reviewed lookup", () => {
    // One home per truth: the bar's per-context row and the census ledger both resolve the reviewed
    // row through `reviewedContextFor`, so an os-qualified row (`app:kitty/linux`) cannot make the
    // census re-measure a run the site refuses to select.
    const bar = buildReport({ contentDir: CONTENT }).barRows.find(
      (row) => row.context.terminalId === "kitty" && row.context.os === "linux",
    )
    if (!bar?.measured) throw new Error("kitty/linux must be measured on the bar")
    const ledger = linuxLedger(CONTENT)
    // The reviewed row names a CONTEXT, not a run id: the newest admitted run inside that context is
    // the one both consumers read, so a re-collection must never need this test edited. Agreement is
    // the assertion; the frozen-suite row keeps both of them on the suite candidate 2 counts.
    expect(ledger.kitty?.runId).toBe(bar.run.runId)
    expect(ledger.kitty?.selection).toBe("site-selected")
    expect(bar.run.suiteId).toBe(frozenSuiteIdFor(CONTENT, "candidate2"))
  }, 30_000)

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

// A census-only missing-route row cannot catch the CLI returning success or entering admission.
it("fails collection by name and exit 1 for a required null route without admission", () => {
  const directory = mkdtempSync(join(tmpdir(), "collection-required-route-"))
  const preload = join(directory, "external-owners.ts")
  const admitted = join(directory, "admission-entered")
  const root = dirname(CONTENT)
  writeFileSync(
    preload,
    `
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
const fs = await import("node:fs");
const readFingerprintFile = fs.readFileSync;
const fingerprintFiles = ${JSON.stringify(fingerprintFixture.files)};
mock.module("node:fs", () => ({...fs, readFileSync: (path, ...args) => readFingerprintFile(typeof path === "string" ? fingerprintFiles[path] ?? path : path, ...args)}));
const processes = await import("node:child_process");
mock.module("node:child_process", () => ({...processes, spawnSync: () => ({ status: 1, stdout: "", stderr: "fixture external dispatch refused", signal: null })}));
mock.module(${JSON.stringify(join(dirname(CONTENT), "packages/probes/collect-headless.ts"))}, () => ({collectHeadlessRuns: async (_selectors, directory) => ({directory, runs: [], failures: []})}));
const refuseAdmission = () => { writeFileSync(${JSON.stringify(admitted)}, "unexpected admission"); throw new Error("development entered admission"); };
mock.module(${JSON.stringify(join(dirname(CONTENT), "scripts/admit-run.ts"))}, () => ({planAdmission: refuseAdmission, admitRun: refuseAdmission}));
`,
  )
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--preload",
        preload,
        "scripts/release1-collection.ts",
        "--collect",
        "--development",
        "--output",
        join(directory, "output"),
      ],
      { cwd: root, encoding: "utf8" },
    )
    expect(result.status, result.stderr).toBe(1)
    // kitty/macos now fails by name with its measured unmeasurable fact; a row that still has no
    // route (cmux) keeps the required-route-work refusal this test was written for.
    expect(result.stdout).toMatch(/kitty\/macos: failed.*not measurable on the hosted runner/)
    expect(result.stdout).toMatch(/cmux\/macos: failed.*required route work/)
    const passName = readdirSync(join(directory, "output"))[0]!
    const pass = JSON.parse(readFileSync(join(directory, "output", passName, "pass.json"), "utf8")) as Awaited<
      ReturnType<typeof collectPass>
    >
    expect(
      pass.contexts.find(
        (row: { context: { id: string; os: string } }) => row.context.id === "kitty" && row.context.os === "macos",
      ),
    ).toMatchObject({ status: "failed", error: expect.stringContaining("not measurable on the hosted runner") })
    expect(
      pass.contexts.find(
        (row: { context: { id: string; os: string } }) => row.context.id === "cmux" && row.context.os === "macos",
      ),
    ).toMatchObject({ status: "failed", error: expect.stringContaining("required route work") })
    expect(existsSync(admitted)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

const ownedAppContext: CollectionContext = {
  id: "kitty",
  os: "macos",
  kind: "app",
  route: "local-owned-app",
  command: "bun packages/admin/src/index.ts probe app kitty --output <private-output>",
  requires: null,
  sourceRun: null,
  uncollectable: null,
}
const ownedAppRevision = "c".repeat(40)

// The local route must stay byte-identical to the argv it always ran; the ssh route hands the
// SAME probe arguments to the transport driver after its own transport flags, never a second probe.
it("starts an owned-app row locally with the probe argv it always ran", () => {
  const command = ownedAppCommand(ownedAppContext, "/private/kitty", { runner: "local" }, ownedAppRevision)
  expect(command.label).toBe("kitty/macos owned-app collection")
  expect(command.argv).toEqual([
    "bun",
    "packages/admin/src/index.ts",
    "probe",
    "app",
    "kitty",
    "--output",
    "/private/kitty",
  ])
})

it("hands the identical probe argv to the ssh transport with environment-owned configuration", () => {
  const command = ownedAppCommand(
    ownedAppContext,
    "/private/kitty",
    {
      runner: "ssh:fixture@fixture.invalid",
      stage: "/remote/stage",
      knownHosts: "/home/fixture/.ssh/known_hosts",
      removeStage: true,
    },
    ownedAppRevision,
  )
  expect(command.label).toBe("kitty/macos owned-app transport")
  expect(command.argv.slice(0, 13)).toEqual([
    "bun",
    "scripts/owned-app-remote-run.ts",
    "--transport",
    "ssh:fixture@fixture.invalid",
    "--stage",
    "/remote/stage",
    "--output",
    "/private/kitty",
    "--source-revision",
    ownedAppRevision,
    "--context",
    "kitty",
    "--known-hosts",
  ])
  expect(command.argv).toContain("--remove-stage")
  expect(command.argv.slice(command.argv.indexOf("--"))).toEqual([
    "--",
    "bun",
    "packages/admin/src/index.ts",
    "probe",
    "app",
    "kitty",
  ])
})

it("hands the ssh transport no stage when none is supplied, so the driver derives it on the host", () => {
  const command = ownedAppCommand(
    ownedAppContext,
    "/private/kitty",
    { runner: "ssh:fixture@fixture.invalid", knownHosts: "/home/fixture/.ssh/known_hosts" },
    ownedAppRevision,
  )
  expect(command.argv).not.toContain("--stage")
  expect(command.argv.slice(0, 8)).toEqual([
    "bun",
    "scripts/owned-app-remote-run.ts",
    "--transport",
    "ssh:fixture@fixture.invalid",
    "--output",
    "/private/kitty",
    "--source-revision",
    ownedAppRevision,
  ])
})

it("refuses an ssh transport with no known-hosts file rather than inventing trust", () => {
  expect(() =>
    ownedAppCommand(
      ownedAppContext,
      "/private/kitty",
      { runner: "ssh:fixture@fixture.invalid", stage: "/remote/stage" },
      ownedAppRevision,
    ),
  ).toThrow(/requires --owned-app-known-hosts/)
})

// The collector's own argv builder, through the real driver, to the files the collector reads next:
// one run JSON in <output>/transport and a receipt bound to the collected revision. The run JSON is
// an existing producer fixture with its own trusted suite manifest, and it is parsed and classified
// here exactly as the collector classifies a run after transport.
it("runs the collector's ssh route through the driver and reads the run JSON it wrote", () => {
  const directory = mkdtempSync(join(tmpdir(), "transport-route-"))
  const code = join(directory, "code")
  const source = join(code, "vendor", "terminfo.dev")
  const shims = join(directory, "shims")
  const stage = join(directory, "remote", "stage")
  const knownHosts = join(directory, "known_hosts")
  const output = join(directory, "owned-app", "kitty")
  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
    return result.stdout.trim()
  }
  const shim = (name: string, body: string): void => {
    writeFileSync(join(shims, name), body, { mode: 0o755 })
  }
  for (const path of [
    source,
    shims,
    output,
    join(code, "vendor", "silvery"),
    join(code, "vendor", "termless"),
    join(code, "node_modules"),
  ]) {
    mkdirSync(path, { recursive: true })
  }
  writeFileSync(join(source, "package.json"), '{"name":"terminfo.dev","private":true}\n')
  mkdirSync(join(source, "packages", "admin", "src"), { recursive: true })
  writeFileSync(join(source, "packages", "admin", "src", "index.ts"), "export const probe = 'fixture'\n")
  git(source, "init", "-q", "-b", "main")
  git(source, "config", "user.email", "fixture@example.invalid")
  git(source, "config", "user.name", "fixture")
  git(source, "add", "-A")
  git(source, "commit", "-q", "-m", "fixture source")
  const revision = git(source, "rev-parse", "HEAD")
  for (const entry of ["package.json", "bun.lock", "tsconfig.json"]) {
    writeFileSync(join(code, entry), `fixture ${entry}\n`)
  }
  writeFileSync(join(code, "vendor", "silvery", "index.ts"), "export const silvery = 'fixture'\n")
  writeFileSync(join(code, "vendor", "termless", "index.ts"), "export const termless = 'fixture'\n")
  writeFileSync(knownHosts, "fixture.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZpeHR1cmVrZXk=\n")
  shim(
    "ssh",
    [
      "#!/bin/sh",
      "verbose=0",
      'for a in "$@"; do [ "$a" = "-v" ] && verbose=1; done',
      'while [ "$1" = "-o" ] || [ "$1" = "-F" ] || [ "$1" = "-l" ]; do shift 2; done',
      'while [ "$1" = "-v" ]; do shift; done',
      '[ "$1" = "--" ] && shift',
      "shift",
      "[ \"$verbose\" = 1 ] && echo 'debug1: Server host key: ssh-ed25519 SHA256:fixtureRoute' >&2",
      'exec /bin/sh -c "$*"',
    ].join("\n"),
  )
  shim(
    "rsync",
    [
      "#!/bin/sh",
      'REAL_RSYNC="${REAL_RSYNC:-/usr/bin/rsync}"',
      'if [ "$1" = "--server" ]; then exec "$REAL_RSYNC" "$@"; fi',
      '"$REAL_RSYNC" "$@"',
    ].join("\n"),
  )
  shim(
    "bun",
    [
      "#!/bin/sh",
      'case "$*" in',
      "  *identity.ts*) printf '%s' '{\"machineIdSha256\":\"aaaa\"}' ;;",
      "  --version) echo '1.2.3' ;;",
      "  *) out=''",
      '     while [ $# -gt 0 ]; do case "$1" in --output) shift; out="$1" ;; esac; shift; done',
      '     cp "$PRODUCER_RUN" "$out/kitty-0.48.2-macos.json" ;;',
      "esac",
    ].join("\n"),
  )
  shim("kitty", "#!/bin/sh\necho 'kitty 0.49.1'\n")
  const producerRun = join(CONTENT, "probes-apps", "kitty-0.48.2-macos.json")
  const producerBytes = readFileSync(producerRun)
  try {
    const command = ownedAppCommand(
      ownedAppContext,
      output,
      { runner: "ssh:fixture@fixture.invalid", stage, knownHosts },
      revision,
    )
    // argv[0] is the `bun` token the collector resolves from PATH; here the runner is this process,
    // so only the driver path and its arguments are passed.
    const result = spawnSync(process.execPath, command.argv.slice(1), {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        PATH: `${shims}:/usr/bin:/bin`,
        OWNED_APP_TRANSPORT_SOURCE_ROOT: source,
        OWNED_APP_TRANSPORT_RESOURCE_ROOT: code,
        OWNED_APP_TRANSPORT_KITTY_PATH: join(shims, "kitty"),
        PRODUCER_RUN: producerRun,
        REAL_RSYNC: "/usr/bin/rsync",
      },
    })
    expect(result.status, result.stderr).toBe(0)
    // The collector's own selector names the directory, exactly where the real driver wrote.
    const transport = ownedAppRunsDirectory(output, "ssh:fixture@fixture.invalid")
    expect(ownedAppRunsDirectory(output, "local")).toBe(output)
    // Exactly what the collector's own read does: the receipt beside one run JSON.
    const proof = readOwnedAppTransportProof(join(transport, "transport-receipt.json"), revision)
    expect(proof.receiptSha256).toMatch(/^[a-f0-9]{64}$/)
    const runs = readdirSync(transport).filter((name) => name.endsWith(".json") && name !== "transport-receipt.json")
    expect(runs).toEqual(["kitty-0.48.2-macos.json"])

    // The transported bytes are the producer's bytes, and they parse and classify the way the
    // collector classifies a run after transport.
    const runPath = join(transport, "kitty-0.48.2-macos.json")
    const runBytes = readFileSync(runPath)
    expect(createHash("sha256").update(runBytes).digest("hex")).toBe(
      createHash("sha256").update(producerBytes).digest("hex"),
    )
    const raw = runBytes.toString("utf8")
    const probeHash = (JSON.parse(raw) as { probeHash: string }).probeHash
    const suitePath = join(CONTENT, "suites", `${probeHash.slice(0, 12)}.json`)
    const manifest = parseSuiteManifest(suitePath, readFileSync(suitePath, "utf8"))
    const catalogIds = Object.keys(catalog.loadFeatures(CONTENT))
    const run = parseRun(runPath, raw, catalogIds, new Map([[probeHash, manifest]]))
    expect(run.target).toMatchObject({ kind: "app", id: "kitty", os: "macos" })
    expect(run.suiteComplete).toBe(true)
    const classification = classifyDevelopmentRun(run, [])
    expect(classification.mode).toBe("development")
    expect(classification.runId).toBe(run.runId)
    expect(Object.keys(classification.states).length).toBeGreaterThan(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)

it("records the host-written transport receipt as evidence and refuses anything else", () => {
  const directory = mkdtempSync(join(tmpdir(), "transport-proof-"))
  const path = join(directory, "transport-receipt.json")
  const receipt = {
    schemaVersion: 1,
    kind: "owned-app-transport",
    grants: "nothing",
    sourceRevision: ownedAppRevision,
    transport: "ssh:fixture@fixture.invalid",
    hostKeyFingerprint: "SHA256:fixture",
    resourceManifestSha256: "d".repeat(64),
    resourceFiles: 42,
    output: { directory: "/remote/stage/runs/cccccccccccc-kitty" },
  }
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`
  writeFileSync(path, bytes)
  try {
    expect(readOwnedAppTransportProof(path, ownedAppRevision)).toEqual({
      runner: "ssh:fixture@fixture.invalid",
      hostKeyFingerprint: "SHA256:fixture",
      resourceManifestSha256: "d".repeat(64),
      resourceFiles: 42,
      receiptSha256: createHash("sha256").update(bytes).digest("hex"),
      remoteOutput: "/remote/stage/runs/cccccccccccc-kitty",
    })
    writeFileSync(path, JSON.stringify({ ...receipt, kind: "linux-xvfb-container" }))
    expect(() => readOwnedAppTransportProof(path, ownedAppRevision)).toThrow(
      /not a schemaVersion 1 owned-app-transport record/,
    )
    // A receipt that claims authority is refused: this kind records, it never grants.
    writeFileSync(path, JSON.stringify({ ...receipt, grants: "mutate+readback" }))
    expect(() => readOwnedAppTransportProof(path, ownedAppRevision)).toThrow(/this kind grants nothing/)
    // A receipt for another revision cannot stand in for the bytes this pass measured.
    writeFileSync(path, JSON.stringify({ ...receipt, sourceRevision: "e".repeat(40) }))
    expect(() => readOwnedAppTransportProof(path, ownedAppRevision)).toThrow(/names source/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
