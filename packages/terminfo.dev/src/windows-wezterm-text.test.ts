/**
 * @failure The WezTerm CLI reads an ambient pane, changes the measured console, silently pads a
 *   truncated screen, or discards the failed command's bytes instead of naming it unavailable.
 * @level l1
 * @consumer OwnedTerminal Windows WezTerm text and host-ownership witness.
 * @testonly none
 */
import { beforeEach, expect, test, vi } from "vitest"

const run = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ spawnSync: run }))
import { readWindowsWezTermRows, readWindowsWezTermText } from "./windows-wezterm-text.ts"

const options = { executable: "C:\\owned\\wezterm.exe", pane: "42", socket: "C:\\owned\\gui.sock", rows: 2, cols: 8 }
// Visible text cannot select history; only the row reader accepts that input.
// @ts-expect-error startLine is excluded from the visible-only entry point.
void ({ ...options, startLine: -2147483648 } satisfies Parameters<typeof readWindowsWezTermText>[0])
beforeEach(() => run.mockReset())
function answer(stdout: string, status = 0, stderr = "") {
  run.mockReturnValue({ status, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) })
}

test.each(["\n", "\r\n"])("owned pane text preserves gaps and a blank last row with %j terminators", (eol) => {
  answer(`A  B${eol}${eol}`)
  expect(readWindowsWezTermText(options)).toMatchObject({
    status: "read",
    app: "wezterm",
    cells: { cols: 8, rows: 2, text: ["A  B    ", "        "], paddedRows: [1, 2], droppedLines: 0 },
  })
  expect(run).toHaveBeenCalledWith(
    options.executable,
    ["cli", "--no-auto-start", "get-text", "--pane-id", "42", "--start-line", "0", "--end-line", "1"],
    expect.objectContaining({
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: expect.objectContaining({ WEZTERM_UNIX_SOCKET: options.socket, WEZTERM_PANE: options.pane }),
    }),
  )
})

test("a missing owned pane cannot select the focused pane or start a server", () => {
  expect(readWindowsWezTermRows({ ...options, pane: undefined })).toMatchObject({ status: "refused" })
  expect(run).not.toHaveBeenCalled()
})

test.each(["A\n", "A\n\n", ""])(
  "a short or unterminated screen is unavailable with actual stdout retained: %j",
  (stdout) => {
    answer(stdout)
    const result = readWindowsWezTermRows({ ...options, rows: 3 })
    expect(result.status).toBe("refused")
    if (result.status !== "refused") throw new Error("Expected unavailable rows")
    expect(result.reason).toContain(`"stdoutBase64":${JSON.stringify(Buffer.from(stdout).toString("base64"))}`)
  },
)

test("failed connection retains exit, stderr and partial bytes without another route", () => {
  answer("partial\n", 17, "owned socket refused")
  const result = readWindowsWezTermRows(options)
  expect(result.status).toBe("refused")
  if (result.status !== "refused") throw new Error("Expected unavailable connection")
  expect(result.reason).toContain('"status":17')
  expect(result.reason).toContain(Buffer.from("partial\n").toString("base64"))
  expect(result.reason).toContain(Buffer.from("owned socket refused").toString("base64"))
  expect(run).toHaveBeenCalledTimes(1)
})

// History counts must include physical blank rows; the visible-grid suite cannot catch a
// history request accidentally retaining its old zero start or rejecting extra history rows.
test("owned history reads negative start through the same CLI and preserves physical rows", () => {
  answer("old\n\nA\n\n")
  const read = readWindowsWezTermRows({ ...options, startLine: -2147483648 })
  expect(read).toMatchObject({ status: "read", rows: ["old", "", "A", ""] })
  expect(read).not.toHaveProperty("viewportOffset")
  expect(run).toHaveBeenCalledWith(
    options.executable,
    ["cli", "--no-auto-start", "get-text", "--pane-id", "42", "--start-line", "-2147483648", "--end-line", "1"],
    expect.objectContaining({
      env: expect.objectContaining({ WEZTERM_UNIX_SOCKET: options.socket, WEZTERM_PANE: options.pane }),
    }),
  )
})
