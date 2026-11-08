/**
 * @failure The screen reader settles for an ambient session, reports a line count from a stale or
 *   missing hardcopy, or turns a failed hardcopy into a zero-line measurement.
 * @level l1
 * @consumer OwnedTerminal Linux screen scrollback reading for the 31744 history cells.
 * @testonly none
 */
import { beforeEach, expect, test, vi } from "vitest"

const run = vi.hoisted(() => vi.fn())
const readFile = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ spawnSync: run }))
vi.mock("node:fs", () => ({ readFileSync: readFile }))
import { readScreenScrollback } from "./linux-screen-text.ts"

const options = {
  executable: "screen",
  session: "31744.pts-0.host",
  socketDirectory: "/run/owned/screen",
  hardcopyPath: "/run/owned/hardcopy.txt",
}
beforeEach(() => {
  run.mockReset()
  readFile.mockReset()
})
function exit(status: number, stdout = "", stderr = "") {
  run.mockReturnValue({ status, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) })
}

test("reads the owned session hardcopy and counts every retained line", () => {
  exit(0)
  readFile.mockReturnValue("one\ntwo\nthree\n")
  expect(readScreenScrollback(options)).toMatchObject({ status: "read", totalLines: 3 })
  expect(run).toHaveBeenCalledWith(
    options.executable,
    ["-S", options.session, "-X", "hardcopy", "-h", options.hardcopyPath],
    expect.objectContaining({
      stdio: ["pipe", "pipe", "pipe"],
      env: expect.objectContaining({ SCREENDIR: options.socketDirectory }),
    }),
  )
  expect(readFile).toHaveBeenCalledWith(options.hardcopyPath, "utf8")
})

test("an unterminated last line is still a retained line", () => {
  exit(0)
  readFile.mockReturnValue("one\ntwo\nthree")
  expect(readScreenScrollback(options)).toMatchObject({ status: "read", totalLines: 3 })
})

test("no explicit session never reaches an ambient one", () => {
  expect(readScreenScrollback({ ...options, session: undefined })).toMatchObject({ status: "refused" })
  expect(readScreenScrollback({ ...options, session: "  " })).toMatchObject({ status: "refused" })
  expect(run).not.toHaveBeenCalled()
  expect(readFile).not.toHaveBeenCalled()
})

test("the owned socket directory is the one the child is told to read", () => {
  exit(0)
  readFile.mockReturnValue("one\n")
  expect(readScreenScrollback({ ...options, socketDirectory: "/run/owned/other" })).toMatchObject({
    status: "read",
    totalLines: 1,
  })
  expect(run.mock.calls[0]?.[2]?.env?.SCREENDIR).toBe("/run/owned/other")
})

test("a socket directory holding no session refuses with its reason, never zero lines", () => {
  exit(1, "", "No screen session found.")
  const result = readScreenScrollback({ ...options, socketDirectory: "/run/owned/empty" })
  expect(result.status).toBe("refused")
  if (result.status !== "refused") throw new Error("Expected a refusal")
  expect(result.reason).toContain("No screen session found.")
  expect(result.reason).toContain("/run/owned/empty")
  expect(readFile).not.toHaveBeenCalled()
})

test("a blank or relative socket directory is refused before any spawn", () => {
  for (const socketDirectory of ["", "   ", "run/owned/screen"]) {
    expect(readScreenScrollback({ ...options, socketDirectory })).toMatchObject({ status: "refused" })
  }
  expect(run).not.toHaveBeenCalled()
  expect(readFile).not.toHaveBeenCalled()
})

test("a hardcopy that was never written is a refusal naming the path, not zero lines", () => {
  exit(0)
  readFile.mockImplementation(() => {
    throw Object.assign(new Error("no such file"), { code: "ENOENT" })
  })
  const result = readScreenScrollback(options)
  expect(result.status).toBe("refused")
  if (result.status !== "refused") throw new Error("Expected a refusal")
  expect(result.reason).toContain(options.hardcopyPath)
})

test("a failed hardcopy retains its exit and stderr", () => {
  exit(11, "", "no screen session")
  const result = readScreenScrollback(options)
  expect(result.status).toBe("refused")
  if (result.status !== "refused") throw new Error("Expected a refusal")
  expect(result.reason).toContain("11")
  expect(result.reason).toContain("no screen session")
  expect(readFile).not.toHaveBeenCalled()
})
