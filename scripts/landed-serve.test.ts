/**
 * @failure The preview 404s or 500s every clean URL the site links to (`cleanUrls: true`), so the operator's click on a baseline chip lands on a broken page (30757).
 * @level l2
 * @consumer The `terminfo-site` resident's `landed-serve`, and every preview link the operator clicks.
 * @reach fs-walk <fixture-only: mkdtempSync out roots and the staging/dist.previous trees each case creates there>
 * @testonly none
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  buildLanding,
  createPreviewHandler,
  createSiteRebuilder,
  readServedStamp,
  rebuildForRun,
  rebuildReason,
  resolveServedPath,
  siteBuildArgs,
} from "./landed-serve.ts"

let dist: string

function page(relativePath: string, body: string): void {
  const target = join(dist, relativePath)
  mkdirSync(join(target, ".."), { recursive: true })
  writeFileSync(target, body)
}

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "landed-serve-"))
  page("index.html", "home-page")
  page("404.html", "not-found-page")
  page("features.html", "features-page")
  page("baseline/core.html", "core-page")
  // A clean page and a same-named directory coexist (VitePress makes `cursor.html` beside `cursor/`).
  page("cursor.html", "cursor-page")
  page("cursor/sub.html", "cursor-sub-page")
  // A directory with no index at all is the shape that used to answer 500.
  mkdirSync(join(dist, "folderonly"), { recursive: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is unavailable; dist is this test's own mkdtemp scratch root
  rmSync(dist, { recursive: true, force: true })
})

// 29595: injected runBuild fixtures bypass the real child process and miss its task declaration.
// Both launch paths must expose the existing guard's identity and ceiling to the host observer.
it.each(["code", "run"] as const)(
  "declares the %s build as its own bounded task",
  async (reason) => {
    const bin = join(dist, "bin")
    const landing = join(dist, "landing")
    const trace = join(dist, "build-argv.json")
    mkdirSync(bin)
    mkdirSync(landing)
    writeFileSync(
      join(bin, "bun"),
      `#!${process.execPath}\nawait Bun.write(process.env.BUILD_ARGV_TRACE, JSON.stringify(process.argv.slice(2))); process.exit(17);\n`,
      { mode: 0o755 },
    )
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`)
    vi.stubEnv("TERMINFO_SITE_LANDING_ROOT", landing)
    vi.stubEnv("TERMINFO_SITE_OUT_DIR", dist)
    vi.stubEnv("BUILD_ARGV_TRACE", trace)
    if (reason === "code") {
      const child = spawnSync(process.execPath, [fileURLToPath(new URL("./landed-serve.ts", import.meta.url))], {
        env: process.env,
        encoding: "utf8",
        timeout: 15_000,
      })
      expect(child.error).toBeUndefined()
      expect(child.status).toBe(1)
      expect(child.stderr).toContain("site build failed (exit 17)")
    } else {
      mkdirSync(join(dist, "dist"))
      writeFileSync(
        join(dist, "dist", "build.json"),
        JSON.stringify({ sourceCommit: "code", workingRun: { id: "old" } }),
      )
      const report = vi.spyOn(console, "error").mockImplementation(() => {})
      const progress = vi.spyOn(console, "log").mockImplementation(() => {})
      try {
        expect(await rebuildForRun({ outRoot: dist, target: "code", runId: "new" })).toBe(false)
        expect(report).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("site build exit 17"))
        expect(progress).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("hourly run new"))
        expect(readServedStamp(join(dist, "dist")).workingRunId).toBe("old")
      } finally {
        progress.mockRestore()
        report.mockRestore()
      }
    }
    expect(JSON.parse(readFileSync(trace, "utf8"))).toEqual([
      join(landing, "tools", "gate-task-guard.ts"),
      "--task",
      "terminfo-site-build",
      "--max-rss-mib",
      "16384",
      "--",
      "bun",
      "run",
      "build",
    ])
  },
  20_000,
)

// 33965: the site build outgrew a 16384 MiB host ceiling hardcoded here while its own guard read the declared env.
it("gives the host the build's declared ceiling, 16384 MiB by default", () => {
  const ceiling = (env: NodeJS.ProcessEnv) => {
    const args = siteBuildArgs({ TERMINFO_SITE_LANDING_ROOT: "/landing", ...env })
    return args[args.indexOf("--max-rss-mib") + 1]
  }
  expect(ceiling({})).toBe("16384")
  expect(ceiling({ TERMINFO_SITE_PEAK_CEILING_BYTES: String(20 * 1024 ** 3) })).toBe("20480")
  expect(() => ceiling({ TERMINFO_SITE_PEAK_CEILING_BYTES: "-1" })).toThrow("TERMINFO_SITE_PEAK_CEILING_BYTES")
})

// @failure A damaged hourly summary prevents the actual preview owner starting again (#33944 C8).
// @level l3 @consumer real landed-serve bootstrap, strict run reader and HTTP listener.
// Helper routing/rebuild tests and the build-failure subprocess cannot witness successful owner lifetimes.
it("starts the real owner twice on the same malformed hourly summary and keeps serving", async () => {
  const ownerPath = fileURLToPath(new URL("./landed-serve.ts", import.meta.url))
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url))
  const target = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const out = join(dist, "owner-out")
  const served = join(out, "dist")
  const runs = join(dist, "owner-runs")
  const oldRun = "2026-11-02T20-34-05-309Z-75c7a72a53da"
  const badRun = "2026-11-02T21-34-03-594Z-2d0bc819ffc1"
  const badSummary = join(runs, badRun, "summary.json")
  const stamp = { sourceCommit: target, workingRun: { id: oldRun } }
  mkdirSync(served, { recursive: true })
  mkdirSync(join(runs, oldRun), { recursive: true })
  mkdirSync(join(runs, badRun), { recursive: true })
  writeFileSync(join(served, "build.json"), JSON.stringify(stamp))
  writeFileSync(join(served, "index.html"), "owned-preview-survives-damaged-summary")
  writeFileSync(join(served, "404.html"), "owned-not-found")
  writeFileSync(join(runs, oldRun, "summary.json"), JSON.stringify({ complete: true }))
  writeFileSync(join(runs, oldRun, "cells.json"), "{}")
  writeFileSync(badSummary, `${JSON.stringify({ complete: true })}${"\u0000".repeat(32)}`)
  const retained = [
    join(served, "build.json"),
    join(served, "index.html"),
    join(runs, oldRun, "summary.json"),
    join(runs, oldRun, "cells.json"),
    badSummary,
  ].map((path) => ({ path, bytes: readFileSync(path) }))

  // The owner is actual Bun; only an unexpected external site build hits the existing fake-bun boundary.
  const bin = join(dist, "owner-bin")
  const trace = join(dist, "unexpected-owner-build.json")
  mkdirSync(bin)
  writeFileSync(
    join(bin, "bun"),
    `#!${process.execPath}\nawait Bun.write(process.env.BUILD_ARGV_TRACE, JSON.stringify(process.argv.slice(2))); process.exit(17);\n`,
    { mode: 0o755 },
  )
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("port reservation") })
  const port = portProbe.port
  await portProbe.stop(true)
  const owners = new Set<number>()
  for (let lifetime = 0; lifetime < 2; lifetime++) {
    let stdout = ""
    let stderr = ""
    let spawnError: Error | undefined
    const child = spawn(process.execPath, [ownerPath], {
      cwd: sourceRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TERMINFO_SITE_HOST: "127.0.0.1",
        TERMINFO_SITE_PORT: String(port),
        TERMINFO_SITE_OUT_DIR: out,
        TERMINFO_SITE_WORKING_RUNS_DIR: runs,
        BUILD_ARGV_TRACE: trace,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()))
    child.once("error", (error) => {
      spawnError = error
    })
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    try {
      await vi.waitFor(
        () => {
          if (spawnError) throw spawnError
          expect(child.exitCode, `${stdout}\n${stderr}`).toBeNull()
          expect(child.signalCode, `${stdout}\n${stderr}`).toBeNull()
          expect(stderr).toContain(badSummary)
          expect(stderr).toContain("invalid JSON")
        },
        { timeout: 30_000, interval: 25 },
      )
      // The listener binds before the scan: request only AFTER this lifetime's named error was observed.
      const response = await fetch(`http://127.0.0.1:${port}/`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("owned-preview-survives-damaged-summary")
      const build = await fetch(`http://127.0.0.1:${port}/build.json`)
      expect(build.status).toBe(200)
      expect(await build.json()).toEqual(stamp)
      expect(child.pid).toBeTypeOf("number")
      expect(owners.has(child.pid!)).toBe(false)
      owners.add(child.pid!)
      expect(existsSync(trace), `${stdout}\n${stderr}`).toBe(false)
      for (const file of retained) expect(readFileSync(file.path)).toEqual(file.bytes)
    } finally {
      // 'close' follows process exit AND stdio closure; do not reopen or remove its files before it settles.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, 5_000)
      try {
        await closed
      } finally {
        clearTimeout(force)
      }
    }
  }
  expect(owners.size).toBe(2)
}, 75_000)

// @failure #30205: a landing that moved vendor/terminfo.dev made the owner rebuild the whole site BEFORE it served,
// so the preview was down 10-15 min per landing and the shared-main updater waited on it (18 of 52 landings,
// 12,693 s over 30 s on 2026-11-25). The owner must serve the previous build at once and rebuild beside it.
// @level l3 @consumer the real landed-serve bootstrap, its HTTP listener and the rebuild marker the health probe reads.
it("serves the previous build at once while a landing's code rebuild runs beside it (30205)", async () => {
  const ownerPath = fileURLToPath(new URL("./landed-serve.ts", import.meta.url))
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url))
  const target = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const previous = "f".repeat(40)
  const out = join(dist, "beside-out")
  const served = join(out, "dist")
  mkdirSync(served, { recursive: true })
  writeFileSync(join(served, "build.json"), JSON.stringify({ sourceCommit: previous }))
  writeFileSync(join(served, "index.html"), "previous-build-keeps-serving")
  writeFileSync(join(served, "404.html"), "previous-not-found")
  // The site build never finishes inside this test: it records that it started and its pid, then waits.
  const bin = join(dist, "beside-bin")
  const trace = join(dist, "beside-build.json")
  mkdirSync(bin)
  writeFileSync(
    join(bin, "bun"),
    `#!${process.execPath}\nawait Bun.write(process.env.BUILD_ARGV_TRACE, JSON.stringify({ pid: process.pid, out: process.env.TERMINFO_SITE_OUT_DIR })); await Bun.sleep(120_000);\n`,
    { mode: 0o755 },
  )
  const readTrace = (): { pid?: unknown; out?: unknown } =>
    JSON.parse(readFileSync(trace, "utf8")) as { pid?: unknown; out?: unknown }
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("port reservation") })
  const port = portProbe.port
  await portProbe.stop(true)
  const { TERMINFO_SITE_WORKING_RUNS_DIR: _runs, TERMINFO_SITE_LANDING_ROOT: _landing, ...inherited } = process.env
  let stdout = ""
  let stderr = ""
  const child = spawn(process.execPath, [ownerPath], {
    cwd: sourceRoot,
    env: {
      ...inherited,
      PATH: `${bin}:${process.env.PATH}`,
      TERMINFO_SITE_HOST: "127.0.0.1",
      TERMINFO_SITE_PORT: String(port),
      TERMINFO_SITE_OUT_DIR: out,
      BUILD_ARGV_TRACE: trace,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()))
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })
  try {
    await vi.waitFor(
      async () => {
        expect(child.exitCode, `${stdout}\n${stderr}`).toBeNull()
        expect(existsSync(trace), `${stdout}\n${stderr}`).toBe(true)
        const response = await fetch(`http://127.0.0.1:${port}/`)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe("previous-build-keeps-serving")
      },
      { timeout: 20_000, interval: 100 },
    )
    // The build runs into the staging root, never over the served dist, and the marker says which build serves.
    expect(readTrace().out).toBe(join(out, "staging"))
    expect(JSON.parse(readFileSync(join(out, "rebuild.json"), "utf8"))).toMatchObject({
      target,
      kind: "code",
      serving: previous,
    })
    expect(readServedStamp(served).sourceCommit).toBe(previous)
  } finally {
    if (existsSync(trace)) {
      try {
        process.kill(Number(readTrace().pid), "SIGKILL")
      } catch {
        // silent-fallback-allow: the fake build may already have exited; there is nothing else to clean up
      }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }, 5_000)
    try {
      await closed
    } finally {
      clearTimeout(force)
    }
  }
}, 45_000)

function get(path: string, init?: RequestInit): Response {
  return createPreviewHandler(dist)(new Request(`http://preview.test${path}`, init))
}

describe("landed-serve clean URLs", () => {
  it("AC1: serves <path>.html for an extensionless page", async () => {
    const response = get("/features")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("features-page")
  })

  it("AC1: serves a nested clean URL", async () => {
    const response = get("/baseline/core")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("core-page")
  })

  it("AC1: <path>.html wins over a same-named directory", async () => {
    const response = get("/cursor")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("cursor-page")
  })

  it("AC2: an unknown path is 404 with the not-found page", async () => {
    const response = get("/nope")
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("not-found-page")
  })

  it("AC3: a directory without index.html is 404, not 500", async () => {
    const response = get("/folderonly")
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("not-found-page")
  })

  it("still serves an exact file, the root, and an explicit .html path", async () => {
    expect(await get("/").text()).toBe("home-page")
    expect(await get("/features.html").text()).toBe("features-page")
    expect(await get("/cursor/sub.html").text()).toBe("cursor-sub-page")
  })

  it("refuses a non-GET/HEAD method", () => {
    expect(get("/features", { method: "POST" }).status).toBe(405)
  })

  it("refuses to escape the dist and a malformed escape", () => {
    expect(resolveServedPath(dist, "/../package.json")).toBeNull()
    expect(resolveServedPath(dist, "/%E0%A4%A")).toBeNull()
  })
})

/**
 * Requirement 4 (@cto scope GO 2026-11-02): a new COMPLETE hourly run triggers ONE rebuild through the existing
 * rebuild check, and a failed run rebuild keeps serving the previous build and says so loudly.
 */
describe("landed-serve hourly-run rebuild", () => {
  const CODE = "a".repeat(40)
  const RUN_A = "2026-11-02T20-34-05-309Z-75c7a72a53da"
  const RUN_B = "2026-11-02T21-34-03-594Z-2d0bc819ffc1"
  // The rebuild narrates its progress on stdout for the unit log; the tests read state, not narration.
  let quiet: ReturnType<typeof vi.spyOn> | undefined
  beforeEach(() => {
    quiet = vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    quiet?.mockRestore()
  })

  function stamp(distDir: string, workingRunId: string | null, sourceCommit = CODE): void {
    mkdirSync(distDir, { recursive: true })
    writeFileSync(
      join(distDir, "build.json"),
      JSON.stringify({ sourceCommit, ...(workingRunId && { workingRun: { id: workingRunId } }) }),
    )
    writeFileSync(join(distDir, "index.html"), `built-for-${workingRunId}`)
  }

  function completeRun(runsDir: string, id: string): void {
    mkdirSync(join(runsDir, id), { recursive: true })
    writeFileSync(join(runsDir, id, "summary.json"), JSON.stringify({ complete: true }))
    writeFileSync(join(runsDir, id, "cells.json"), "{}")
  }

  /** The one `.unproven-*` tree the run kept beside `name`, proving it was preserved rather than deleted. */
  function keptAside(out: string, name: "staging" | "dist.previous"): string {
    const kept = readdirSync(out).filter((entry) => entry.startsWith(`${name}.unproven-`))
    expect(kept).toHaveLength(1)
    return join(out, kept[0] ?? "")
  }

  it("asks for a run rebuild only when the code matches and the newest complete run differs", () => {
    expect(rebuildReason(CODE, { sourceCommit: CODE, workingRunId: RUN_A }, RUN_B)).toBe("run")
    expect(rebuildReason(CODE, { sourceCommit: CODE, workingRunId: RUN_B }, RUN_B)).toBeNull()
    expect(rebuildReason(CODE, { sourceCommit: "b".repeat(40), workingRunId: RUN_B }, RUN_B)).toBe("code")
    expect(rebuildReason(CODE, { sourceCommit: CODE, workingRunId: null }, null)).toBeNull()
  })

  it("a failed run rebuild keeps serving the previous build and reports loudly", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-run-"))
    stamp(join(out, "dist"), RUN_A)
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => errors.push(String(line)))
    try {
      const ok = await rebuildForRun({ outRoot: out, target: CODE, runId: RUN_B, runBuild: async () => 1 })
      expect(ok).toBe(false)
    } finally {
      spy.mockRestore()
    }
    expect(readServedStamp(join(out, "dist"))).toEqual({ sourceCommit: CODE, workingRunId: RUN_A })
    expect(readFileSync(join(out, "dist", "index.html"), "utf8")).toBe(`built-for-${RUN_A}`)
    expect(errors.join("\n")).toContain(`rebuild for hourly run ${RUN_B} failed`)
    expect(errors.join("\n")).toContain("still serving the previous build")
    // The existing rebuild marker stays behind on failure, as it does for a failed code rebuild.
    expect(existsSync(join(out, "rebuild.json"))).toBe(true)
  })

  // #38423: a landing whose own build is over the memory ceiling must not take the preview down. The operator sees an
  // older named build instead of a 502. #30205: the marker stays, carrying the failure, so the health probe and the
  // preview follow both read a FAILED rebuild loudly instead of an absent one.
  it("a failed landing build keeps the previous build serving and records the failure in the marker", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-code-"))
    stamp(join(out, "dist"), RUN_A)
    const target = "b".repeat(40)
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => errors.push(String(line)))
    try {
      expect(await buildLanding({ outRoot: out, target, runBuild: async () => 70 })).toBe(false)
    } finally {
      spy.mockRestore()
    }
    expect(readServedStamp(join(out, "dist"))).toEqual({ sourceCommit: CODE, workingRunId: RUN_A })
    expect(readFileSync(join(out, "dist", "index.html"), "utf8")).toBe(`built-for-${RUN_A}`)
    expect(errors.join("\n")).toContain("site build failed (exit 70)")
    expect(errors.join("\n")).toContain(`NOT serving ${target.slice(0, 12)}`)
    expect(errors.join("\n")).toContain(`still serving the previous build ${CODE.slice(0, 12)}`)
    expect(JSON.parse(readFileSync(join(out, "rebuild.json"), "utf8"))).toMatchObject({
      target,
      kind: "code",
      failure: "site build failed (exit 70)",
      failedAt: expect.any(String),
    })
  })

  // #30205: the hourly rebuilder is the one rebuilder; a landing's code mismatch goes through it beside the served
  // build, once per landing revision, and a failure is never retried in-process.
  it("the one rebuilder rebuilds a code mismatch beside the served build, once per landing revision", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-code-"))
    stamp(join(out, "dist"), RUN_A)
    const target = "b".repeat(40)
    const builds: string[] = []
    let fail = true
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const rebuilder = createSiteRebuilder({
        outRoot: out,
        target,
        runBuild: async (env) => {
          builds.push(env["TERMINFO_SITE_OUT_DIR"] ?? "")
          // While the build runs the served dist is still the previous one.
          expect(readServedStamp(join(out, "dist")).sourceCommit).toBe(CODE)
          if (fail) return 1
          stamp(join(env["TERMINFO_SITE_OUT_DIR"] ?? "", "dist"), null, target)
          return 0
        },
      })
      await rebuilder.check()
      await rebuilder.check()
      expect(builds).toEqual([join(out, "staging")])
      expect(readServedStamp(join(out, "dist")).sourceCommit).toBe(CODE)
      fail = false
      const second = createSiteRebuilder({
        outRoot: out,
        target,
        runBuild: async (env) => {
          builds.push(env["TERMINFO_SITE_OUT_DIR"] ?? "")
          stamp(join(env["TERMINFO_SITE_OUT_DIR"] ?? "", "dist"), null, target)
          return 0
        },
      })
      await second.check()
      expect(builds).toHaveLength(2)
      expect(readServedStamp(join(out, "dist")).sourceCommit).toBe(target)
      expect(existsSync(join(out, "rebuild.json"))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it("a passing landing build swaps the staged dist in and clears the marker", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-code-"))
    stamp(join(out, "dist"), RUN_A)
    const target = "b".repeat(40)
    const ok = await buildLanding({
      outRoot: out,
      target,
      runBuild: async (env) => {
        stamp(join(env["TERMINFO_SITE_OUT_DIR"] ?? "", "dist"), null, target)
        return 0
      },
    })
    expect(ok).toBe(true)
    expect(readServedStamp(join(out, "dist"))).toEqual({ sourceCommit: target, workingRunId: null })
    expect(existsSync(join(out, "staging", "dist"))).toBe(false)
    expect(existsSync(join(out, "rebuild.json"))).toBe(false)
  })

  it("a successful run rebuild swaps the staged build in and clears the marker", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-run-"))
    stamp(join(out, "dist"), RUN_A)
    const ok = await rebuildForRun({
      outRoot: out,
      target: CODE,
      runId: RUN_B,
      runBuild: async (env) => {
        stamp(join(env["TERMINFO_SITE_OUT_DIR"] ?? "", "dist"), RUN_B)
        return 0
      },
    })
    expect(ok).toBe(true)
    expect(readServedStamp(join(out, "dist"))).toEqual({ sourceCommit: CODE, workingRunId: RUN_B })
    expect(existsSync(join(out, "rebuild.json"))).toBe(false)
  })

  it("rebuilds once per new complete run and never retries a run whose build failed", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-run-"))
    const runs = mkdtempSync(join(tmpdir(), "landed-serve-runs-"))
    stamp(join(out, "dist"), RUN_A)
    completeRun(runs, RUN_A)
    const builds: string[] = []
    let fail = true
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const rebuilder = createSiteRebuilder({
        runsDir: runs,
        outRoot: out,
        target: CODE,
        runBuild: async (env) => {
          builds.push(env["TERMINFO_SITE_OUT_DIR"] ?? "")
          if (fail) return 1
          stamp(join(env["TERMINFO_SITE_OUT_DIR"] ?? "", "dist"), RUN_B)
          return 0
        },
      })
      await rebuilder.check()
      expect(builds).toHaveLength(0)
      // A run still being written is not newest.
      mkdirSync(join(runs, RUN_B))
      await rebuilder.check()
      expect(builds).toHaveLength(0)
      completeRun(runs, RUN_B)
      await rebuilder.check()
      await rebuilder.check()
      expect(builds).toHaveLength(1)
      expect(readServedStamp(join(out, "dist")).workingRunId).toBe(RUN_A)
      fail = false
      const RUN_C = "2026-11-02T22-34-03-000Z-2d0bc819ffc1"
      completeRun(runs, RUN_C)
      await rebuilder.check()
      expect(builds).toHaveLength(2)
      expect(readServedStamp(join(out, "dist")).workingRunId).toBe(RUN_B)
    } finally {
      spy.mockRestore()
    }
  })

  /**
   * @cto 2026-11-22 (#34952): a path named `staging` or `dist.previous` is containment evidence only. These three
   * cases pin the line between output this program produced (replaceable) and a tree that merely has the name
   * (retained, moved aside, reported).
   */
  it("keeps a pre-existing staging tree of unproven origin and builds into a marked staging root", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-run-"))
    stamp(join(out, "dist"), RUN_A)
    mkdirSync(join(out, "staging", "dist"), { recursive: true })
    writeFileSync(join(out, "staging", "dist", "index.html"), "somebody-elses-build")
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => errors.push(String(line)))
    try {
      const ok = await rebuildForRun({
        outRoot: out,
        target: CODE,
        runId: RUN_B,
        runBuild: async (env) => {
          stamp(join(env["TERMINFO_SITE_OUT_DIR"] ?? "", "dist"), RUN_B)
          return 0
        },
      })
      expect(ok).toBe(true)
    } finally {
      spy.mockRestore()
    }
    expect(readServedStamp(join(out, "dist"))).toEqual({ sourceCommit: CODE, workingRunId: RUN_B })
    expect(readFileSync(join(keptAside(out, "staging"), "dist", "index.html"), "utf8")).toBe("somebody-elses-build")
    expect(errors.join("\n")).toContain("is not this program's build scratch")
  })

  it("keeps a dist.previous of unproven origin instead of deleting it", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-run-"))
    stamp(join(out, "dist"), RUN_A)
    mkdirSync(join(out, "dist.previous"), { recursive: true })
    writeFileSync(join(out, "dist.previous", "evidence.txt"), "hand-copied output")
    const errors: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => errors.push(String(line)))
    try {
      const ok = await rebuildForRun({
        outRoot: out,
        target: CODE,
        runId: RUN_B,
        runBuild: async (env) => {
          stamp(join(env["TERMINFO_SITE_OUT_DIR"] ?? "", "dist"), RUN_B)
          return 0
        },
      })
      expect(ok).toBe(true)
    } finally {
      spy.mockRestore()
    }
    expect(readFileSync(join(keptAside(out, "dist.previous"), "evidence.txt"), "utf8")).toBe("hand-copied output")
    expect(readServedStamp(join(out, "dist"))).toEqual({ sourceCommit: CODE, workingRunId: RUN_B })
    expect(errors.join("\n")).toContain("carries no terminfo build stamp")
  })

  it("reuses the staging root its own marker claims, replacing a failed attempt's output", async () => {
    const out = mkdtempSync(join(tmpdir(), "landed-serve-run-"))
    stamp(join(out, "dist"), RUN_A)
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const failed = await rebuildForRun({
        outRoot: out,
        target: CODE,
        runId: RUN_A,
        runBuild: async (env) => {
          const staged = join(env["TERMINFO_SITE_OUT_DIR"] ?? "", "dist")
          mkdirSync(staged, { recursive: true })
          writeFileSync(join(staged, "index.html"), "half-written")
          return 1
        },
      })
      expect(failed).toBe(false)
      expect(existsSync(join(out, "staging", "dist", "index.html"))).toBe(true)
      const ok = await rebuildForRun({
        outRoot: out,
        target: CODE,
        runId: RUN_B,
        runBuild: async (env) => {
          stamp(join(env["TERMINFO_SITE_OUT_DIR"] ?? "", "dist"), RUN_B)
          return 0
        },
      })
      expect(ok).toBe(true)
    } finally {
      spy.mockRestore()
    }
    expect(readdirSync(out).filter((entry) => entry.includes(".unproven-"))).toEqual([])
    expect(readServedStamp(join(out, "dist"))).toEqual({ sourceCommit: CODE, workingRunId: RUN_B })
  })
})
