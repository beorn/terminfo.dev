/**
 * @failure The Linux Kitty reader invents a scroll offset, reads a window it was not launched as, accepts a
 *   short or unterminated screen, or discards the failed command's bytes instead of naming it unavailable.
 * @level l1
 * @consumer OwnedTerminal Linux Kitty scrollback and visible-row counts.
 * @testonly none
 */
import { beforeEach, expect, test, vi } from "vitest"

const run = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ spawnSync: run }))
import { readLinuxKittyScrollback } from "./linux-kitty-text.ts"

const options = { kitten: "/nix/store/owned/bin/kitten", socket: "unix:/tmp/run-1/kitty-1.sock", window: "7" }
beforeEach(() => run.mockReset())
function answer(stdout: string, status = 0, stderr = "") {
  run.mockReturnValue({ status, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) })
}
const rows = (count: number) => Array.from({ length: count }, (_, index) => `r${index}`).join("\n") + "\n"

test("the reader reports the scrollback and visible counts and never a viewport offset", () => {
  run.mockReturnValueOnce({ status: 0, signal: null, stdout: Buffer.from(rows(30)), stderr: Buffer.from("") })
  run.mockReturnValueOnce({ status: 0, signal: null, stdout: Buffer.from(rows(24)), stderr: Buffer.from("") })
  const result = readLinuxKittyScrollback(options)
  expect(result).toMatchObject({ status: "read", totalLines: 30, screenLines: 24 })
  // Kitty exposes no scrolled_by through remote control, so an offset here would be a bottom assumption.
  expect(result).not.toHaveProperty("viewportOffset")
})

test("each read names this run's socket, window and extent", () => {
  run.mockReturnValue({ status: 0, signal: null, stdout: Buffer.from(rows(2)), stderr: Buffer.from("") })
  readLinuxKittyScrollback(options)
  expect(run.mock.calls.map((call) => call[1])).toEqual([
    ["@", "--to", options.socket, "get-text", "--extent", "all", "--match", `id:${options.window}`],
    ["@", "--to", options.socket, "get-text", "--extent", "screen", "--match", `id:${options.window}`],
  ])
})

test.each([
  ["an ambient socket", { socket: "/tmp/ambient.sock" }],
  ["a non-numeric window", { window: "all" }],
  ["a zero window id", { window: "0" }],
])("a read without this run's own socket and window is refused: %s", (_label, override) => {
  expect(readLinuxKittyScrollback({ ...options, ...override })).toMatchObject({ status: "refused" })
  expect(run).not.toHaveBeenCalled()
})

test("a failed connection retains exit, stderr and partial bytes", () => {
  answer("partial\n", 17, "owned socket refused")
  const result = readLinuxKittyScrollback(options)
  expect(result.status).toBe("refused")
  if (result.status !== "refused") throw new Error("Expected a refusal")
  expect(result.reason).toContain('"status":17')
  expect(result.reason).toContain(Buffer.from("partial\n").toString("base64"))
})

test("an unterminated screen is refused with its actual bytes", () => {
  run.mockReturnValueOnce({ status: 0, signal: null, stdout: Buffer.from(rows(4)), stderr: Buffer.from("") })
  answer("r0\nr1")
  const result = readLinuxKittyScrollback(options)
  expect(result.status).toBe("refused")
  if (result.status !== "refused") throw new Error("Expected a refusal")
  expect(result.reason).toContain(Buffer.from("r0\nr1").toString("base64"))
})

test("a visible screen taller than the scrollback is refused, never clamped", () => {
  run.mockReturnValueOnce({ status: 0, signal: null, stdout: Buffer.from(rows(3)), stderr: Buffer.from("") })
  run.mockReturnValueOnce({ status: 0, signal: null, stdout: Buffer.from(rows(5)), stderr: Buffer.from("") })
  expect(readLinuxKittyScrollback(options)).toMatchObject({ status: "refused" })
})
