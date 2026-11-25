// @testonly none
import { afterEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkStoredRunSourceHistory, runTerminfoMergeCheck, type ExecFn } from "./check-merge.ts"

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
    expect(res).toEqual({ skipped: true, checkedRuns: 0 })
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
})
