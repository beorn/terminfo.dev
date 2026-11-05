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
import { command, retain } from "./capture-core.ts"

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
