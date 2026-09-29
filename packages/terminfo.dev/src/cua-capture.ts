/** Internal CLI reader; validates a supplied binding, never establishes window ownership or runtime identity. */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { PNG } from "pngjs"

const COMMANDS = {
  list_windows: ["call", "list_windows"],
  get_window_state: ["call", "get_window_state"],
  permissions: ["permissions", "status", "--json"],
} as const
const TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_END = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface Binding {
  pid: number
  windowId: number
  bounds: Bounds
  scale: number
}
interface Window {
  pid: number
  windowId: number
  bounds: Bounds
  title: string
  isOnScreen: boolean
  layer: number
}
interface PermissionSource {
  pid: number
  executable: string
  bundle_id: string
  attribution: "driver-daemon"
  responsible_ppid: number
  disclaim_env: false
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function refuse(description: string, detail: string): never {
  throw new Error(`${description}: ${detail}`)
}

// Ordinary Error inspection and JSON serialization must not reveal private process output.
function retainedFailure(message: string, details: Record<string, unknown>): Error {
  const diagnostic = Object.defineProperties(
    {},
    Object.fromEntries(Object.entries(details).map(([key, value]) => [key, { value, enumerable: false }])),
  )
  return new Error(message, { cause: diagnostic })
}

function retainObservationFailure(receipt: Record<string, unknown>, error: unknown): never {
  throw retainedFailure(error instanceof Error ? error.message : "invalid measured observation", {
    ...receipt,
    cause: error,
  })
}

function identifier(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function bounds(value: unknown, description: string): Bounds {
  if (
    !object(value) ||
    typeof value.x !== "number" ||
    !Number.isFinite(value.x) ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.y) ||
    typeof value.width !== "number" ||
    !Number.isFinite(value.width) ||
    value.width <= 0 ||
    typeof value.height !== "number" ||
    !Number.isFinite(value.height) ||
    value.height <= 0
  ) {
    refuse(description, "invalid window bounds")
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

function sameBounds(actual: Bounds, expected: Bounds): boolean {
  return (
    actual.x === expected.x &&
    actual.y === expected.y &&
    actual.width === expected.width &&
    actual.height === expected.height
  )
}

function privateDirectory(directory: string, description: string): void {
  const state = lstatSync(directory)
  if (!state.isDirectory()) refuse(description, "capture output directory is not a private directory")
  if ((state.mode & 0o777) !== 0o700) {
    // This is our freshly allocated directory, never caller data. Secure it before refusing drift.
    chmodSync(directory, 0o700)
    refuse(description, "capture output directory mode changed")
  }
}

async function captureBytes(path: string, description: string, width: number, height: number): Promise<Buffer> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const state = fstatSync(fd)
    if (!state.isFile() || state.nlink !== 1) refuse(description, "capture output is not a regular file with one link")
    if (state.size < 45 || state.size > MAX_CAPTURE_BYTES) {
      refuse(description, "capture file size is outside the 32 MiB bound")
    }
    fchmodSync(fd, 0o600)
    if ((fstatSync(fd).mode & 0o777) !== 0o600) refuse(description, "capture file mode is not private")
    // The extra byte detects growth without ever reading an unbounded file.
    const buffer = Buffer.alloc(state.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length)
      if (count === 0) break
      length += count
    }
    if (length !== state.size || fstatSync(fd).size !== state.size) {
      refuse(description, "capture file size changed while reading")
    }
    const bytes = buffer.subarray(0, length)
    if (
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      !bytes.subarray(-12).equals(PNG_END)
    ) {
      refuse(description, "capture file has an invalid PNG header or end")
    }
    if (bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
      refuse(description, "PNG dimensions disagree with the frame metadata")
    }
    if (bytes[28] !== 0) refuse(description, "interlaced PNG capture is unsupported")
    // Bound the largest supported scanline representation: 16-bit RGBA plus one filter byte per row.
    const decodedSize = width * height * 8 + height
    if (!Number.isSafeInteger(decodedSize) || decodedSize > MAX_CAPTURE_BYTES) {
      refuse(description, "decoded PNG size is outside the 32 MiB bound")
    }
    let decoded: PNG
    try {
      // pngjs sync decoding under Bun accepted corrupt valid-CRC deflate streams in measurement.
      decoded = await new Promise<PNG>((resolve, reject) => {
        new PNG({ checkCRC: true }).parse(bytes, (error, image) => (error ? reject(error) : resolve(image)))
      })
    } catch (cause) {
      throw retainedFailure(`${description}: invalid PNG image`, { cause })
    }
    if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) {
      refuse(description, "decoded PNG dimensions or RGBA length disagree with the frame metadata")
    }
    return bytes
  } finally {
    closeSync(fd)
  }
}

function label(command: keyof typeof COMMANDS, binding?: Pick<Binding, "pid" | "windowId"> | { pid: number }): string {
  return `cua-driver ${COMMANDS[command].join(" ")}${binding ? ` (pid ${binding.pid}${"windowId" in binding ? `, window ${binding.windowId}` : ""})` : ""}`
}

function failureCode(error: unknown): string {
  if (object(error) && typeof error.code === "number" && Number.isSafeInteger(error.code)) return `exit ${error.code}`
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return /^[A-Za-z0-9_]{1,128}$/.test(error.code) ? error.code : "process error"
  }
  return error instanceof Error && /^[A-Za-z0-9_]{1,128}$/.test(error.name) ? error.name : "unknown error"
}

/** No runtime fact is presumed from the path: integration must verify the pinned client and daemon. */
export function createCuaReader(executablePath: string) {
  if (typeof executablePath !== "string" || !isAbsolute(executablePath) || executablePath.includes("\0")) {
    throw new Error("Cua reader requires an explicit absolute pinned executable path")
  }
  async function command(
    name: keyof typeof COMMANDS,
    request?: { pid: number; window_id?: number; max_elements?: number },
    outputPath?: string,
  ) {
    const description = label(
      name,
      request && { pid: request.pid, ...(request.window_id !== undefined && { windowId: request.window_id }) },
    )
    const args: string[] = [...COMMANDS[name], ...(outputPath ? ["--screenshot-out-file", outputPath] : [])]
    const invocation = { executablePath, args, request }
    const result = await new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      let stdinError: Error | undefined
      const child = execFile(
        executablePath,
        args,
        { encoding: "buffer", timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
        (error, stdout, stderr) => {
          if (error || stdinError) {
            const cause = error ?? stdinError
            reject(
              retainedFailure(`${description}: ${failureCode(cause)}`, {
                ...invocation,
                code: error?.code,
                signal: error?.signal,
                killed: error?.killed,
                cause,
                stdout,
                stderr,
              }),
            )
          } else resolve({ stdout, stderr })
        },
      )
      if (!child.stdin) {
        reject(retainedFailure(`${description}: command has no stdin`, invocation))
        return
      }
      child.stdin.on("error", (error: Error) => {
        stdinError = error
      })
      child.stdin.end(request ? JSON.stringify(request) : undefined)
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith(`${description}:`)) throw error
      throw retainedFailure(`${description}: ${failureCode(error)}`, { ...invocation, cause: error })
    })
    const receipt = { ...invocation, ...result, code: 0, signal: null, killed: false }
    if (result.stdout.length > MAX_OUTPUT_BYTES || result.stderr.length > MAX_OUTPUT_BYTES) {
      throw retainedFailure(`${description}: command output exceeds the 1 MiB bound`, receipt)
    }
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(result.stdout))
    } catch (cause) {
      throw retainedFailure(`${description}: invalid JSON output`, { ...receipt, cause })
    }
    if (!object(value)) throw retainedFailure(`${description}: expected a JSON object`, receipt)
    if ("code" in value) {
      const code =
        typeof value.code === "string" && /^[a-z0-9_]{1,128}$/.test(value.code) ? value.code : "malformed refusal code"
      throw retainedFailure(`${description}: structured refusal ${code}`, receipt)
    }
    return { value, description, ...result, receipt }
  }

  return {
    async listWindows(pid: number) {
      const description = label("list_windows", { pid })
      if (!identifier(pid) || pid < 2) refuse(description, "invalid requested process ID")
      const result = await command("list_windows", { pid })
      try {
        if (!Array.isArray(result.value.windows)) refuse(description, "missing windows array")
        const seen = new Set<number>()
        const windows = result.value.windows.map((window: unknown): Window => {
          if (
            !object(window) ||
            window.pid !== pid ||
            !identifier(window.window_id) ||
            typeof window.title !== "string" ||
            typeof window.is_on_screen !== "boolean" ||
            typeof window.layer !== "number" ||
            !Number.isSafeInteger(window.layer)
          ) {
            refuse(description, "invalid window identity or metadata")
          }
          if (seen.has(window.window_id)) refuse(description, "duplicate window ID")
          seen.add(window.window_id)
          return {
            pid,
            windowId: window.window_id,
            bounds: bounds(window.bounds, description),
            title: window.title,
            isOnScreen: window.is_on_screen,
            layer: window.layer,
          }
        })
        return { windows, stdout: result.stdout, stderr: result.stderr }
      } catch (error) {
        retainObservationFailure(result.receipt, error)
      }
    },
    async readPermissions() {
      const result = await command("permissions")
      try {
        const { value, description } = result
        const source = value.source
        if (
          typeof value.accessibility !== "boolean" ||
          typeof value.screen_recording !== "boolean" ||
          value.direct_capture_status !== "not_checked" ||
          value.direct_capture_error !== null ||
          value.screen_recording_capturable !== null ||
          !object(source) ||
          source.attribution !== "driver-daemon" ||
          source.bundle_id !== "com.trycua.driver" ||
          source.executable !== executablePath ||
          !identifier(source.pid) ||
          source.pid < 2 ||
          source.responsible_ppid !== 1 ||
          source.disclaim_env !== false
        ) {
          refuse(description, "invalid daemon-attributed permission observation")
        }
        return {
          accessibility: value.accessibility,
          screenRecording: value.screen_recording,
          directCaptureStatus: "not_checked" as const,
          source: {
            pid: source.pid,
            executable: source.executable,
            bundle_id: source.bundle_id,
            attribution: source.attribution,
            responsible_ppid: source.responsible_ppid,
            disclaim_env: source.disclaim_env,
          } satisfies PermissionSource,
          stdout: result.stdout,
          stderr: result.stderr,
        }
      } catch (error) {
        retainObservationFailure(result.receipt, error)
      }
    },
    async capture(binding: Binding) {
      const description = label("get_window_state", binding)
      if (
        !identifier(binding.pid) ||
        binding.pid < 2 ||
        !identifier(binding.windowId) ||
        !Number.isFinite(binding.scale) ||
        binding.scale <= 0
      ) {
        refuse(description, "invalid requested window binding")
      }
      const expected = { ...binding, bounds: bounds(binding.bounds, description) }
      let directory: string | undefined
      let path: string | undefined
      let receipt: Record<string, unknown> | undefined
      try {
        directory = mkdtempSync(join(tmpdir(), "terminfo-cua-"))
        chmodSync(directory, 0o700)
        privateDirectory(directory, description)
        path = join(directory, "capture.png")
        try {
          lstatSync(path)
          refuse(description, "capture output path already exists")
        } catch (error) {
          if (failureCode(error) !== "ENOENT") throw error
        }
        const result = await command(
          "get_window_state",
          { pid: expected.pid, window_id: expected.windowId, max_elements: 1 },
          path,
        )
        receipt = result.receipt
        const { value } = result
        const background = value.background_input
        if (!object(background) || !object(background.exact_window) || !object(background.observation)) {
          refuse(description, "missing exact-window observation")
        }
        const exact = background.exact_window
        const observation = background.observation
        if (
          value.pid !== expected.pid ||
          value.window_id !== expected.windowId ||
          exact.pid !== expected.pid ||
          exact.window_id !== expected.windowId ||
          exact.status !== "matched" ||
          (value.degraded !== undefined && value.degraded !== false) ||
          value.screenshot_frame_valid !== true ||
          observation.one_shot_capture !== "available" ||
          observation.frame_freshness !== "unknown" ||
          value.screenshot_mime_type !== "image/png" ||
          value.screenshot_scale !== expected.scale ||
          !identifier(value.screenshot_width) ||
          !identifier(value.screenshot_height)
        ) {
          refuse(description, "frame is not a valid nondegraded capture of the requested window")
        }
        const actualBounds = bounds(value.window_bounds, description)
        if (
          !sameBounds(actualBounds, expected.bounds) ||
          value.screenshot_width !== expected.bounds.width * expected.scale ||
          value.screenshot_height !== expected.bounds.height * expected.scale
        ) {
          refuse(description, "frame bounds, scale or dimensions disagree with the requested binding")
        }
        privateDirectory(directory, description)
        const bytes = await captureBytes(path, description, value.screenshot_width, value.screenshot_height)
        privateDirectory(directory, description)
        return {
          directory,
          path,
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          width: value.screenshot_width,
          height: value.screenshot_height,
          scale: expected.scale,
          bounds: actualBounds,
          frameFreshness: "unknown" as const,
          // Local receipt time is not a claim that the captured frame is fresh.
          capturedAt: Date.now(),
          stdout: result.stdout,
          stderr: result.stderr,
        }
      } catch (error) {
        const diagnostic = error instanceof Error ? error.cause : undefined
        const prior = object(diagnostic)
          ? Object.fromEntries(Object.getOwnPropertyNames(diagnostic).map((key) => [key, diagnostic[key]]))
          : undefined
        const message =
          error instanceof Error && error.message.startsWith(`${description}:`)
            ? error.message
            : `${description}: capture file ${failureCode(error)}`
        throw retainedFailure(message, { ...receipt, ...prior, directory, path, cause: prior ? prior.cause : error })
      }
    },
  }
}
