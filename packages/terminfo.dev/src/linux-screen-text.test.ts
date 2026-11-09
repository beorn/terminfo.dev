/**
 * @failure The screen reader settles for an ambient session, reports a line count from a stale or
 *   missing hardcopy, or turns a failed hardcopy into a zero-line measurement.
 * @level l1
 * @consumer OwnedTerminal Linux screen scrollback reading for the 31744 history cells.
 * @testonly none
 */
import { beforeEach, expect, test, vi } from "vitest"

const run = vi.hoisted(() => vi.fn())
const exists = vi.hoisted(() => vi.fn(() => false))
const readFile = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ spawnSync: run }))
vi.mock("node:fs", () => ({ existsSync: exists, readFileSync: readFile }))
import { readScreenScrollback } from "./linux-screen-text.ts"

const options = {
  executable: "screen",
  session: "31744.pts-0.host",
  socketDirectory: "/run/owned/screen",
  hardcopyPath: "/run/owned/hardcopy.txt",
  rows: 2,
  capacity: 1,
}
beforeEach(() => {
  run.mockReset()
  exists.mockReset()
  exists.mockReturnValue(false)
  readFile.mockReset()
  vi.restoreAllMocks()
})
function exit(status: number, stdout = "", stderr = "") {
  run.mockReturnValue({ status, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) })
}

test("reads the owned session hardcopy and counts retained history plus screen rows", () => {
  exit(0)
  readFile.mockReturnValue("one\ntwo\nthree\n")
  expect(readScreenScrollback(options)).toMatchObject({ status: "read", totalLines: 3, screenLines: 2 })
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
  expect(readScreenScrollback(options)).toMatchObject({ status: "read", totalLines: 3, screenLines: 2 })
})

test("120-line capacity-padded dump with no history reports 0 history lines, seeded rows report their count, full capacity reports 100, and dumps shorter than rows or without rows refuse (#32784, #32786)", () => {
  exit(0)
  const configPath = "/run/owned/screenrc"
  const mockDump = (dump: string) => {
    readFile.mockImplementation((path: string) => (path === configPath ? "defscrollback 100\n" : dump))
  }
  // (1) 120-line padded dump (defscrollback 100 + 20 screen rows) with no history -> 0 history lines (totalLines = 20, screenLines = 20).
  const screen20 = Array.from({ length: 20 }, (_, i) => `screen-${i}`).join("\n") + "\n"
  mockDump("\n".repeat(100) + screen20)
  expect(readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })).toMatchObject({
    status: "read",
    totalLines: 20,
    screenLines: 20,
  })

  // (2) Seeded rows inside the 100-line history region (after 88 blank capacity-padding lines, including an interior blank line) -> their count (12).
  const seeded12 = ["seed-0", "seed-1", "", ...Array.from({ length: 9 }, (_, i) => `seed-${i + 3}`)].join("\n") + "\n"
  mockDump("\n".repeat(88) + seeded12 + screen20)
  expect(readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })).toMatchObject({
    status: "read",
    totalLines: 32,
    screenLines: 20,
  })

  // (3) Full 100-line history capacity -> 100 history lines (totalLines = 120, screenLines = 20, capacity = 100).
  const full100 = Array.from({ length: 100 }, (_, i) => `hist-${i}`).join("\n") + "\n"
  mockDump(full100 + screen20)
  expect(readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })).toMatchObject({
    status: "read",
    totalLines: 120,
    screenLines: 20,
    capacity: 100,
  })

  // (4) Dump shorter than capacity + rows -> refused loudly naming the file and both counts; unknown/invalid rows -> refused loudly.
  let now = 1000
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000))
  mockDump(Array.from({ length: 19 }, (_, i) => `row-${i}`).join("\n") + "\n")
  const tooShort = readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })
  expect(tooShort.status).toBe("refused")
  if (tooShort.status !== "refused") throw new Error("Expected a refusal")
  expect(tooShort.reason).toContain(options.hardcopyPath)
  expect(tooShort.reason).toContain("19")
  expect(tooShort.reason).toContain("120")
  expect(tooShort.reason).toContain("20")

  for (const invalidRows of [undefined, 0, -5, Number.NaN]) {
    const unknownRows = readScreenScrollback({ ...options, rows: invalidRows })
    expect(unknownRows.status).toBe("refused")
    if (unknownRows.status !== "refused") throw new Error("Expected a refusal")
    expect(unknownRows.reason).toContain(options.hardcopyPath)
  }
})

test("content-proven completion: late write, partial write across stable-size reads, deadline refusal, pre-existing path, and wrong line count (#32786)", () => {
  const configPath = "/run/owned/screenrc"
  const screen20 = Array.from({ length: 20 }, (_, i) => `screen-${i}`).join("\n") + "\n"
  const seeded12 = Array.from({ length: 12 }, (_, i) => `seed-${i}`).join("\n") + "\n"
  const complete120 = "\n".repeat(88) + seeded12 + screen20
  const partial81 = "\n".repeat(81)

  // (1) Late write: ENOENT first, empty second, then complete 120 lines.
  exit(0)
  let lateCalls = 0
  readFile.mockImplementation((path: string) => {
    if (path === configPath) return "defscrollback 100\n"
    lateCalls += 1
    if (lateCalls === 1) throw Object.assign(new Error("no such file"), { code: "ENOENT" })
    if (lateCalls === 2) return ""
    return complete120
  })
  expect(readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })).toMatchObject({
    status: "read",
    totalLines: 32,
    screenLines: 20,
  })
  expect(lateCalls).toBe(3)

  // (2) Partial write: 81 lines across two consecutive reads (proving size stability alone is rejected), then complete 120 lines.
  let partialCalls = 0
  readFile.mockImplementation((path: string) => {
    if (path === configPath) return "defscrollback 100\n"
    partialCalls += 1
    return partialCalls < 3 ? partial81 : complete120
  })
  expect(readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })).toMatchObject({
    status: "read",
    totalLines: 32,
    screenLines: 20,
  })
  expect(partialCalls).toBe(3)

  // (3) Never completes within the 2 s deadline: refusal names path, bytes and lines seen vs expected, and wait.
  let now = 5000
  vi.spyOn(Date, "now").mockImplementation(() => (now += 500))
  readFile.mockImplementation((path: string) => (path === configPath ? "defscrollback 100\n" : partial81))
  const incomplete = readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })
  expect(incomplete.status).toBe("refused")
  if (incomplete.status !== "refused") throw new Error("Expected a refusal")
  expect(incomplete.reason).toContain(options.hardcopyPath)
  expect(incomplete.reason).toContain("81 bytes")
  expect(incomplete.reason).toContain("81 lines")
  expect(incomplete.reason).toContain("expected 120 lines (100 capacity + 20 screen rows)")
  expect(incomplete.reason).toContain("2000ms")

  // (4) Path already exists before hardcopy: refused before spawning screen.
  run.mockReset()
  exists.mockReturnValue(true)
  const stale = readScreenScrollback({ ...options, rows: 20, capacity: 100 })
  expect(stale.status).toBe("refused")
  if (stale.status !== "refused") throw new Error("Expected a refusal")
  expect(stale.reason).toContain(options.hardcopyPath)
  expect(stale.reason).toMatch(/already exists/i)
  expect(run).not.toHaveBeenCalled()
  exists.mockReturnValue(false)

  // (5) Wrong line count (> capacity + rows) and missing defscrollback in config.
  exit(0)
  readFile.mockImplementation((path: string) =>
    path === configPath ? "defscrollback 100\n" : "\n".repeat(101) + screen20,
  )
  const tooMany = readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })
  expect(tooMany.status).toBe("refused")
  if (tooMany.status !== "refused") throw new Error("Expected a refusal")
  expect(tooMany.reason).toContain(options.hardcopyPath)
  expect(tooMany.reason).toContain("121")
  expect(tooMany.reason).toContain("120")

  run.mockReset()
  readFile.mockImplementation((path: string) => (path === configPath ? "# no scrollback\n" : complete120))
  const missingConfig = readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })
  expect(missingConfig.status).toBe("refused")
  if (missingConfig.status !== "refused") throw new Error("Expected a refusal")
  expect(missingConfig.reason).toContain(configPath)
  expect(missingConfig.reason).toContain("defscrollback")
  expect(run).not.toHaveBeenCalled()
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
  expect(readScreenScrollback({ ...options, rows: 1, capacity: 0, socketDirectory: "/run/owned/other" })).toMatchObject(
    {
      status: "read",
      totalLines: 1,
      screenLines: 1,
    },
  )
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
  let now = 1000
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000))
  readFile.mockImplementation(() => {
    throw Object.assign(new Error("no such file"), { code: "ENOENT" })
  })
  const result = readScreenScrollback(options)
  expect(result.status).toBe("refused")
  if (result.status !== "refused") throw new Error("Expected a refusal")
  expect(result.reason).toContain(options.hardcopyPath)
})

test("an empty hardcopy is refused rather than measured as zero lines", () => {
  exit(0)
  let now = 1000
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000))
  readFile.mockReturnValue("")
  const result = readScreenScrollback(options)
  expect(result.status).toBe("refused")
  if (result.status !== "refused") throw new Error("Expected a refusal")
  expect(result.reason).toContain("empty")
  expect(result.reason).toContain(options.hardcopyPath)
})

test("a timed-out hardcopy is killed within the reader bound and no partial file is read", () => {
  run.mockReturnValue({
    status: null,
    signal: "SIGKILL",
    error: Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" }),
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
  })
  expect(readScreenScrollback(options).status).toBe("refused")
  const spawnOptions = run.mock.calls[0]?.[2]
  expect({ timeout: spawnOptions?.timeout, killSignal: spawnOptions?.killSignal }).toEqual({
    timeout: 3000,
    killSignal: "SIGKILL",
  })
  expect(readFile).not.toHaveBeenCalled()
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
