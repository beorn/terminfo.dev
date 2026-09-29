/**
 * @failure Exit-0 Cua refusals or incoherent window/image output become accepted captures.
 * @level l2
 * @consumer Internal native Mac capture reader at its process and file boundary
 * @reach fs-walk <fixture-only: reads only private generated capture files>
 * @testonly none
 */
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { inspect } from "node:util"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const child = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile: child.execFile }))
import { createCuaReader } from "./cua-capture.ts"

const executable = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver"
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
)
const binding = { pid: 15032, windowId: 801, bounds: { x: 643, y: 301, width: 1, height: 1 }, scale: 1 }
const temporary: string[] = []

// Sanitized projection of cua-call-live-3/{1,2,4}-stdout.json. Pixel dimensions
// and bounds match the valid 1x1 fixture instead of the private measured image.
function frame() {
  return {
    pid: binding.pid,
    window_id: binding.windowId,
    window_bounds: { ...binding.bounds },
    screenshot_frame_valid: true,
    screenshot_mime_type: "image/png",
    screenshot_width: 1,
    screenshot_height: 1,
    screenshot_scale: 1,
    background_input: {
      exact_window: { pid: binding.pid, window_id: binding.windowId, status: "matched" },
      observation: { frame_freshness: "unknown", one_shot_capture: "available" },
    },
  }
}

const permissions = {
  accessibility: true,
  screen_recording: true,
  direct_capture_status: "not_checked",
  direct_capture_error: null,
  screen_recording_capturable: null,
  source: {
    attribution: "driver-daemon",
    bundle_id: "com.trycua.driver",
    executable,
    pid: 6339,
    responsible_ppid: 1,
    disclaim_env: false,
  },
}

type Invocation = {
  args: string[]
  input: string
  outputPath?: string
}
function respond(
  result: unknown,
  produce: (call: Invocation) => void = () => {},
  error: NodeJS.ErrnoException | null = null,
  stderr = Buffer.alloc(0),
) {
  child.execFile.mockImplementation((_file, args, _options, done) => {
    const stdin = new EventEmitter() as EventEmitter & { end(input?: string): void }
    stdin.end = (input = "") => {
      const outputIndex = args.indexOf("--screenshot-out-file")
      const outputPath = outputIndex === -1 ? undefined : args[outputIndex + 1]
      if (outputPath) temporary.push(dirname(outputPath))
      produce({ args, input, outputPath })
      const stdout = typeof result === "string" ? Buffer.from(result) : Buffer.from(JSON.stringify(result))
      queueMicrotask(() => done(error, stdout, stderr))
    }
    return { stdin }
  })
}

function output(call: Invocation, bytes = png): void {
  if (!call.outputPath) throw new Error("Fixture expected screenshot output argument")
  expect(existsSync(call.outputPath)).toBe(false)
  expect(statSync(dirname(call.outputPath)).mode & 0o777).toBe(0o700)
  writeFileSync(call.outputPath, bytes, { mode: 0o644 })
}

beforeEach(() => child.execFile.mockReset())
afterEach(() => {
  for (const directory of new Set(temporary.splice(0))) rmSync(directory, { recursive: true, force: true })
})

test("reads the closed command set and retains a coherent static frame with exact bytes and private modes", async () => {
  const reader = createCuaReader(executable)
  const windows = [
    {
      pid: binding.pid,
      window_id: 801,
      bounds: { ...binding.bounds },
      title: "owned marker",
      is_on_screen: true,
      layer: 0,
    },
    {
      pid: binding.pid,
      window_id: 778,
      bounds: { x: 645, y: 289, width: 860, height: 499 },
      title: "other",
      is_on_screen: true,
      layer: 0,
    },
  ]
  respond({ current_space_id: 1, windows })
  const census = await reader.listWindows(binding.pid)
  expect(census.windows.map((window) => window.windowId)).toEqual([801, 778])
  expect(census.windows[1]?.bounds).toEqual(windows[1]!.bounds)
  expect(child.execFile).toHaveBeenLastCalledWith(
    executable,
    ["call", "list_windows"],
    expect.objectContaining({ timeout: 15_000, maxBuffer: 1024 * 1024, encoding: "buffer" }),
    expect.any(Function),
  )

  respond(permissions, ({ args, input }) => {
    expect(args).toEqual(["permissions", "status", "--json"])
    expect(input).toBe("")
  })
  expect(await reader.readPermissions()).toMatchObject({
    accessibility: true,
    screenRecording: true,
    directCaptureStatus: "not_checked",
    source: { pid: 6339, attribution: "driver-daemon" },
  })

  let path = ""
  respond(frame(), (call) => {
    expect(JSON.parse(call.input)).toEqual({ pid: binding.pid, window_id: binding.windowId, max_elements: 1 })
    expect(call.args.slice(0, 3)).toEqual(["call", "get_window_state", "--screenshot-out-file"])
    output(call)
    path = call.outputPath!
  })
  const captured = await reader.capture(binding)
  expect(captured.path).toBe(path)
  expect(captured.bytes.equals(png)).toBe(true)
  expect(readFileSync(path).equals(png)).toBe(true)
  expect(captured.sha256).toBe(createHash("sha256").update(png).digest("hex"))
  expect(captured).toMatchObject({ width: 1, height: 1, scale: 1, bounds: binding.bounds, frameFreshness: "unknown" })
  expect(captured.stdout.equals(Buffer.from(JSON.stringify(frame())))).toBe(true)
  expect(captured.stderr).toEqual(Buffer.alloc(0))
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
})

test.each(["pid refusal", "stale window"])("refuses measured exit-0 %s output", async (kind) => {
  const result =
    kind === "pid refusal"
      ? { code: "window_owner_pid_mismatch", owner_pid: 15032, pid: 22357, window_id: 801 }
      : {
          pid: 15032,
          window_id: 801,
          degraded: true,
          background_input: {
            exact_window: { pid: 15032, window_id: 801, status: "ax_unresolved" },
            observation: { frame_freshness: "unknown", one_shot_capture: "unavailable" },
          },
        }
  respond(result, output)
  await expect(createCuaReader(executable).capture(binding)).rejects.toThrow(/get_window_state.*15032.*801/)
})

test.each([
  "pid",
  "window",
  "exact pid",
  "exact window",
  "degraded",
  "invalid frame",
  "unmatched",
  "unavailable",
  "freshness",
  "bounds",
  "scale",
  "dimensions",
  "mime",
])("refuses incoherent %s frame metadata", async (kind) => {
  const result = frame()
  switch (kind) {
    case "pid":
      result.pid++
      break
    case "window":
      result.window_id++
      break
    case "exact pid":
      result.background_input.exact_window.pid++
      break
    case "exact window":
      result.background_input.exact_window.window_id++
      break
    case "degraded":
      Object.assign(result, { degraded: true })
      break
    case "invalid frame":
      result.screenshot_frame_valid = false
      break
    case "unmatched":
      result.background_input.exact_window.status = "ax_unresolved"
      break
    case "unavailable":
      result.background_input.observation.one_shot_capture = "unavailable"
      break
    case "freshness":
      result.background_input.observation.frame_freshness = "fresh"
      break
    case "bounds":
      result.window_bounds.x++
      break
    case "scale":
      result.screenshot_scale = 2
      break
    case "dimensions":
      result.screenshot_width = 2
      break
    case "mime":
      result.screenshot_mime_type = "application/octet-stream"
      break
  }
  respond(result, output)
  await expect(createCuaReader(executable).capture(binding)).rejects.toThrow(/get_window_state.*15032.*801/)
})

test.each(["missing file", "not PNG", "wrong PNG dimensions", "oversize", "directory mode"])(
  "refuses %s at the actual capture file boundary",
  async (kind) => {
    respond(frame(), (call) => {
      if (kind === "missing file") return
      const bytes = Buffer.from(png)
      if (kind === "not PNG") bytes[0] = 0
      if (kind === "wrong PNG dimensions") bytes.writeUInt32BE(2, 16)
      output(call, bytes)
      if (kind === "oversize") truncateSync(call.outputPath!, 32 * 1024 * 1024 + 1)
      if (kind === "directory mode") chmodSync(dirname(call.outputPath!), 0o755)
    })
    const error = await createCuaReader(executable)
      .capture(binding)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : "").toMatch(/get_window_state.*15032.*801/)
  },
)

test.each(["missing IDAT", "truncated IDAT", "corrupt IDAT", "corrupt CRC", "zlib checksum"])(
  "refuses structurally matching PNG with %s",
  async (kind) => {
    // Deflate mutations retain a correct IDAT CRC so a chunk-only check cannot pass this test.
    const invalidCompressed = {
      "truncated IDAT": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABUlEQVR4nGP4z++XbTYAAAAASUVORK5CYII=",
      "corrupt IDAT":
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nJz4z8DwHwAFAAH/k6KutwAAAABJRU5ErkJggg==",
      "zlib checksum":
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAEApJvSkAAAAABJRU5ErkJggg==",
    }
    const bytes =
      kind === "missing IDAT"
        ? Buffer.concat([png.subarray(0, 33), png.subarray(-12)])
        : kind in invalidCompressed
          ? Buffer.from(invalidCompressed[kind as keyof typeof invalidCompressed], "base64")
          : Buffer.from(png)
    if (kind === "corrupt CRC") bytes[54] = bytes[54]! ^ 0xff
    respond(frame(), (call) => output(call, bytes))
    const error = await createCuaReader(executable)
      .capture(binding)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : "").toMatch(/get_window_state.*15032.*801/)
  },
)

test.each(["interlaced PNG", "decoded pixel bound"])(
  "refuses %s before attempting an unbounded decode",
  async (kind) => {
    const result = frame()
    const expected = { ...binding, bounds: { ...binding.bounds } }
    const bytes =
      kind === "interlaced PNG"
        ? Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAFoEvQfAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
            "base64",
          )
        : Buffer.from(png)
    if (kind === "decoded pixel bound") {
      expected.bounds.width = 4 * 1024 * 1024
      result.window_bounds.width = expected.bounds.width
      result.screenshot_width = expected.bounds.width
      bytes.writeUInt32BE(expected.bounds.width, 16)
    }
    respond(result, (call) => output(call, bytes))
    const error = await createCuaReader(executable)
      .capture(expected)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : "").toMatch(/get_window_state.*15032.*801/)
    expect(error instanceof Error ? error.message : "").toMatch(
      kind === "interlaced PNG" ? /interlaced PNG/ : /decoded PNG size/,
    )
  },
)

test.each(["malformed JSON", "missing nested shape"])(
  "refuses %s without logging the returned payload",
  async (kind) => {
    respond(kind === "malformed JSON" ? "private malformed payload" : { pid: 15032, window_id: 801 }, output)
    const pending = createCuaReader(executable).capture(binding)
    await expect(pending).rejects.toThrow(/get_window_state.*15032.*801/)
    await expect(pending).rejects.not.toThrow(/private malformed payload/)
  },
)

test("refuses process timeout/output overflow with command and requested identity", async () => {
  for (const failure of [
    Object.assign(new Error("private command payload"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" }),
    Object.assign(new Error("private command payload"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
  ]) {
    respond({}, () => {}, failure)
    const pending = createCuaReader(executable).capture(binding)
    await expect(pending).rejects.toThrow(/get_window_state.*15032.*801/)
    await expect(pending).rejects.not.toThrow(/private command payload/)
  }
})

test.each([7, "ETIMEDOUT"])(
  "retains private process diagnostics for %s while ordinary errors stay redacted",
  async (code) => {
    const original = Object.assign(new Error("private command failure"), {
      code,
      signal: code === 7 ? null : "SIGTERM",
      killed: code !== 7,
    })
    const stdout = "private stdout screenshot payload"
    const stderr = Buffer.from("private stderr payload")
    respond(stdout, () => {}, original as NodeJS.ErrnoException, stderr)
    const error = await createCuaReader(executable)
      .capture(binding)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error("Expected reader failure")
    expect(error.message).toMatch(/get_window_state.*15032.*801/)
    expect(error.cause).toMatchObject({ code, signal: original.signal, killed: original.killed, cause: original })
    const diagnostic = error.cause as { stdout: Buffer; stderr: Buffer }
    expect(diagnostic.stdout.equals(Buffer.from(stdout))).toBe(true)
    expect(diagnostic.stderr.equals(stderr)).toBe(true)
    expect(inspect(error)).not.toMatch(/private command failure|private stdout|private stderr/)
    expect(JSON.stringify(error.cause)).not.toMatch(/private command failure|private stdout|private stderr/)
  },
)

test.each(["structured refusal", "invalid JSON", "invalid frame", "invalid file"])(
  "preserves private %s output and allocated artifact paths",
  async (kind) => {
    const value = frame()
    if (kind === "invalid frame") value.screenshot_frame_valid = false
    const response =
      kind === "structured refusal"
        ? { code: "window_owner_pid_mismatch", private: "private stdout" }
        : kind === "invalid JSON"
          ? "private stdout malformed JSON"
          : value
    let outputPath = ""
    const stderr = Buffer.from("private stderr")
    respond(
      response,
      (call) => {
        outputPath = call.outputPath!
        output(call, kind === "invalid file" ? Buffer.alloc(50) : png)
      },
      null,
      stderr,
    )
    const error = await createCuaReader(executable)
      .capture(binding)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error("Expected reader failure")
    const diagnostic = error.cause as { stdout: Buffer; stderr: Buffer; directory: string; path: string; code: number }
    const stdout = typeof response === "string" ? response : JSON.stringify(response)
    expect(diagnostic.stdout.equals(Buffer.from(stdout))).toBe(true)
    expect(diagnostic.stderr.equals(stderr)).toBe(true)
    expect(diagnostic.code).toBe(0)
    expect(diagnostic.path).toBe(outputPath)
    expect(diagnostic.directory).toBe(dirname(outputPath))
    expect(existsSync(outputPath)).toBe(true)
    expect(inspect(error)).not.toContain("private stdout")
    expect(inspect(error)).not.toContain(outputPath)
  },
)

test("refuses malformed window/permission observations rather than substituting defaults", async () => {
  const reader = createCuaReader(executable)
  for (const value of [{}, { windows: [{ pid: 1, window_id: 801, bounds: binding.bounds }] }]) {
    respond(value)
    await expect(reader.listWindows(binding.pid)).rejects.toThrow(/list_windows.*15032/)
  }
  for (const value of [
    {},
    { ...permissions, accessibility: "true" },
    { ...permissions, source: { ...permissions.source, attribution: "caller" } },
  ]) {
    respond(value)
    await expect(reader.readPermissions()).rejects.toThrow(/permissions status/)
  }
})

test.each([
  [
    "window bounds",
    "list_windows",
    { windows: [{ pid: binding.pid, window_id: 801, bounds: {}, title: "x", is_on_screen: true, layer: 0 }] },
  ],
  ["permission shape", "permissions", { ...permissions, source: { ...permissions.source, attribution: "caller" } }],
] as const)("retains private command receipt when %s are rejected", async (_kind, command, response) => {
  const stdout = Buffer.from(JSON.stringify(response))
  const stderr = Buffer.from("private helper stderr")
  respond(response, () => {}, null, stderr)
  const reader = createCuaReader(executable)
  let pending: Promise<unknown>
  if (command === "list_windows") pending = reader.listWindows(binding.pid)
  else pending = reader.readPermissions()
  const error = await pending.then(
    () => undefined,
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error("Expected rejected observation")
  expect(error.message).toMatch(command === "list_windows" ? /invalid window bounds/ : /invalid daemon-attributed/)
  expect(error.message).not.toContain("private helper")
  expect(inspect(error)).not.toContain("private helper")
  expect(JSON.stringify(error)).not.toContain("private helper")
  expect(error.cause).toMatchObject({ executablePath: executable, code: 0, cause: expect.any(Error) })
  const diagnostic = error.cause as {
    args: string[]
    request?: { pid: number }
    stdout: Buffer
    stderr: Buffer
    cause: Error
  }
  expect(diagnostic.args).toEqual(
    command === "list_windows" ? ["call", "list_windows"] : ["permissions", "status", "--json"],
  )
  if (command === "list_windows") expect(diagnostic.request).toEqual({ pid: binding.pid })
  expect(diagnostic.stdout.equals(stdout)).toBe(true)
  expect(diagnostic.stderr.equals(stderr)).toBe(true)
  expect(diagnostic.cause.message).toMatch(/invalid window bounds|invalid daemon-attributed/)
  expect(Object.keys(error.cause as object)).toEqual([])
  expect(JSON.stringify(error.cause)).toBe("{}")
})
