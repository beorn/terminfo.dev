/**
 * @failure The private startup experiment retries launch or closes a different window after a failed identity check.
 * @level l1
 * @consumer Chief-granted one-attempt hosted startup workflow, not feature collection.
 * @testonly none
 */
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, test, vi } from "vitest"
import { parse } from "yaml"

const workflow = parse(await readFile(new URL("../.github/workflows/macos-measurement.yml", import.meta.url), "utf8"))
const steps = workflow.jobs["iterm-startup-only"].steps
const body = steps.find((step: { name?: string }) => step.name?.startsWith("One startup")).run
const source = /^bun --eval '\n([\s\S]*)\n'\n?$/.exec(body)?.[1]
if (!source) throw new Error("Expected exact Bun measurement step")
const measurementSource = source
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

async function exercise(mode: "success" | "launch-timeout" | "wrong-id") {
  const calls: string[][] = []
  const files = new Map<string, string>()
  let censuses = 0
  let processes = 0
  const spawnSync = vi.fn((file: string, args: string[]) => {
    const argv = [file, ...args]
    calls.push(argv)
    let stdout = ""
    if (file.endsWith("PlistBuddy")) stdout = args[1]?.includes("Identifier") ? "com.googlecode.iterm2\n" : "3.6.11\n"
    if (file.endsWith("pgrep")) {
      processes++
      if (processes === 1) return { status: 1, stdout: "", stderr: "" }
      stdout = "456\n"
    }
    if (file.endsWith("defaults") && args[0] === "read") stdout = "1\n"
    if (file.endsWith("osascript") && args[0] === "-l") {
      censuses++
      stdout = JSON.stringify(censuses === 2 ? [{ pid: 456, layer: 0, cgWindowNumber: 999 }] : [])
    }
    if (file.endsWith("osascript") && args[0] === "-e") stdout = "27\n"
    if (file === "fixture-bun" && args[1]?.includes("launchIterm")) {
      if (mode === "launch-timeout") {
        return {
          status: null,
          signal: "SIGKILL",
          error: new Error("ETIMEDOUT"),
          stdout: "",
          stderr: "Automation denied",
        }
      }
      stdout = mode === "wrong-id" ? "28\n" : "27\n"
    }
    return { status: 0, stdout, stderr: "" }
  })
  const fakeProcess = { execPath: "fixture-bun", env: { RUNNER_TEMP: "/fixture" }, exitCode: 0 }
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    await new AsyncFunction(
      "process",
      "Bun",
      "native",
      "path",
      measurementSource
        .replace('await import("node:child_process")', "native")
        .replace('await import("node:path")', "path"),
    )(
      fakeProcess,
      { write: async (path: string, data: string) => files.set(path, data), sleep: async () => {} },
      { spawnSync },
      path,
    )
  } finally {
    error.mockRestore()
  }
  const launches = calls.filter((argv) => argv[0] === "fixture-bun" && argv[2]?.includes("launchIterm"))
  const closes = calls.filter((argv) => argv[0] === "fixture-bun" && argv[2]?.includes("closeIterm"))
  const result = JSON.parse(files.get("/fixture/measurement-artifacts/startup-result.json")!) as {
    returnedIdClosesWindow: { disappeared: boolean }
    processAfterClose: { running: boolean }
    failures: string[]
  }
  return { launches, closes, result, exitCode: fakeProcess.exitCode }
}

test("one launch closes its AppleScript id without treating the CoreGraphics number as that id", async () => {
  const r = await exercise("success")
  expect(r.launches).toHaveLength(1)
  expect(r.closes).toHaveLength(1)
  expect(r.closes[0]?.[2]).toContain("closeIterm(27)")
  expect(r.result.returnedIdClosesWindow.disappeared).toBe(true)
  expect(r.result.processAfterClose.running).toBe(true)
  expect(r.exitCode).toBe(0)
})

test.each(["launch-timeout", "wrong-id"] as const)(
  "%s retains evidence without retrying or closing a different window",
  async (mode) => {
    const r = await exercise(mode)
    expect(r.launches).toHaveLength(1)
    expect(r.closes).toHaveLength(0)
    expect(r.result.failures.length).toBeGreaterThan(0)
    expect(r.exitCode).toBe(1)
  },
)
