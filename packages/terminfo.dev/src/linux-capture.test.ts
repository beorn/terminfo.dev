/**
 * @failure A synchronous capture command blocks the daemon event loop, and a failed image command is silently accepted.
 * @level l2
 * @consumer Linux Kitty daemon capture and concurrent HTTP clients
 * @testonly none
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { createLinuxCapture } from "./linux-capture.ts"

const temporary: string[] = []
const originalPath = process.env.PATH
const originalDisplay = process.env.DISPLAY

function executable(path: string, source: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${source}\n`)
  chmodSync(path, 0o700)
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "terminfo-linux-capture-"))
  temporary.push(directory)
  const started = join(directory, "started")
  const finished = join(directory, "finished")
  const stdin = join(directory, "stdin")
  const png = join(directory, "sample.png")
  writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]))
  executable(
    join(directory, "xdotool"),
    `case "$1" in
  search) printf '42\\n' ;;
  getwindowpid)
    if [ "${"$"}TEST_CAPTURE_FAIL" = owner ]; then printf 'owner lookup failed\\n' >&2; exit 17; fi
    printf '%s\\n' "$TEST_CAPTURE_OWNER_PID"
    ;;
  getwindowgeometry) printf 'X=0\\nY=0\\nWIDTH=640\\nHEIGHT=480\\n' ;;
  *) exit 18 ;;
esac`,
  )
  executable(
    join(directory, "xwd"),
    `printf started > "$TEST_CAPTURE_STARTED"
sleep 1
printf finished > "$TEST_CAPTURE_FINISHED"
printf 'xwd-input'`,
  )
  executable(
    join(directory, "magick"),
    `if [ "$1" = -version ]; then printf 'ImageMagick test\\n'; exit 0; fi
cat > "$TEST_CAPTURE_STDIN"
if [ "${"$"}TEST_CAPTURE_FAIL" = conversion ]; then printf 'conversion failed\\n' >&2; exit 19; fi
cat "$TEST_CAPTURE_PNG"`,
  )
  process.env.PATH = `${directory}:${originalPath ?? ""}`
  process.env.DISPLAY = ":test"
  process.env.TEST_CAPTURE_OWNER_PID = String(process.pid)
  process.env.TEST_CAPTURE_STARTED = started
  process.env.TEST_CAPTURE_FINISHED = finished
  process.env.TEST_CAPTURE_STDIN = stdin
  process.env.TEST_CAPTURE_PNG = png
  process.env.TEST_CAPTURE_FAIL = ""
  return { directory, started, finished, stdin }
}

function liveExecutable(sha256?: string) {
  const path = realpathSync(`/proc/${process.pid}/exe`)
  return { path, sha256: sha256 ?? createHash("sha256").update(readFileSync(path)).digest("hex") }
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalDisplay === undefined) delete process.env.DISPLAY
  else process.env.DISPLAY = originalDisplay
  for (const key of [
    "TEST_CAPTURE_OWNER_PID",
    "TEST_CAPTURE_STARTED",
    "TEST_CAPTURE_FINISHED",
    "TEST_CAPTURE_STDIN",
    "TEST_CAPTURE_PNG",
    "TEST_CAPTURE_FAIL",
  ]) {
    delete process.env[key]
  }
})

test.runIf(process.platform === "linux")(
  "a real delayed capture command leaves the daemon event loop available and pipes XWD to PNG",
  async () => {
    const { directory, started, finished, stdin } = fixture()
    const capture = await createLinuxCapture(join(directory, "frames"), liveExecutable())
    const pending = capture({ featureId: "fixture", role: "control", label: "fixture frame" })
    for (let n = 0; n < 100 && !existsSync(started); n++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(existsSync(started)).toBe(true)
    let eventLoopTicked = false
    setTimeout(() => {
      eventLoopTicked = true
    }, 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(eventLoopTicked).toBe(true)
    expect(existsSync(finished)).toBe(false)

    const result = await pending
    expect(result.frame.ref).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(readFileSync(stdin, "utf8")).toBe("xwd-input")
  },
)

test.runIf(process.platform === "linux")(
  "a failed real capture command rejects with its stderr and exit status",
  async () => {
    const { directory } = fixture()
    process.env.TEST_CAPTURE_FAIL = "owner"
    await expect(createLinuxCapture(join(directory, "frames"), liveExecutable())).rejects.toMatchObject({
      code: 17,
      message: expect.stringContaining("owner lookup failed"),
    })
  },
)

test.runIf(process.platform === "linux")(
  "a matching process path with the wrong executable digest cannot authorize capture",
  async () => {
    const { directory } = fixture()
    await expect(createLinuxCapture(join(directory, "frames"), liveExecutable("0".repeat(64)))).rejects.toThrow(
      "executable digest mismatch",
    )
  },
)
