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
import { createLinuxCapture, drawnSurface, screenPixels, textAreaOrigin, windowPixels } from "./linux-capture.ts"

import { capturePixels, cellRectangle, command, finishCapture, type CapturedFrame } from "./capture-core.ts"

const temporary: string[] = []
const originalPath = process.env.PATH
const originalDisplay = process.env.DISPLAY

// A successful screenshot command can still explain a missing PNG only on stderr.
test("capture command preserves zero-exit stderr before resolving unchanged stdout bytes", async () => {
  const observed: Buffer[] = []
  const stdout = await command(
    process.execPath,
    ["-e", "process.stdout.write(Buffer.from([17, 0, 23])); process.stderr.write(Buffer.from([0, 255, 10]))"],
    undefined,
    undefined,
    (stderr) => observed.push(stderr),
  )
  expect(stdout).toEqual(Buffer.from([17, 0, 23]))
  expect(observed).toEqual([Buffer.from([0, 255, 10])])
})

// Calibration's oracle deadline bounds the running child, not just the next polling iteration.
test("capture command terminates a real child at its supplied deadline and never starts after expiry", async () => {
  const { directory } = fixture()
  const completed = join(directory, "deadline-completed")
  await expect(
    command(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'completed'), 2000)",
        completed,
      ],
      undefined,
      Date.now() + 500,
    ),
  ).rejects.toMatchObject({ killed: true, signal: "SIGKILL" })
  expect(existsSync(completed)).toBe(false)
  const invoked = join(directory, "expired-invoked")
  await expect(
    command(
      process.execPath,
      ["-e", "require('node:fs').writeFileSync(process.argv[1], 'invoked')", invoked],
      undefined,
      Date.now() - 1,
    ),
  ).rejects.toThrow(/capture command.*deadline expired/i)
  expect(existsSync(invoked)).toBe(false)
})

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
  getwindowgeometry) printf 'X=0\\nY=0\\nWIDTH=%s\\nHEIGHT=%s\\n' "\${TEST_CAPTURE_WIDTH:-640}" "\${TEST_CAPTURE_HEIGHT:-480}" ;;
  *) exit 18 ;;
esac`,
  )
  executable(
    join(directory, "xwd"),
    `printf started > "$TEST_CAPTURE_STARTED"
while [ ! -e "$TEST_CAPTURE_RELEASE" ]; do sleep 0.01; done
printf finished > "$TEST_CAPTURE_FINISHED"
id=
nobdrs=0
prev=
for arg; do
  if [ "\$prev" = -id ]; then id=\$arg; fi
  if [ "\$arg" = -nobdrs ]; then nobdrs=1; fi
  prev=\$arg
done
w=\${TEST_CAPTURE_WIDTH:-640}
h=\${TEST_CAPTURE_HEIGHT:-480}
if [ "\$nobdrs" != 1 ]; then
  w=\$((w + 2))
  h=\$((h + 2))
fi
printf '%sx%s' "\$w" "\$h" > "$TEST_CAPTURE_XWD_SIZE"
printf 'xwd-window-%s' "\$id"`,
  )
  executable(
    join(directory, "xdpyinfo"),
    `printf 'root window id: 0x21f\\n  dimensions:    %sx%s pixels\\n' "\${TEST_CAPTURE_SCREEN_WIDTH:-1920}" "\${TEST_CAPTURE_SCREEN_HEIGHT:-1080}"`,
  )
  executable(
    join(directory, "magick"),
    `if [ "$1" = -version ]; then printf 'ImageMagick test\\n'; exit 0; fi
cat > "$TEST_CAPTURE_STDIN"
if [ "${"$"}TEST_CAPTURE_FAIL" = conversion ]; then printf 'conversion failed\\n' >&2; exit 19; fi
rgba=
crop=
identify=
for arg; do
  [ "\$arg" = "rgba:-" ] && rgba=1
  [ "\$arg" = "info:" ] && identify=1
  case "\$arg" in
    *x*+*) crop=\$arg ;;
  esac
done
size=\${TEST_CAPTURE_FORCE_CAPTURE:-}
if [ -z "\$size" ] && [ -f "$TEST_CAPTURE_XWD_SIZE" ]; then
  size=\$(cat "$TEST_CAPTURE_XWD_SIZE")
fi
if [ -z "\$size" ]; then
  size="\${TEST_CAPTURE_WIDTH:-640}x\${TEST_CAPTURE_HEIGHT:-480}"
fi
if [ -n "\$identify" ]; then
  printf '%s' "\$size"
  exit 0
fi
if [ -n "\$rgba" ]; then
  if [ -n "\$crop" ]; then
    w=\${crop%%x*}
    rest=\${crop#*x}
    h=\${rest%%+*}
    head -c "\$((w * h * 4))" /dev/zero
  else
    w=\${size%%x*}
    h=\${size#*x}
    chrome=\${TEST_CAPTURE_CHROME_ROWS:-0}
    if [ "\$chrome" -gt 0 ]; then
      head -c "\$((w * chrome * 4))" /dev/zero | tr '\\0' '\\1'
      head -c "\$((w * (h - chrome) * 4))" /dev/zero
    else
      head -c "\$((w * h * 4))" /dev/zero
    fi
  fi
  exit 0
fi
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
  process.env.TEST_CAPTURE_XWD_SIZE = join(directory, "xwd-size")
  return { directory, started, finished, release, stdin, png }
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
    "TEST_CAPTURE_WIDTH",
    "TEST_CAPTURE_HEIGHT",
    "TEST_CAPTURE_SCREEN_WIDTH",
    "TEST_CAPTURE_SCREEN_HEIGHT",
    "TEST_CAPTURE_FORCE_CAPTURE",
    "TEST_CAPTURE_XWD_SIZE",
    "TEST_CAPTURE_CHROME_ROWS",
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

/** One captured frame painted a colour per pixel, exactly as the collector's rgba buffer holds it. */
function painted(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): CapturedFrame {
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const [red, green, blue] = paint(x, y)
      rgba[at] = red
      rgba[at + 1] = green
      rgba[at + 2] = blue
      rgba[at + 3] = 255
    }
  }
  return { width, height, rgba }
}

/**
 * The retained ghostty 1.3.1 frame of run 5f91eb10b6…, decoded by hand: an 800x600 window with a
 * border, a client-side title bar across y 0..55, and the terminal's OWN pixels (its default
 * #282c34 background) at x 5..794, y 56..594. The terminal reports a 780x528 text area over 60x22
 * cells of 13x24.
 */
const GHOSTTY_GEOMETRY = { cellWidth: 13, cellHeight: 24, textWidth: 780, textHeight: 528 }
function ghosttyFrame(): CapturedFrame {
  return painted(800, 600, (x, y) =>
    x < 5 || x > 794 || y < 5 || y > 594 ? [77, 77, 81] : y <= 55 ? [46, 46, 50] : [40, 44, 52],
  )
}

test("the terminal's own surface is measured from the frame, not assumed to be the window (#28756)", () => {
  const measurement = drawnSurface(ghosttyFrame())
  expect(measurement.surface).toEqual({ x: 5, y: 56, width: 790, height: 539 })
  expect(measurement.basis).toMatch(/covers rows 56\.\.594 and columns 5\.\.794/)
})

test("a frame that hides its own background names the surface it could not measure", () => {
  // One colour per row: no single colour covers half of any row AND column, so none is claimed.
  const measurement = drawnSurface(painted(6, 6, (x, y) => [y, x, 0]))
  expect(measurement.surface).toBeNull()
  expect(measurement.basis).toMatch(/no one colour covers half of any row and column of the 6x6 frame/)
})

test("ghostty 1.3.1's title bar places row 1 in the text area, not under it (#28756)", () => {
  // The retained frame's row-1 glyphs are lowercase `qqq`, ink rows y 60..75. Centring the text
  // area in the WINDOW reads y 36..60 and misses them, which is why the seed frame and the expected
  // frame compared byte-identical and the row was inconclusive.
  const placement = textAreaOrigin({ frame: ghosttyFrame(), pixelGeometry: GHOSTTY_GEOMETRY })
  expect(placement.origin).toEqual({ x: 10, y: 62 })
  expect(placement.basis).toMatch(/centring the reported 780x528 text area/)
  const row = cellRectangle({
    cells: { top: 1, left: 1, bottom: 1, right: 3 },
    pixelGeometry: GHOSTTY_GEOMETRY,
    textOrigin: placement.origin,
    windowWidth: 800,
    windowHeight: 600,
  })
  expect(row).toEqual({ x: 10, y: 62, width: 39, height: 24 })
  const ink = { top: 60, bottom: 75 }
  const reads = (rectangle: { y: number; height: number }) =>
    Math.max(rectangle.y, ink.top) <= Math.min(rectangle.y + rectangle.height - 1, ink.bottom)
  expect(reads(row)).toBe(true)
  expect(
    reads(
      cellRectangle({
        cells: { top: 1, left: 1, bottom: 1, right: 3 },
        pixelGeometry: GHOSTTY_GEOMETRY,
        textOrigin: { x: Math.round((800 - 780) / 2), y: Math.round((600 - 528) / 2) },
        windowWidth: 800,
        windowHeight: 600,
      }),
    ),
  ).toBe(false)
})

test("a surface too small to hold the reported text area falls back to the window, by name", () => {
  // The terminal's pixels cover rows 0..399 only: they cannot hold a 780x528 text area, so the
  // placement says so and uses the whole window, which is the previous behaviour.
  const frame = painted(800, 600, (_x, y) => (y < 400 ? [40, 44, 52] : [y - 400, y - 400, y - 400]))
  const placement = textAreaOrigin({ frame, pixelGeometry: { textWidth: 780, textHeight: 528 } })
  expect(placement.surface).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  expect(placement.origin).toEqual({ x: 10, y: 36 })
  expect(placement.basis).toMatch(/smaller than the reported 780x528 text area/)
  expect(placement.basis).toMatch(/placing the text area in the whole 800x600 frame/)
})

test("cells map to window pixels from the text area's own measured origin", () => {
  // The origin arrives measured (textAreaOrigin); cells count from the text area's top-left corner.
  expect(
    cellRectangle({
      cells: { top: 2, left: 3, bottom: 2, right: 4 },
      pixelGeometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 256 },
      textOrigin: { x: 80, y: 172 },
      windowWidth: 800,
      windowHeight: 600,
    }),
  ).toEqual({ x: 96, y: 188, width: 16, height: 16 })
})

test("a fractional text-area inset lands on a whole pixel", () => {
  // 800 - 793 leaves an odd inset: half of it rounds, rather than truncating a column width. A
  // frame the terminal fills edge to edge has the window as its surface.
  const placement = textAreaOrigin({
    frame: painted(800, 600, () => [0, 0, 0]),
    pixelGeometry: { textWidth: 793, textHeight: 600 },
  })
  expect(placement.origin).toEqual({ x: 4, y: 0 })
  expect(
    cellRectangle({
      cells: { top: 1, left: 1, bottom: 1, right: 8 },
      pixelGeometry: { cellWidth: 13, cellHeight: 25, textWidth: 793, textHeight: 600 },
      textOrigin: placement.origin,
      windowWidth: 800,
      windowHeight: 600,
    }),
  ).toEqual({ x: 4, y: 0, width: 104, height: 25 })
})

test("a rectangle that leaves the window is loud, never clipped", () => {
  expect(() =>
    cellRectangle({
      cells: { top: 1, left: 1, bottom: 1, right: 100 },
      pixelGeometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 256 },
      textOrigin: { x: 80, y: 172 },
      windowWidth: 800,
      windowHeight: 600,
    }),
  ).toThrow(/leaves the measured 800x600 window/)
  expect(() =>
    cellRectangle({
      cells: { top: 1, left: 1, bottom: 1, right: 2 },
      pixelGeometry: { cellWidth: 0, cellHeight: 16, textWidth: 640, textHeight: 256 },
      textOrigin: { x: 80, y: 172 },
      windowWidth: 800,
      windowHeight: 600,
    }),
  ).toThrow(/empty or negative region/)
})

test("the window's own pixel size comes from the measured geometry, and a missing one is loud", () => {
  expect(windowPixels("WINDOW=4194317\nX=0\nY=0\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n")).toEqual({
    width: 800,
    height: 600,
  })
  expect(() => windowPixels("WINDOW=4194317\nX=0\nY=0\nSCREEN=0\n")).toThrow(/pixel size/)
})

test("the screen's pixel size comes from xdpyinfo, and a missing one is loud", () => {
  expect(screenPixels("screen #0:\n  dimensions:    1920x1080 pixels (508x285 millimeters)\n")).toEqual({
    width: 1920,
    height: 1080,
  })
  expect(() => screenPixels("root window id: 0x21f\n")).toThrow(/screen/)
})

test("the capture's pixel size comes from magick identify, and a missing one is loud", () => {
  expect(capturePixels("1306x816")).toEqual({ width: 1306, height: 816 })
  expect(capturePixels("1306x816\n")).toEqual({ width: 1306, height: 816 })
  expect(() => capturePixels("xwd:- XWD 8-bit\n")).toThrow(/capture/)
})

test.runIf(process.platform === "linux")(
  "a 1304x814 window yields a whole-window pixelsDigest of 4245824 rgba bytes (#28580)",
  async () => {
    // xterm 411 measured 1304x814; 3145728 is 1024x768x4 (the old Xvfb screen), not a 3 MiB
    // execFile cap. command() already admits 32 MiB, so the collector must hash the full frame.
    // The fixture xwd adds a 1px border unless -nobdrs is passed (#28590); this row is that
    // contract: capture dimensions match the xdotool client area.
    const { directory, release } = fixture()
    process.env.TEST_CAPTURE_WIDTH = "1304"
    process.env.TEST_CAPTURE_HEIGHT = "814"
    writeFileSync(release, "continue")
    const capture = await createLinuxCapture(join(directory, "frames"), liveExecutable())
    const result = await capture({
      featureId: "editing.delete-chars",
      role: "target",
      label: "xterm window",
      cells: { top: 1, left: 1, bottom: 1, right: 1 },
      pixelGeometry: { cellWidth: 8, cellHeight: 16, textWidth: 800, textHeight: 480 },
    })
    expect(result.frame.pixelsDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    const expected = Buffer.alloc(1304 * 814 * 4)
    expect(result.frame.pixelsDigest).toBe(`sha256:${createHash("sha256").update(expected).digest("hex")}`)
  },
)

test.runIf(process.platform === "linux")("window 1304x814 on a 1024x768 screen names the clip (#28590)", async () => {
  // 3145728 was 1024x768x4. Naming the screen vs the window is what stops the next
  // diagnosis from chasing execFile maxBuffer.
  const { directory } = fixture()
  process.env.TEST_CAPTURE_WIDTH = "1304"
  process.env.TEST_CAPTURE_HEIGHT = "814"
  process.env.TEST_CAPTURE_SCREEN_WIDTH = "1024"
  process.env.TEST_CAPTURE_SCREEN_HEIGHT = "768"
  await expect(createLinuxCapture(join(directory, "frames"), liveExecutable())).rejects.toThrow(
    "window 1304x814 exceeds the 1024x768 screen",
  )
})

test.runIf(process.platform === "linux")(
  "a title bar inside the client area places the compared region below it (#28756)",
  async () => {
    // The fixture paints the first 56 rows in another colour, the way ghostty 1.3.1 draws its own
    // title bar inside the client area. The terminal's surface is then rows 56..599, and the
    // reported text area belongs to THAT box: a window-centred region would read the title bar.
    const { directory, release } = fixture()
    process.env.TEST_CAPTURE_WIDTH = "800"
    process.env.TEST_CAPTURE_HEIGHT = "600"
    process.env.TEST_CAPTURE_CHROME_ROWS = "56"
    writeFileSync(release, "continue")
    const capture = await createLinuxCapture(join(directory, "frames"), liveExecutable())
    const result = await capture({
      featureId: "fixture.title-bar",
      role: "target",
      label: "fixture window",
      cells: { top: 1, left: 1, bottom: 1, right: 3 },
      pixelGeometry: { cellWidth: 13, cellHeight: 24, textWidth: 780, textHeight: 528 },
    })
    expect(result.trace.textArea).toMatchObject({
      origin: { x: 10, y: 64 },
      surface: { x: 0, y: 56, width: 800, height: 544 },
    })
    expect(result.trace.rectangle).toEqual({ x: 10, y: 64, width: 39, height: 24 })
    expect(result.trace.cropCommand).toEqual([
      "magick",
      "xwd:-",
      "-crop",
      "39x24+10+64",
      "+repage",
      "-depth",
      "8",
      "rgba:-",
    ])
  },
)

test.runIf(process.platform === "linux")("capture 1306x816 vs window 1304x814 names both sizes (#28590)", async () => {
  // xterm 411 after the Xvfb grow: xwd included a 1px border, 4262784 vs 4245824.
  const { directory, release } = fixture()
  process.env.TEST_CAPTURE_WIDTH = "1304"
  process.env.TEST_CAPTURE_HEIGHT = "814"
  process.env.TEST_CAPTURE_FORCE_CAPTURE = "1306x816"
  writeFileSync(release, "continue")
  const capture = await createLinuxCapture(join(directory, "frames"), liveExecutable())
  await expect(
    capture({
      featureId: "editing.delete-chars",
      role: "target",
      label: "xterm window",
      cells: { top: 1, left: 1, bottom: 1, right: 1 },
      pixelGeometry: { cellWidth: 8, cellHeight: 16, textWidth: 800, textHeight: 480 },
    }),
  ).rejects.toThrow("capture 1306x816 differs from window 1304x814 (border included?)")
})

// C's PNG adapter must use its calibrated named origin, never Linux colour centring.
test.each(["xwd", "png"] as const)("shared %s capture digests decoded pixels at the named origin", async (format) => {
  const { directory, png } = fixture()
  const source = {
    bytes: format === "png" ? readFileSync(png) : Buffer.from("fixture-xwd"),
    format,
    width: 640,
    height: 480,
    capturedAt: 123,
  }
  const checkpoint = {
    featureId: "fixture.shared",
    role: "target" as const,
    label: "shared",
    cells: { top: 2, left: 3, bottom: 2, right: 4 },
    pixelGeometry: { cellWidth: 8, cellHeight: 16, textWidth: 640, textHeight: 480 },
  }
  const result = await finishCapture({
    directory,
    checkpoint,
    source,
    png: readFileSync(png),
    origin: { origin: { x: 2, y: 34 }, basis: "solid-cell calibration" },
    trace: { converter: "fixture" },
  })
  expect(result.frame.pixelsDigest).toBe(
    `sha256:${createHash("sha256")
      .update(Buffer.alloc(640 * 480 * 4))
      .digest("hex")}`,
  )
  expect(result.frame.regionDigest).toBe(
    `sha256:${createHash("sha256")
      .update(Buffer.alloc(16 * 16 * 4))
      .digest("hex")}`,
  )
  expect(result.trace.textArea).toEqual({ origin: { x: 2, y: 34 }, basis: "solid-cell calibration" })
  expect(result.trace.rectangle).toEqual({ x: 18, y: 50, width: 16, height: 16 })
  const retained = result.trace.retained as Record<string, string>
  expect(readFileSync(join(directory, retained[format]!))).toEqual(source.bytes)
  await expect(
    finishCapture({
      directory,
      checkpoint,
      source,
      png: readFileSync(png),
      origin: { origin: { x: 2, y: 34 }, basis: "" },
      trace: {},
    }),
  ).rejects.toThrow(/named text-area origin/)
  await expect(
    finishCapture({
      directory,
      checkpoint,
      source,
      png: readFileSync(png),
      origin: { origin: { x: 2.5, y: 34 }, basis: "calibration" },
      trace: {},
    }),
  ).rejects.toThrow(/integers/)
  const unpaired = { ...checkpoint, pixelGeometry: undefined }
  await expect(
    finishCapture({
      directory,
      checkpoint: unpaired,
      source,
      png: readFileSync(png),
      origin: { origin: { x: 2, y: 34 }, basis: "calibration" },
      trace: {},
    }),
  ).rejects.toThrow(/without both cells/)
  process.env.TEST_CAPTURE_FORCE_CAPTURE = "639x480"
  await expect(
    finishCapture({
      directory,
      checkpoint,
      source,
      png: readFileSync(png),
      origin: { origin: { x: 2, y: 34 }, basis: "calibration" },
      trace: {},
    }),
  ).rejects.toThrow("capture 639x480 differs from window 640x480")
  // A plain frame still bypasses raw decoding and origin resolution, as Linux always did.
  process.env.TEST_CAPTURE_FAIL = "conversion"
  const plain = await finishCapture({
    directory,
    checkpoint: { featureId: "fixture.plain", role: "control", label: "plain" },
    source,
    png: readFileSync(png),
    origin: () => {
      throw new Error("origin resolver must not run")
    },
    trace: { fixture: "plain" },
  })
  expect(plain.frame).toEqual({
    role: "control",
    label: "plain",
    capturedAt: 123,
    ref: result.frame.ref,
    sourceRef: result.frame.sourceRef,
  })
  expect(plain.trace).toEqual({ fixture: "plain" })
})
