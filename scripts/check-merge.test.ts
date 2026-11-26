// @testonly none
import { afterEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkStoredRunSourceHistory,
  isSiteBuildInput,
  runTerminfoMergeCheck,
  siteBuildInputs,
  type ExecFn,
} from "./check-merge.ts"

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("terminfo check:merge pre-merge gate (@cto 9768f1cf)", () => {
  it("fails loudly when YRD_BASE_SHA or YRD_CANDIDATE_SHA is missing (never skips)", () => {
    const spy = vi.fn<ExecFn>()
    expect(() =>
      runTerminfoMergeCheck({
        terminfoRoot: "/tmp/t",
        superRoot: "/tmp/s",
        env: { YRD_BASE_SHA: "abc" },
        exec: spy,
      }),
    ).toThrow(/requires both YRD_BASE_SHA and YRD_CANDIDATE_SHA/)
    expect(spy).not.toHaveBeenCalled()
  })

  it("fast-skips untouched candidates and asserts via spy that no build runs", () => {
    const spy = vi.fn<ExecFn>((cmd, args) => {
      if (cmd === "git" && args.includes("diff")) return { status: 0, stdout: "", stderr: "" }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`)
    })
    const logs: string[] = []
    const res = runTerminfoMergeCheck({
      terminfoRoot: "/tmp/t",
      superRoot: "/tmp/s",
      env: { YRD_BASE_SHA: "aaa", YRD_CANDIDATE_SHA: "bbb" },
      exec: spy,
      log: (l) => logs.push(l),
    })
    expect(res).toEqual({ skipped: true, scope: "skipped", checkedRuns: 0 })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes("unchanged; skipping"))).toBe(true)
  })

  it("refuses unfetched and non-ancestor sourceRevision naming file and revision", () => {
    const root = makeTempDir("terminfo-hist-")
    mkdirSync(join(root, "content", "probes-apps"), { recursive: true })
    writeFileSync(
      join(root, "content", "probes-apps", "kitty-0.51.1-linux-aaa.json"),
      JSON.stringify({ sourceRevision: "deadbeef1111" }),
    )
    writeFileSync(
      join(root, "content", "probes-apps", "xterm-412-linux-bbb.json"),
      JSON.stringify({ sourceRevision: "cafebabe2222" }),
    )
    const exec: ExecFn = (_cmd, args) => {
      if (args.includes("cat-file")) {
        return args.includes("deadbeef1111^{commit}")
          ? { status: 1, stdout: "", stderr: "not found" }
          : { status: 0, stdout: "", stderr: "" }
      }
      if (args.includes("merge-base")) {
        return { status: 1, stdout: "", stderr: "" }
      }
      return { status: 0, stdout: "", stderr: "" }
    }
    const { checked, failures } = checkStoredRunSourceHistory(root, exec)
    expect(checked).toBe(2)
    expect(failures).toEqual([
      {
        file: "content/probes-apps/kitty-0.51.1-linux-aaa.json",
        sourceRevision: "deadbeef1111",
        reason: "not fetched (commit missing from git object store)",
      },
      {
        file: "content/probes-apps/xterm-412-linux-bbb.json",
        sourceRevision: "cafebabe2222",
        reason: "not an ancestor of HEAD",
      },
    ])
  })

  it("removes its scratch dir even when the guarded build fails, and prints peak RSS", () => {
    const superRoot = makeTempDir("terminfo-super-")
    const terminfoRoot = join(superRoot, "vendor", "terminfo.dev")
    mkdirSync(join(superRoot, "tools"), { recursive: true })
    writeFileSync(join(superRoot, "tools", "gate-task-guard.ts"), "// stub")
    mkdirSync(join(terminfoRoot, "content", "probes-apps"), { recursive: true })
    writeFileSync(
      join(terminfoRoot, "content", "probes-apps", "kitty-0.51.1-linux-ok.json"),
      JSON.stringify({ sourceRevision: "111111111111" }),
    )

    let observedScratchDir = ""
    const logs: string[] = []
    const exec: ExecFn = (cmd, args, opts) => {
      if (cmd === "git" && args.includes("diff")) return { status: 0, stdout: "vendor/terminfo.dev\n", stderr: "" }
      if (cmd === "git") return { status: 0, stdout: "", stderr: "" }
      if (cmd === "bun" && args.includes("terminfo-merge-build")) {
        observedScratchDir = opts.env?.["TERMINFO_SITE_OUT_DIR"] ?? ""
        expect(existsSync(observedScratchDir)).toBe(true)
        return {
          status: 70,
          stdout: "",
          stderr: "gate-task-guard: terminfo-merge-build sampled-peak-rss=20971520 KiB\nOOM",
        }
      }
      return { status: 0, stdout: "", stderr: "" }
    }

    expect(() =>
      runTerminfoMergeCheck({
        terminfoRoot,
        superRoot,
        env: { YRD_BASE_SHA: "aaa", YRD_CANDIDATE_SHA: "bbb" },
        exec,
        log: (l) => logs.push(l),
      }),
    ).toThrow(/real site build failed \(exit 70\)/)
    expect(observedScratchDir).not.toBe("")
    expect(existsSync(observedScratchDir)).toBe(false)
    expect(logs.some((l) => l.includes("sampled-peak-rss=20971520 KiB"))).toBe(true)
  })

  it("build entrypoint scripts use import.meta.main so tilde/encoded checkout paths (e.g. hh-dev~main) never silently skip", () => {
    for (const rel of ["generate-analysis.ts", "generate-api.ts"]) {
      const source = readFileSync(join(import.meta.dirname, rel), "utf8")
      expect(source).not.toContain("file://${process.argv[1]}")
      expect(source).toContain("import.meta.main")
    }
  })
})

describe("terminfo check:merge build scope (@cto 31e669f6 a)", () => {
  /** A terminfo tree whose build reaches run-parser and, through it, probe-defs; admin and probes are unreached. */
  function fixtureTree(): { superRoot: string; terminfoRoot: string } {
    const superRoot = makeTempDir("terminfo-scope-")
    const terminfoRoot = join(superRoot, "vendor", "terminfo.dev")
    const put = (rel: string, text: string) => {
      mkdirSync(join(terminfoRoot, rel, ".."), { recursive: true })
      writeFileSync(join(terminfoRoot, rel), text)
    }
    mkdirSync(join(superRoot, "tools"), { recursive: true })
    writeFileSync(join(superRoot, "tools", "gate-task-guard.ts"), "// stub")
    put(
      "package.json",
      JSON.stringify({ workspaces: ["packages/*"], scripts: { build: "bun scripts/site-build.ts --with-analysis" } }),
    )
    put(
      "scripts/site-build.ts",
      'import { parse } from "@terminfo/run-parser"\nimport { helper } from "./site-helper.ts"\n',
    )
    put("scripts/site-helper.ts", "export const helper = 1\n")
    put("scripts/check-merge.ts", "// not imported by the build\n")
    put("docs/index.md", "# terminfo.dev\n")
    put("content/features.json", "{}")
    const pkg = (dir: string, name: string, deps: string[]) =>
      put(
        `packages/${dir}/package.json`,
        JSON.stringify({ name, dependencies: Object.fromEntries(deps.map((d) => [d, "workspace:*"])) }),
      )
    pkg("run-parser", "@terminfo/run-parser", ["@terminfo/probe-defs"])
    pkg("probe-defs", "@terminfo/probe-defs", [])
    pkg("probes", "@terminfo/probes", ["@terminfo/probe-defs"])
    pkg("admin", "@terminfo/admin", ["@terminfo/probe-defs"])
    put("packages/run-parser/src/index.ts", "export const parse = 1\n")
    put("packages/probe-defs/src/types.ts", "export type Status = string\n")
    put("packages/probes/src/run.ts", "export const run = 1\n")
    put("packages/admin/src/report.ts", "export const report = 1\n")
    return { superRoot, terminfoRoot }
  }

  function run(changed: readonly string[]) {
    const { superRoot, terminfoRoot } = fixtureTree()
    const logs: string[] = []
    let built = false
    const exec: ExecFn = (cmd, args) => {
      if (cmd === "git" && args.includes("rev-parse")) {
        return { status: 0, stdout: `${String(args.at(-1)).startsWith("aaa") ? "1111" : "2222"}\n`, stderr: "" }
      }
      if (cmd === "git" && args.includes("diff") && args.includes(superRoot)) {
        return { status: 0, stdout: "vendor/terminfo.dev\n", stderr: "" }
      }
      if (cmd === "git" && args.includes("diff")) return { status: 0, stdout: `${changed.join("\n")}\n`, stderr: "" }
      if (cmd === "bun" && args.includes("terminfo-merge-build")) built = true
      return { status: 0, stdout: "", stderr: "" }
    }
    const result = runTerminfoMergeCheck({
      terminfoRoot,
      superRoot,
      env: { YRD_BASE_SHA: "aaa", YRD_CANDIDATE_SHA: "bbb" },
      exec,
      log: (line) => logs.push(line),
    })
    return { result, logs, built }
  }

  it("takes the cheap scope when no changed file is a site build input, and says why", () => {
    const { result, logs, built } = run([
      "tools/probe-runner.ts",
      "scripts/check-merge.ts",
      "packages/admin/src/report.ts",
      "packages/probe-defs/src/types.test.ts",
    ])
    expect(built).toBe(false)
    expect(result.scope).toBe("cheap")
    expect(logs.join("\n")).toMatch(/cheap scope \(no site build\): none of 4 changed file\(s\) is a site build input/)
  })

  it("runs the full build when a probe package the site imports changed, and names the file", () => {
    const { result, logs, built } = run(["packages/admin/src/report.ts", "packages/probe-defs/src/types.ts"])
    expect(built).toBe(true)
    expect(result.scope).toBe("full")
    expect(logs.join("\n")).toContain("full build: packages/probe-defs/src/types.ts is a site build input")
  })

  it("derives the real site's inputs from its graph: the build entry, the probe packages it imports, not this gate", () => {
    const terminfoRoot = join(import.meta.dirname, "..")
    const inputs = siteBuildInputs(terminfoRoot)
    expect(inputs.files.has("scripts/site-build.ts")).toBe(true)
    for (const path of [
      "packages/probe-defs/src/types.ts",
      "packages/run-parser/package.json",
      "content/features.json",
      "docs/index.md",
    ]) {
      expect(isSiteBuildInput(path, inputs), path).toBe(true)
    }
    expect(isSiteBuildInput("scripts/check-merge.ts", inputs)).toBe(false)
    expect(isSiteBuildInput("packages/probe-defs/src/types.test.ts", inputs)).toBe(false)
  })
})
