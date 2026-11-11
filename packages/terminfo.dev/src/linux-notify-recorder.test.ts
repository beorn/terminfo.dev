/**
 * @failure The App-run Notify recorder misses or misanswers a desktop notification: a control Notify from a client we
 *   did not write goes unrecorded, a second owner on a held name proceeds or writes a receipt, a call or an
 *   uninterpretable message leaves no record line, so notification rows read from a broken observer.
 * @level l3
 * @consumer 33053 private session bus Notify recorder for owned Linux App runs (@cto conditions 1-3).
 * @testonly none
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { createNotificationObserver } from "./linux-notification.ts"
import {
  DbusFramer,
  DbusFramingError,
  drainFrames,
  encodeMessage,
  MessageType,
  NOTIFY_RECEIPT_SCHEMA,
  parseNotifyRecord,
  type DbusMessage,
} from "./linux-notify-recorder.ts"

const recorderPath = join(dirname(fileURLToPath(import.meta.url)), "linux-notify-recorder.ts")
const children: ChildProcess[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill("SIGTERM")
      await exited
    }),
  )
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A missing D-Bus tool is a broken test host, never a skip. */
function requireBinary(name: string): string {
  const probe = spawnSync(name, ["--version"], { encoding: "utf8" })
  if (probe.error) {
    throw new Error(`${name} is required on PATH for the notify recorder test (D-Bus package): ${probe.error.message}`)
  }
  return name
}

const bun = (): string => (process.versions.bun !== undefined ? process.execPath : requireBinary("bun"))

async function until<T>(read: () => T | undefined, describe: () => string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${describe()}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

interface Bus {
  readonly directory: string
  readonly address: string
}

async function startBus(): Promise<Bus> {
  requireBinary("dbus-daemon")
  const directory = mkdtempSync(join(tmpdir(), "terminfo-notify-"))
  directories.push(directory)
  const socket = join(directory, "bus")
  if (Buffer.byteLength(socket) > 107) throw new Error(`unix socket path exceeds 107 bytes: ${socket}`)
  const daemon = spawn("dbus-daemon", ["--session", "--nofork", `--address=unix:path=${socket}`, "--print-address=1"], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(daemon)
  let stdout = ""
  let stderr = ""
  daemon.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
  daemon.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
  const address = await until(
    () => {
      if (daemon.exitCode !== null) throw new Error(`dbus-daemon exited ${daemon.exitCode}: ${stderr}`)
      return stdout.includes("\n") ? stdout.split("\n")[0] : undefined
    },
    () => `dbus-daemon to print its address (stderr: ${stderr})`,
  )
  return { directory, address }
}

interface Recorder {
  readonly child: ChildProcess
  readonly recordPath: string
  readonly receiptPath: string
  readonly exit: Promise<{ code: number | null; stderr: string }>
}

function spawnRecorder(bus: Bus, label: string): Recorder {
  const recordPath = join(bus.directory, `${label}.jsonl`)
  const receiptPath = join(bus.directory, `${label}-receipt.json`)
  const child = spawn(
    bun(),
    ["--no-env-file", recorderPath, "--address", bus.address, "--record", recordPath, "--receipt", receiptPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  )
  children.push(child)
  let stderr = ""
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
  const exit = new Promise<{ code: number | null; stderr: string }>((resolve) =>
    child.once("exit", (code) => resolve({ code, stderr })),
  )
  return { child, recordPath, receiptPath, exit }
}

async function startRecorder(bus: Bus): Promise<Recorder> {
  const recorder = spawnRecorder(bus, "primary")
  let exited: string | undefined
  void recorder.exit.then(({ code, stderr }) => (exited = `exited ${code}: ${stderr}`))
  await until(
    () => {
      if (exited !== undefined) throw new Error(`recorder ${exited}`)
      return existsSync(recorder.receiptPath) ? true : undefined
    },
    () => `recorder receipt ${recorder.receiptPath}`,
  )
  return recorder
}

/** dbus-send is the independent client (@cto condition 1): its marshalling is libdbus, not ours. */
function dbusSend(bus: Bus, member: string, args: readonly string[] = []): { status: number | null; output: string } {
  const result = spawnSync(
    requireBinary("dbus-send"),
    [
      "--session",
      "--print-reply",
      "--dest=org.freedesktop.Notifications",
      "/org/freedesktop/Notifications",
      `org.freedesktop.Notifications.${member}`,
      ...args,
    ],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: bus.address } },
  )
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const notifyArgs = (nonce: string): string[] => [
  "string:app",
  "uint32:0",
  "string:icon",
  `string:summary ${nonce}`,
  `string:body ${nonce}`,
  "array:string:",
  "dict:string:variant:",
  "int32:-1",
]

test("a control Notify from dbus-send gets a uint32 id and its nonce lands in the record", async () => {
  const bus = await startBus()
  const recorder = await startRecorder(bus)
  const receipt = JSON.parse(readFileSync(recorder.receiptPath, "utf8"))
  expect(receipt).toMatchObject({
    schema: NOTIFY_RECEIPT_SCHEMA,
    address: bus.address,
    pid: recorder.child.pid,
    owned: true,
    name: "org.freedesktop.Notifications",
    recordPath: recorder.recordPath,
  })

  const nonce = randomBytes(8).toString("hex")
  const first = dbusSend(bus, "Notify", notifyArgs(nonce))
  expect(first).toMatchObject({ status: 0 })
  expect(first.output).toMatch(/^\s*uint32 1$/m)
  const second = dbusSend(bus, "Notify", notifyArgs(`${nonce}-2`))
  expect(second.output).toMatch(/^\s*uint32 2$/m)

  const notifies = parseNotifyRecord(readFileSync(recorder.recordPath, "utf8"), recorder.recordPath).filter(
    (entry) => entry.kind === "notify",
  )
  expect(notifies).toHaveLength(2)
  expect(notifies[0]).toMatchObject({
    appName: "app",
    replacesId: 0,
    appIcon: "icon",
    summary: `summary ${nonce}`,
    body: `body ${nonce}`,
    actions: [],
    hintKeys: [],
    expireTimeout: -1,
    id: 1,
  })
  expect(notifies[0]!.sender).toMatch(/^:\d+\.\d+$/)
})

test("a second recorder on a held name refuses loudly and writes no receipt", async () => {
  const bus = await startBus()
  await startRecorder(bus)
  const second = spawnRecorder(bus, "second")
  const { code, stderr } = await second.exit
  expect(code).toBe(1)
  expect(stderr).toContain("replied 3 (EXISTS), not PRIMARY_OWNER(1)")
  expect(existsSync(second.receiptPath)).toBe(false)
  expect(existsSync(second.recordPath)).toBe(false)
})

test("the App observer qualifies its own bus with dbus-send and excludes notifications before its write cursor", async () => {
  const bus = await startBus()
  const recorder = await startRecorder(bus)
  expect(dbusSend(bus, "Notify", notifyArgs("stale-target")).status).toBe(0)
  const observer = await createNotificationObserver({ receiptPath: recorder.receiptPath, address: bus.address })
  expect(observer.control.id).toBe(2)
  const cursor = observer.cursor()
  expect(observer.readSince(cursor).entries).toEqual([])
  expect(dbusSend(bus, "Notify", notifyArgs("after-write")).status).toBe(0)
  const reading = observer.readSince(cursor)
  expect(reading.problems).toEqual([])
  expect(reading.entries).toMatchObject([{ summary: "summary after-write", body: "body after-write", id: 3 }])
  expect(observer.control.nonce).not.toBe("stale-target")
})

test("the App observer keeps an unreadable Notify visible as a problem, never a clean empty reading", async () => {
  const bus = await startBus()
  const recorder = await startRecorder(bus)
  const observer = await createNotificationObserver({ receiptPath: recorder.receiptPath, address: bus.address })
  const cursor = observer.cursor()
  expect(dbusSend(bus, "Notify", ["string:incomplete"]).status).not.toBe(0)
  const reading = observer.readSince(cursor)
  expect(reading.entries).toEqual([])
  expect(reading.problems).toEqual([expect.stringContaining('Notify signature "s"')])
})

test("GetCapabilities, GetServerInformation and an unknown method each leave a call line", async () => {
  const bus = await startBus()
  const recorder = await startRecorder(bus)
  const capabilities = dbusSend(bus, "GetCapabilities")
  expect(capabilities.status).toBe(0)
  expect(capabilities.output).toMatch(/array \[\s*string "body"\s*\]/)
  expect(dbusSend(bus, "GetServerInformation").output).toContain('string "terminfo-notify-recorder"')
  const unknown = dbusSend(bus, "Bogus")
  expect(unknown.status).not.toBe(0)
  expect(unknown.output).toContain("org.freedesktop.DBus.Error.UnknownMethod")

  const calls = parseNotifyRecord(readFileSync(recorder.recordPath, "utf8"), recorder.recordPath).filter(
    (entry) => entry.kind === "call",
  )
  expect(calls.map((entry) => [entry.member, entry.reply])).toEqual([
    ["GetCapabilities", "return"],
    ["GetServerInformation", "return"],
    ["Bogus", "org.freedesktop.DBus.Error.UnknownMethod"],
  ])
})

test("a Notify it cannot interpret is recorded as unparsed, answered InvalidArgs, and serving continues", async () => {
  const bus = await startBus()
  const recorder = await startRecorder(bus)
  const bad = dbusSend(bus, "Notify", ["string:only-one-arg"])
  expect(bad.status).not.toBe(0)
  expect(bad.output).toContain("org.freedesktop.DBus.Error.InvalidArgs")
  const nonce = randomBytes(8).toString("hex")
  expect(dbusSend(bus, "Notify", notifyArgs(nonce)).output).toMatch(/^\s*uint32 1$/m)

  const entries = parseNotifyRecord(readFileSync(recorder.recordPath, "utf8"), recorder.recordPath)
  expect(entries.map((entry) => entry.kind)).toEqual(["unparsed", "notify"])
  const unparsed = entries[0]!
  if (unparsed.kind !== "unparsed") throw new Error("first entry is not unparsed")
  expect(unparsed.reason).toBe('Notify signature "s" is not "susssasa{sv}i"')
  expect(Buffer.from(unparsed.rawHex, "hex").toString("latin1")).toContain("only-one-arg")
  expect(unparsed.length).toBe(unparsed.rawHex.length / 2)
})

test("an undecodable frame mid-stream goes to unparsed and later frames still decode; a lost frame start is fatal", () => {
  const ping = (serial: number): Uint8Array =>
    encodeMessage(
      { type: MessageType.signal, path: "/x", interface: "x.y", member: "Ping", signature: "s", body: [`n${serial}`] },
      serial,
    )
  const corrupt = ping(2)
  // The body string's length prefix now claims more bytes than the frame holds; the frame length stays intact.
  const view = new DataView(corrupt.buffer)
  view.setUint32(corrupt.length - view.getUint32(4, true), 0xff, true)
  const stream = new Uint8Array([...ping(1), ...corrupt, ...ping(3)])

  const decoded: DbusMessage[] = []
  const unparsed: { reason: string; length: number }[] = []
  const framer = new DbusFramer()
  // Split mid-frame to prove reassembly across chunks.
  for (const chunk of [stream.subarray(0, 50), stream.subarray(50)]) {
    drainFrames(framer, chunk, {
      message: (message) => decoded.push(message),
      unparsed: (reason, frame) => unparsed.push({ reason, length: frame.length }),
    })
  }
  expect(decoded.map((message) => message.body[0])).toEqual(["n1", "n3"])
  expect(unparsed).toEqual([{ reason: expect.stringMatching(/needs 256 bytes/), length: corrupt.length }])

  const lost = new Uint8Array(16).fill(0x58)
  expect(() => new DbusFramer().push(lost)).toThrow(DbusFramingError)
  expect(() => new DbusFramer().push(lost)).toThrow(/endianness byte 88/)
})

test("the record reader refuses a malformed or torn line by source and line number", () => {
  const good = JSON.stringify({ kind: "fatal", reason: "x", monotonicMs: 1, wallTime: "t" })
  expect(parseNotifyRecord(`${good}\n`, "rec")).toHaveLength(1)
  expect(() => parseNotifyRecord(`${good}\n{"kind":"notify","monotonicMs":1,"wallTime":"t"}\n`, "rec")).toThrow(
    "rec:2: notify field sender is missing or mistyped",
  )
  expect(() => parseNotifyRecord(good, "rec")).toThrow("rec: last line is not newline-terminated")
})
