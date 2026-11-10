/**
 * @failure Capture command bytes or failure/cleanup semantics change, or retained artifacts are duplicated or overwritten.
 * @level l2
 * @consumer Capture apparatus command lifecycle and AC4 immutable content-addressed retention.
 * @testonly none
 * @reach fs-walk <fixture-only: /tmp/terminfo-retain-witness>
 */
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { command, finishCapture, retain } from "./capture-core.ts"

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "terminfo-retain-witness-"))
  directories.push(path)
  return path
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

// The predecoded frame is already the pixel authority. These cases catch a second decoder
// dependency and wrong stride/extent; command/retention tests do not exercise finalization.
const PNG_STUB = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const FRAME_RGBA = Uint8Array.from({ length: 48 }, (_, index) => index)

test.each(["png", "xwd"] as const)(
  "capture finalizer crops the decoded %s frame and keeps its recipe",
  async (format) => {
    const input = {
      directory: directory(),
      onRetained: () => {},
      source: {
        bytes: format === "png" ? PNG_STUB : Buffer.from("retained XWD"),
        format,
        width: 4,
        height: 3,
        capturedAt: 1,
      },
      png: PNG_STUB,
      decoded: { width: 4, height: 3, rgba: FRAME_RGBA },
      origin: { origin: { x: 0, y: 0 }, basis: "measured fixture" },
      trace: {},
      checkpoint: {
        featureId: "crop-fixture",
        role: "target" as const,
        label: "two rows",
        cells: { top: 2, left: 2, bottom: 3, right: 3 },
        pixelGeometry: { cellWidth: 1, cellHeight: 1, textWidth: 4, textHeight: 3 },
      },
    }
    const result = await finishCapture(input)
    const expected = Buffer.from([20, 21, 22, 23, 24, 25, 26, 27, 36, 37, 38, 39, 40, 41, 42, 43])
    expect(result.frame.regionDigest).toBe(`sha256:${digest(expected)}`)
    expect(result.frame.regionRectangle).toEqual({ x: 1, y: 1, width: 2, height: 2 })
    expect(result.trace.cropCommand).toEqual([
      "magick",
      `${format}:-`,
      "-crop",
      "2x2+1+1",
      "+repage",
      "-depth",
      "8",
      "rgba:-",
    ])
    expect(result.trace.reproduceRegion).toContain("-crop 2x2+1+1 +repage -depth 8 rgba:- | sha256sum")
    const moved = await finishCapture({
      ...input,
      checkpoint: { ...input.checkpoint, cells: { top: 2, left: 3, bottom: 3, right: 4 } },
    })
    expect(moved.frame.regionDigest).not.toBe(result.frame.regionDigest)
  },
)

test("capture finalizer crops the same-shot control region from the same decoded frame (#33117)", async () => {
  const result = await finishCapture({
    directory: directory(),
    onRetained: () => {},
    source: { bytes: PNG_STUB, format: "png", width: 4, height: 3, capturedAt: 1 },
    png: PNG_STUB,
    decoded: { width: 4, height: 3, rgba: FRAME_RGBA },
    origin: { origin: { x: 0, y: 0 }, basis: "measured fixture" },
    trace: {},
    checkpoint: {
      featureId: "crop-fixture",
      role: "target" as const,
      label: "styled row beside plain row",
      cells: { top: 2, left: 2, bottom: 3, right: 3 },
      controlCells: { top: 1, left: 2, bottom: 1, right: 3 },
      pixelGeometry: { cellWidth: 1, cellHeight: 1, textWidth: 4, textHeight: 3 },
    },
  })
  const expectedControl = Buffer.from([4, 5, 6, 7, 8, 9, 10, 11])
  expect(result.frame.controlRegionDigest).toBe(`sha256:${digest(expectedControl)}`)
  expect(result.frame.controlRegionRectangle).toEqual({ x: 1, y: 0, width: 2, height: 1 })
  expect(result.trace.reproduceControlRegion).toContain("-crop 2x1+1+0 +repage -depth 8 rgba:- | sha256sum")
  const expectedRegion = Buffer.from([20, 21, 22, 23, 24, 25, 26, 27, 36, 37, 38, 39, 40, 41, 42, 43])
  expect(result.frame.regionDigest).toBe(`sha256:${digest(expectedRegion)}`)
})

test.each([
  { width: 3, height: 3, rgba: FRAME_RGBA },
  { width: 4, height: 2, rgba: FRAME_RGBA },
  { width: 4, height: 3, rgba: FRAME_RGBA.subarray(0, 47) },
])("capture finalizer rejects decoded extent or byte-length mismatch: $width x $height", async (decoded) => {
  await expect(
    finishCapture({
      directory: directory(),
      onRetained: () => {},
      source: { bytes: PNG_STUB, format: "png", width: 4, height: 3, capturedAt: 1 },
      png: PNG_STUB,
      decoded,
      origin: { origin: { x: 0, y: 0 }, basis: "measured fixture" },
      trace: {},
      checkpoint: { featureId: "mismatch-fixture", role: "target", label: "mismatched decoded frame" },
    }),
  ).rejects.toThrow(/Decoded capture.*source/)
})

test.each<{
  name: string
  source?: string
  input?: Buffer
  deadline?: boolean
  stdout?: Buffer
  error?: Record<string, unknown>
  stream?: "stdout" | "stderr"
  observerThrows?: boolean
}>([
  {
    name: "binary stdin/stdout/stderr",
    source: "process.stdin.pipe(process.stdout); process.stderr.write(Buffer.from([0,255,10]))",
    input: Buffer.from([0, 17, 255, 10]),
    stdout: Buffer.from([0, 17, 255, 10]),
  },
  {
    name: "native nonzero exit",
    source:
      "process.stdout.write(Buffer.from([17,0,23])); process.stderr.write(Buffer.from([100,0,255,10])); process.exit(17)",
    error: { code: 17, killed: false, signal: null },
  },
  { name: "missing executable", error: { code: "ENOENT" } },
  {
    name: "deadline SIGKILL",
    source: "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
    deadline: true,
    error: { killed: true, signal: "SIGKILL" },
  },
  { name: "default SIGTERM", source: "setInterval(()=>{},1000)", error: { killed: true, signal: "SIGTERM" } },
  {
    name: "stdout overflow",
    source: "process.stdout.write(Buffer.alloc(32*1024*1024+1,7)); setInterval(()=>{},1000)",
    stream: "stdout",
    error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true },
  },
  {
    name: "stderr overflow",
    source: "process.stderr.write(Buffer.alloc(32*1024*1024+1,7)); setInterval(()=>{},1000)",
    stream: "stderr",
    error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true },
  },
  {
    name: "stderr observer throws",
    source: "process.stderr.write('observer bytes')",
    observerThrows: true,
    error: { message: "observer refused" },
  },
  {
    name: "stdin error",
    source: "require('node:fs').closeSync(0); setTimeout(()=>{},100)",
    input: Buffer.alloc(1024 * 1024),
    error: { code: "EPIPE" },
  },
])(
  "capture command contract: $name",
  async ({ source, input, deadline, stdout, error, stream, observerThrows }) => {
    const observed: Buffer[] = []
    const invocation = command(
      source === undefined ? join(directory(), "absent-command") : process.execPath,
      source === undefined ? [] : ["-e", source],
      input,
      deadline ? Date.now() + 500 : undefined,
      (stderr) => {
        observed.push(stderr)
        if (observerThrows) throw new Error("observer refused")
      },
    )
    if (error === undefined) {
      expect(await invocation).toEqual(stdout)
      expect(observed).toEqual([Buffer.from([0, 255, 10])])
      return
    }
    const failure = await invocation.then(
      () => {
        throw new Error("Expected capture command to reject")
      },
      (cause: unknown) => cause as Error & { captureCommand?: { stdoutBase64: string; stderrBase64: string } },
    )
    const diagnostic = Object.fromEntries(Object.keys(error).map((key) => [key, Reflect.get(failure, key)]))
    expect(diagnostic).toMatchObject(error)
    if (source?.includes("process.exit(17)")) {
      expect(failure.captureCommand).toMatchObject({
        stdoutBase64: Buffer.from([17, 0, 23]).toString("base64"),
        stderrBase64: Buffer.from([100, 0, 255, 10]).toString("base64"),
        code: 17,
        signal: null,
        killed: false,
      })
    }
    if (stream !== undefined) {
      const retained = failure.captureCommand?.[stream === "stdout" ? "stdoutBase64" : "stderrBase64"]
      expect(retained).toBeDefined()
      const retainedBytes = Buffer.from(retained!, "base64")
      expect(retainedBytes.length).toBe(32 * 1024 * 1024)
      expect(retainedBytes.equals(Buffer.alloc(32 * 1024 * 1024, 7))).toBe(true)
    }
  },
  15000,
)

test("an identical repeat is the same artifact: same ref, one file, bytes untouched (#30764 AC4)", () => {
  const dir = directory()
  const bytes = Buffer.from("\u0089PNG\r\n\u001a\n same screen, same bytes")

  const first = retain(dir, bytes, "png", () => {})
  const second = retain(dir, bytes, "png", () => {})

  expect(first).toBe(`sha256:${digest(bytes)}`)
  expect(second).toBe(first)
  expect(readdirSync(dir)).toEqual([`${digest(bytes)}.png`])
  expect(readFileSync(join(dir, `${digest(bytes)}.png`)).equals(bytes)).toBe(true)
})

test("different bytes behind an existing name are named, never overwritten (#30764 AC4)", () => {
  const dir = directory()
  const bytes = Buffer.from("the bytes the digest names")
  const impostor = Buffer.from("different bytes, same name")
  const path = join(dir, `${digest(bytes)}.bin`)
  writeFileSync(path, impostor)

  expect(() => retain(dir, bytes, "bin", () => {})).toThrow(/digest collision/)
  expect(readFileSync(path).equals(impostor)).toBe(true)
})

test("the extension is part of the name: one digest may hold two encodings without collision (#30764 AC4)", () => {
  const dir = directory()
  const bytes = Buffer.from("one capture, two extensions")

  const png = retain(dir, bytes, "png", () => {})
  const xwd = retain(dir, bytes, "xwd", () => {})

  expect(png).toBe(xwd)
  expect(readdirSync(dir).sort()).toEqual([`${digest(bytes)}.png`, `${digest(bytes)}.xwd`])
})
