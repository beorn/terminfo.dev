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
import { readScreenScrollback, resetScreenScrollback } from "./linux-screen-text.ts"

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

test("dump with no history reports 0 history lines, seeded rows report their count including leading blank lines, full capacity reports capacity, and dumps outside [rows, capacity + rows] or without rows refuse (#32784, #32786, #32787)", () => {
  exit(0)
  const configPath = "/run/owned/screenrc"
  const mockDump = (dump: string) => {
    readFile.mockImplementation((path: string) => (path === configPath ? "defscrollback 100\n" : dump))
  }
  // (1) 20-line dump (0 used history + 20 screen rows) -> 0 history lines (totalLines = 20, screenLines = 20).
  const screen20 = Array.from({ length: 20 }, (_, i) => `screen-${i}`).join("\n") + "\n"
  mockDump(screen20)
  expect(readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })).toMatchObject({
    status: "read",
    totalLines: 20,
    screenLines: 20,
  })

  // (2) 12 used history rows + 20 screen rows -> 12 history lines (totalLines = 32, screenLines = 20).
  const seeded12 = ["seed-0", "seed-1", "", ...Array.from({ length: 9 }, (_, i) => `seed-${i + 3}`)].join("\n") + "\n"
  mockDump(seeded12 + screen20)
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

  // (4) Dump shorter than rows -> refused loudly naming the file and bounds; unknown/invalid rows -> refused loudly.
  mockDump(Array.from({ length: 19 }, (_, i) => `row-${i}`).join("\n") + "\n")
  const tooShort = readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })
  expect(tooShort.status).toBe("refused")
  if (tooShort.status !== "refused") throw new Error("Expected a refusal")
  expect(tooShort.reason).toContain(options.hardcopyPath)
  expect(tooShort.reason).toContain("19")
  expect(tooShort.reason).toContain("20..120")

  for (const invalidRows of [undefined, 0, -5, Number.NaN]) {
    const unknownRows = readScreenScrollback({ ...options, rows: invalidRows })
    expect(unknownRows.status).toBe("refused")
    if (unknownRows.status !== "refused") throw new Error("Expected a refusal")
    expect(unknownRows.reason).toContain(options.hardcopyPath)
  }
})

test("-Q number completion fence ordering, pre-existing path, line count > capacity + rows, and missing config defscrollback (#32786, #32787)", () => {
  const configPath = "/run/owned/screenrc"
  const screen20 = Array.from({ length: 20 }, (_, i) => `screen-${i}`).join("\n") + "\n"
  const seeded12 = Array.from({ length: 12 }, (_, i) => `seed-${i}`).join("\n") + "\n"
  const dump32 = seeded12 + screen20

  // (1) Screen writes the dump inside hardcopy before answering -Q number; read happens once after -Q number.
  let dumpWritten = false
  let dumpReads = 0
  run.mockImplementation((_exe: string, args: string[]) => {
    if (args.includes("hardcopy")) {
      return { status: 0, signal: null, stdout: Buffer.from(""), stderr: Buffer.from("") }
    }
    if (args.includes("-Q")) {
      dumpWritten = true
      return { status: 0, signal: null, stdout: Buffer.from("0 (bash)\n"), stderr: Buffer.from("") }
    }
    return { status: 1, signal: null, stdout: Buffer.from(""), stderr: Buffer.from("unexpected args") }
  })
  readFile.mockImplementation((path: string) => {
    if (path === configPath) return "defscrollback 100\n"
    dumpReads += 1
    if (!dumpWritten) throw new Error("readFile called before -Q number completion fence")
    return dump32
  })
  expect(readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })).toMatchObject({
    status: "read",
    totalLines: 32,
    screenLines: 20,
    capacity: 100,
  })
  expect(dumpReads).toBe(1)
  expect(run.mock.calls.map((call) => call[1])).toEqual([
    ["-S", options.session, "-X", "hardcopy", "-h", options.hardcopyPath],
    ["-S", options.session, "-Q", "number"],
  ])

  // (2) Path already exists before hardcopy: refused before spawning screen.
  run.mockReset()
  exists.mockReturnValue(true)
  const stale = readScreenScrollback({ ...options, rows: 20, capacity: 100 })
  expect(stale.status).toBe("refused")
  if (stale.status !== "refused") throw new Error("Expected a refusal")
  expect(stale.reason).toContain(options.hardcopyPath)
  expect(stale.reason).toMatch(/already exists/i)
  expect(run).not.toHaveBeenCalled()
  exists.mockReturnValue(false)

  // (3) Wrong line count (> capacity + rows) and missing defscrollback in config.
  exit(0)
  readFile.mockImplementation((path: string) =>
    path === configPath ? "defscrollback 100\n" : "\n".repeat(101) + screen20,
  )
  const tooMany = readScreenScrollback({ ...options, rows: 20, capacity: undefined, configPath })
  expect(tooMany.status).toBe("refused")
  if (tooMany.status !== "refused") throw new Error("Expected a refusal")
  expect(tooMany.reason).toContain(options.hardcopyPath)
  expect(tooMany.reason).toContain("121")
  expect(tooMany.reason).toContain("20..120")

  run.mockReset()
  readFile.mockImplementation((path: string) => (path === configPath ? "# no scrollback\n" : dump32))
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
  readFile.mockReturnValue("")
  const result = readScreenScrollback(options)
  expect(result.status).toBe("refused")
  if (result.status !== "refused") throw new Error("Expected a refusal")
  expect(result.reason).toContain("empty")
  expect(result.reason).toContain(options.hardcopyPath)
})

test("a timed-out hardcopy or reset is killed within the bound, surfaces signal and error, and reads no partial file (#32874)", () => {
  const timedOut = {
    status: null,
    signal: "SIGKILL" as const,
    error: Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" }),
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
  }
  run.mockReturnValue(timedOut)
  const hardcopyResult = readScreenScrollback(options)
  expect(hardcopyResult.status).toBe("refused")
  if (hardcopyResult.status !== "refused") throw new Error("Expected a refusal")
  expect(hardcopyResult.reason).toContain("signal=SIGKILL")
  expect(hardcopyResult.reason).toContain("spawnSync timed out")
  const spawnOptions = run.mock.calls[0]?.[2]
  expect({ timeout: spawnOptions?.timeout, killSignal: spawnOptions?.killSignal }).toEqual({
    timeout: 3000,
    killSignal: "SIGKILL",
  })
  expect(readFile).not.toHaveBeenCalled()

  run.mockReset()
  readFile.mockReturnValue("defscrollback 1000\n")
  run.mockReturnValue(timedOut)
  const resetResult = resetScreenScrollback({
    executable: options.executable,
    session: options.session,
    socketDirectory: options.socketDirectory,
    configPath: "/run/owned/screenrc",
  })
  expect(resetResult.status).toBe("refused")
  if (resetResult.status !== "refused") throw new Error("Expected a refusal")
  expect(resetResult.reason).toContain("signal=SIGKILL")
  expect(resetResult.reason).toContain("spawnSync timed out")
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

test("a 920-line partial-capacity dump with capacity 1000 and 20 rows reads 900 history lines (#32787)", () => {
  exit(0)
  const dump920 = Array.from({ length: 920 }, (_, i) => `line-${i}`).join("\n") + "\n"
  readFile.mockReturnValue(dump920)
  expect(readScreenScrollback({ ...options, rows: 20, capacity: 1000 })).toMatchObject({
    status: "read",
    totalLines: 920,
    screenLines: 20,
    capacity: 1000,
  })
})

test("a 1020-line full-capacity dump with 17 leading blank lines counts 1000 history lines (#32787)", () => {
  exit(0)
  const dump1020 = "\n".repeat(17) + Array.from({ length: 1003 }, (_, i) => `line-${i}`).join("\n") + "\n"
  readFile.mockReturnValue(dump1020)
  expect(readScreenScrollback({ ...options, rows: 20, capacity: 1000 })).toMatchObject({
    status: "read",
    totalLines: 1020,
    screenLines: 20,
    capacity: 1000,
  })
})

test("a failing -Q number completion query refuses without trusting the dump (#32787)", () => {
  const dump1020 = Array.from({ length: 1020 }, (_, i) => `line-${i}`).join("\n") + "\n"
  readFile.mockReturnValue(dump1020)
  run.mockImplementation((_exe: string, args: string[]) =>
    args.includes("-Q")
      ? { status: 1, signal: null, stdout: Buffer.from(""), stderr: Buffer.from("query socket failed") }
      : { status: 0, signal: null, stdout: Buffer.from(""), stderr: Buffer.from("") },
  )
  const result = readScreenScrollback({ ...options, rows: 20, capacity: 1000 })
  expect(result.status).toBe("refused")
  if (result.status !== "refused") throw new Error("Expected a refusal")
  expect(result.reason).toContain("-Q number")
  expect(result.reason).toContain("query socket failed")
  expect(readFile).not.toHaveBeenCalled()
})

test("resetScreenScrollback reads defscrollback from owned config and runs scrollback 0 then scrollback <N> on SCREENDIR (#32801)", () => {
  exit(0)
  const configPath = "/run/owned/screenrc"
  readFile.mockImplementation((path: string) => {
    if (path === configPath) return "# owned screenrc\ndefscrollback 1000\n"
    throw new Error(`unexpected readFile(${path})`)
  })
  expect(
    resetScreenScrollback({
      executable: options.executable,
      session: options.session,
      socketDirectory: options.socketDirectory,
      configPath,
    }),
  ).toEqual({ status: "reset", capacity: 1000 })
  expect(
    run.mock.calls.map((call) => [call[0], call[1], call[2]?.env?.SCREENDIR, call[2]?.timeout, call[2]?.killSignal]),
  ).toEqual([
    [options.executable, ["-S", options.session, "-X", "scrollback", "0"], options.socketDirectory, 3000, "SIGKILL"],
    [options.executable, ["-S", options.session, "-X", "scrollback", "1000"], options.socketDirectory, 3000, "SIGKILL"],
  ])
})

test("resetScreenScrollback refuses missing session, relative socketDirectory, bad config, and non-zero command exits (#32801)", () => {
  const configPath = "/run/owned/screenrc"
  const resetOpts = {
    executable: options.executable,
    session: options.session,
    socketDirectory: options.socketDirectory,
    configPath,
  }

  for (const session of [undefined, "", "   ", "bad session"]) {
    expect(resetScreenScrollback({ ...resetOpts, session })).toMatchObject({ status: "refused" })
  }
  for (const socketDirectory of ["", "   ", "relative/screen"]) {
    expect(resetScreenScrollback({ ...resetOpts, socketDirectory })).toMatchObject({ status: "refused" })
  }
  expect(run).not.toHaveBeenCalled()

  for (const configBody of [
    "# missing defscrollback\n",
    "defscrollback nope\n",
    "defscrollback 100\ndefscrollback 200\n",
  ]) {
    readFile.mockReturnValue(configBody)
    const badConfig = resetScreenScrollback(resetOpts)
    expect(badConfig.status).toBe("refused")
    if (badConfig.status !== "refused") throw new Error("Expected a refusal")
    expect(badConfig.reason).toContain(configPath)
  }
  expect(run).not.toHaveBeenCalled()

  readFile.mockReturnValue("defscrollback 1000\n")
  run.mockReturnValueOnce({ status: 2, signal: null, stdout: Buffer.from(""), stderr: Buffer.from("zero failed") })
  const failZero = resetScreenScrollback(resetOpts)
  expect(failZero.status).toBe("refused")
  if (failZero.status !== "refused") throw new Error("Expected a refusal")
  expect(failZero.reason).toContain("scrollback 0")
  expect(failZero.reason).toContain("zero failed")
  expect(run).toHaveBeenCalledTimes(1)

  run.mockReset()
  run
    .mockReturnValueOnce({ status: 0, signal: null, stdout: Buffer.from(""), stderr: Buffer.from("") })
    .mockReturnValueOnce({ status: 3, signal: null, stdout: Buffer.from(""), stderr: Buffer.from("restore failed") })
  const failRestore = resetScreenScrollback(resetOpts)
  expect(failRestore.status).toBe("refused")
  if (failRestore.status !== "refused") throw new Error("Expected a refusal")
  expect(failRestore.reason).toContain("scrollback 1000")
  expect(failRestore.reason).toContain("restore failed")
  expect(run).toHaveBeenCalledTimes(2)
})
