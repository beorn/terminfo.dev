/**
 * @failure Capture blocks the daemon, changes its selected window, or retains a frame after losing the window owner.
 * @level l2
 * @consumer Linux Kitty daemon capture and concurrent HTTP clients
 * @reach fs-walk <fixture-only: inspect only the owned temporary capture output directory>
 * @testonly none
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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
  const release = join(directory, "release")
  const stdin = join(directory, "stdin")
  const png = join(directory, "sample.png")
  writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]))
  executable(
    join(directory, "xdotool"),
    `case "$1" in
  search)
    if [ "$3" = --pid ]; then printf '%s\\n' "$TEST_CAPTURE_WINDOWS"
    else printf '%s\\n' "$TEST_CAPTURE_VISIBLE_WINDOWS"; fi
    ;;
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
while [ ! -e "$TEST_CAPTURE_RELEASE" ]; do sleep 0.01; done
printf finished > "$TEST_CAPTURE_FINISHED"
printf 'xwd-window-%s' "$2"`,
  )
  executable(join(directory, "xdpyinfo"), `printf 'root window id: 0x21f\\n'`)
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
  process.env.TEST_CAPTURE_WINDOWS = "42"
  process.env.TEST_CAPTURE_VISIBLE_WINDOWS = "543 42"
  process.env.TEST_CAPTURE_STARTED = started
  process.env.TEST_CAPTURE_FINISHED = finished
  process.env.TEST_CAPTURE_RELEASE = release
  process.env.TEST_CAPTURE_STDIN = stdin
  process.env.TEST_CAPTURE_PNG = png
  process.env.TEST_CAPTURE_FAIL = ""
  return { directory, started, finished, release, stdin }
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
    "TEST_CAPTURE_WINDOWS",
    "TEST_CAPTURE_VISIBLE_WINDOWS",
    "TEST_CAPTURE_STARTED",
    "TEST_CAPTURE_FINISHED",
    "TEST_CAPTURE_RELEASE",
    "TEST_CAPTURE_STDIN",
    "TEST_CAPTURE_PNG",
    "TEST_CAPTURE_FAIL",
  ]) {
    delete process.env[key]
  }
})

test.runIf(process.platform === "linux")(
  "a delayed capture keeps the original window and leaves the daemon event loop available",
  async () => {
    const { directory, started, finished, release, stdin } = fixture()
    const capture = await createLinuxCapture(join(directory, "frames"), liveExecutable())
    // A new search would now select a different window; capture must keep its original target.
    process.env.TEST_CAPTURE_WINDOWS = "99"
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

    writeFileSync(release, "continue")
    const result = await pending
    expect(result.frame.ref).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(readFileSync(stdin, "utf8")).toBe("xwd-window-42")
  },
)

test.runIf(process.platform === "linux").each(["before", "during"] as const)(
  "owner loss %s capture rejects the frame without retaining image artifacts",
  async (when) => {
    const { directory, started, release } = fixture()
    const frames = join(directory, "frames")
    const capture = await createLinuxCapture(frames, liveExecutable())
    if (when === "before") process.env.TEST_CAPTURE_OWNER_PID = "1"
    const pending = capture({ featureId: "fixture", role: "target", label: "owned frame" })
    const rejected = expect(pending).rejects.toThrow("no longer belongs to Kitty")
    if (when === "during") {
      for (let n = 0; n < 500 && !existsSync(started); n++) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(existsSync(started)).toBe(true)
      process.env.TEST_CAPTURE_OWNER_PID = "1"
      writeFileSync(release, "continue")
    }
    await rejected
    expect(existsSync(started)).toBe(when === "during")
    expect(readdirSync(frames)).toEqual([])
  },
)

test.runIf(process.platform === "linux").each(["before", "during"] as const)(
  "another visible top-level window %s capture rejects without retaining image artifacts",
  async (when) => {
    const { directory, started, release } = fixture()
    const frames = join(directory, "frames")
    if (when === "before") process.env.TEST_CAPTURE_VISIBLE_WINDOWS = "543 42 99"
    const create = createLinuxCapture(frames, liveExecutable())
    if (when === "before") {
      await expect(create).rejects.toThrow("visible top-level")
    } else {
      const capture = await create
      const pending = capture({ featureId: "fixture", role: "target", label: "owned frame" })
      const rejected = expect(pending).rejects.toThrow("visible top-level")
      for (let n = 0; n < 500 && !existsSync(started); n++) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(existsSync(started)).toBe(true)
      process.env.TEST_CAPTURE_VISIBLE_WINDOWS = "543 42 99"
      writeFileSync(release, "continue")
      await rejected
    }
    expect(existsSync(frames) ? readdirSync(frames) : []).toEqual([])
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
