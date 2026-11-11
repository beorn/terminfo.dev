/**
 * Notify recorder for owned Linux App runs (33053 step 1).
 *
 * A minimal D-Bus client over a unix socket that owns `org.freedesktop.Notifications` on a private session bus and
 * appends every call it receives to a JSONL record. Hand-rolled (no JS D-Bus dependency in the runner bundle): EXTERNAL
 * auth, Hello, RequestName with DO_NOT_QUEUE, and the marshalling subset the Notifications interface needs.
 *
 * Receipt: written atomically only after the bus says PRIMARY_OWNER; any other RequestName reply refuses loudly.
 * Record: one line per Notify (`notify`), per other method call (`call`), per message it cannot interpret (`unparsed`,
 * bounded raw hex), per message it does not act on (`ignored`), and a `fatal` line before a non-zero exit when the
 * stream loses framing or the bus goes away. Nothing received is dropped without a line.
 *
 * CLI: `bun linux-notify-recorder.ts --address <addr> --record <path> --receipt <path>`; SIGTERM exits 0.
 */
import { appendFileSync, renameSync, writeFileSync } from "node:fs"
import { connect, type Socket } from "node:net"

export const NOTIFICATIONS_NAME = "org.freedesktop.Notifications"
export const NOTIFICATIONS_PATH = "/org/freedesktop/Notifications"
export const NOTIFY_RECEIPT_SCHEMA = "terminfo-notify-recorder-receipt/1"
export const NOTIFY_SIGNATURE = "susssasa{sv}i"
const SERVER_INFORMATION = ["terminfo-notify-recorder", "terminfo.dev", "1", "1.2"] as const
const RAW_HEX_LIMIT = 4096
const MAX_MESSAGE_BYTES = 2 ** 27
const MAX_ARRAY_BYTES = 2 ** 26
const MAX_DEPTH = 64
const CALL_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------------------------------------------
// Addresses

export interface BusSocketAddress {
  readonly kind: "path" | "abstract"
  readonly name: string
}

/** First `unix:path=` or `unix:abstract=` entry of a D-Bus address list; anything else is refused by name. */
export function parseBusAddress(address: string): BusSocketAddress {
  const refused: string[] = []
  for (const entry of address.split(";")) {
    if (entry === "") continue
    const colon = entry.indexOf(":")
    const transport = colon < 0 ? entry : entry.slice(0, colon)
    if (transport !== "unix") {
      refused.push(`${transport}: transport unsupported`)
      continue
    }
    const keys = new Map<string, string>()
    for (const pair of entry.slice(colon + 1).split(",")) {
      if (pair === "") continue
      const eq = pair.indexOf("=")
      if (eq < 0) throw new Error(`D-Bus address entry ${JSON.stringify(entry)} has key without value: ${pair}`)
      keys.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)))
    }
    const path = keys.get("path")
    if (path !== undefined) return { kind: "path", name: path }
    const abstract = keys.get("abstract")
    if (abstract !== undefined) return { kind: "abstract", name: abstract }
    refused.push(`unix: needs path= or abstract= (has ${[...keys.keys()].join(",") || "no keys"})`)
  }
  throw new Error(`D-Bus address ${JSON.stringify(address)} has no usable unix socket entry (${refused.join("; ")})`)
}

// ---------------------------------------------------------------------------------------------------------------
// Signatures and values

type BasicCode = "y" | "b" | "n" | "q" | "i" | "u" | "x" | "t" | "d" | "h" | "s" | "o" | "g"
export type DbusType =
  | { readonly kind: "basic"; readonly code: BasicCode }
  | { readonly kind: "array"; readonly element: DbusType }
  | { readonly kind: "struct"; readonly fields: readonly DbusType[] }
  | { readonly kind: "dict"; readonly key: DbusType; readonly value: DbusType }
  | { readonly kind: "variant" }

/** A variant value; arrays, structs and dict entries are JS arrays (a dict entry is a `[key, value]` pair). */
export interface DbusVariant {
  readonly signature: string
  readonly value: unknown
}

const BASIC_CODES = new Set<string>(["y", "b", "n", "q", "i", "u", "x", "t", "d", "h", "s", "o", "g"])

export function parseSignature(signature: string): DbusType[] {
  let at = 0
  const one = (depth: number): DbusType => {
    if (depth > MAX_DEPTH) throw new DbusParseError(`signature ${JSON.stringify(signature)} nests too deep`)
    const code = signature[at++]
    if (code === undefined) throw new DbusParseError(`signature ${JSON.stringify(signature)} ends inside a type`)
    if (BASIC_CODES.has(code)) return { kind: "basic", code: code as BasicCode }
    if (code === "v") return { kind: "variant" }
    if (code === "a") {
      if (signature[at] === "{") {
        at++
        const key = one(depth + 1)
        if (key.kind !== "basic") {
          throw new DbusParseError(`signature ${JSON.stringify(signature)} has a non-basic dict key`)
        }
        const value = one(depth + 1)
        if (signature[at++] !== "}") {
          throw new DbusParseError(`signature ${JSON.stringify(signature)} has an unclosed {`)
        }
        return { kind: "array", element: { kind: "dict", key, value } }
      }
      return { kind: "array", element: one(depth + 1) }
    }
    if (code === "(") {
      const fields: DbusType[] = []
      while (signature[at] !== ")") {
        if (at >= signature.length) throw new DbusParseError(`signature ${JSON.stringify(signature)} has an unclosed (`)
        fields.push(one(depth + 1))
      }
      at++
      if (fields.length === 0) throw new DbusParseError(`signature ${JSON.stringify(signature)} has an empty struct`)
      return { kind: "struct", fields }
    }
    throw new DbusParseError(`signature ${JSON.stringify(signature)} has unknown type code ${JSON.stringify(code)}`)
  }
  if (signature.length > 255) throw new DbusParseError(`signature longer than 255 bytes (${signature.length})`)
  const types: DbusType[] = []
  while (at < signature.length) types.push(one(0))
  return types
}

function alignment(type: DbusType): number {
  switch (type.kind) {
    case "variant":
      return 1
    case "array":
      return 4
    case "struct":
    case "dict":
      return 8
    case "basic":
      return { y: 1, g: 1, n: 2, q: 2, b: 4, i: 4, u: 4, h: 4, s: 4, o: 4, x: 8, t: 8, d: 8 }[type.code]
  }
}

export class DbusParseError extends Error {}
export class DbusFramingError extends Error {}

const utf8 = new TextDecoder("utf-8", { fatal: true })
const utf8Encoder = new TextEncoder()

class Reader {
  private at = 0
  private readonly view: DataView
  constructor(
    private readonly bytes: Uint8Array,
    private readonly little: boolean,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  get offset(): number {
    return this.at
  }
  get remaining(): number {
    return this.bytes.length - this.at
  }
  align(n: number): void {
    const next = Math.ceil(this.at / n) * n
    this.need(next - this.at)
    for (let i = this.at; i < next; i++) {
      if (this.bytes[i] !== 0) throw new DbusParseError(`non-zero alignment padding at byte ${i}`)
    }
    this.at = next
  }
  private need(n: number): void {
    if (this.at + n > this.bytes.length) {
      throw new DbusParseError(`value needs ${n} bytes at ${this.at}, only ${this.bytes.length - this.at} remain`)
    }
  }
  private take(n: number): number {
    this.need(n)
    const at = this.at
    this.at += n
    return at
  }
  u8(): number {
    return this.view.getUint8(this.take(1))
  }
  u32(): number {
    this.align(4)
    return this.view.getUint32(this.take(4), this.little)
  }
  string(lengthBytes: 1 | 4): string {
    const length = lengthBytes === 1 ? this.u8() : this.u32()
    const at = this.take(length + 1)
    if (this.bytes[at + length] !== 0) throw new DbusParseError(`string at ${at} is not nul-terminated`)
    try {
      return utf8.decode(this.bytes.subarray(at, at + length))
    } catch {
      throw new DbusParseError(`string at ${at} is not valid UTF-8`)
    }
  }
  value(type: DbusType, depth = 0): unknown {
    if (depth > MAX_DEPTH) throw new DbusParseError("value nests too deep")
    switch (type.kind) {
      case "basic":
        return this.basic(type.code)
      case "variant": {
        const signature = this.string(1)
        const types = parseSignature(signature)
        const type = types[0]
        if (types.length !== 1 || type === undefined) {
          throw new DbusParseError(`variant signature ${JSON.stringify(signature)} is not one type`)
        }
        return { signature, value: this.value(type, depth + 1) } satisfies DbusVariant
      }
      case "struct":
      case "dict": {
        this.align(8)
        const fields = type.kind === "struct" ? type.fields : [type.key, type.value]
        return fields.map((field) => this.value(field, depth + 1))
      }
      case "array": {
        const length = this.u32()
        if (length > MAX_ARRAY_BYTES) throw new DbusParseError(`array length ${length} exceeds 64 MiB`)
        this.align(alignment(type.element))
        const end = this.at + length
        this.need(length)
        const items: unknown[] = []
        while (this.at < end) items.push(this.value(type.element, depth + 1))
        if (this.at !== end) throw new DbusParseError(`array elements overrun the declared length ${length}`)
        return items
      }
    }
  }
  private basic(code: BasicCode): unknown {
    switch (code) {
      case "y":
        return this.u8()
      case "b": {
        const value = this.u32()
        if (value > 1) throw new DbusParseError(`boolean value ${value} is neither 0 nor 1`)
        return value === 1
      }
      case "n":
        this.align(2)
        return this.view.getInt16(this.take(2), this.little)
      case "q":
        this.align(2)
        return this.view.getUint16(this.take(2), this.little)
      case "i":
        this.align(4)
        return this.view.getInt32(this.take(4), this.little)
      case "u":
      case "h":
        return this.u32()
      case "x":
        this.align(8)
        return this.view.getBigInt64(this.take(8), this.little)
      case "t":
        this.align(8)
        return this.view.getBigUint64(this.take(8), this.little)
      case "d":
        this.align(8)
        return this.view.getFloat64(this.take(8), this.little)
      case "s":
      case "o":
        return this.string(4)
      case "g":
        return this.string(1)
    }
  }
}

/** Little-endian writer; offsets are relative to its own start, which callers keep 8-aligned in the message. */
class Writer {
  private bytes = new Uint8Array(256)
  private view = new DataView(this.bytes.buffer)
  private at = 0
  get length(): number {
    return this.at
  }
  finish(): Uint8Array {
    return this.bytes.slice(0, this.at)
  }
  private reserve(n: number): number {
    if (this.at + n > this.bytes.length) {
      const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.at + n))
      grown.set(this.bytes)
      this.bytes = grown
      this.view = new DataView(grown.buffer)
    }
    const at = this.at
    this.at += n
    return at
  }
  align(n: number): void {
    const next = Math.ceil(this.at / n) * n
    this.reserve(next - this.at)
  }
  u8(value: number): void {
    this.view.setUint8(this.reserve(1), value)
  }
  u32(value: number): void {
    this.align(4)
    this.view.setUint32(this.reserve(4), value, true)
  }
  patchU32(at: number, value: number): void {
    this.view.setUint32(at, value, true)
  }
  string(value: string, lengthBytes: 1 | 4): void {
    const encoded = utf8Encoder.encode(value)
    if (lengthBytes === 1) this.u8(encoded.length)
    else this.u32(encoded.length)
    this.bytes.set(encoded, this.reserve(encoded.length + 1))
  }
  value(type: DbusType, value: unknown): void {
    switch (type.kind) {
      case "basic":
        return this.basic(type.code, value)
      case "variant": {
        const variant = value as DbusVariant
        const types = parseSignature(variant.signature)
        const type = types[0]
        if (types.length !== 1 || type === undefined) {
          throw new TypeError(`variant signature ${variant.signature} is not one type`)
        }
        this.string(variant.signature, 1)
        return this.value(type, variant.value)
      }
      case "struct":
      case "dict": {
        this.align(8)
        const fields = type.kind === "struct" ? type.fields : [type.key, type.value]
        const items = value as readonly unknown[]
        if (!Array.isArray(items) || items.length !== fields.length) {
          throw new TypeError(`${type.kind} needs ${fields.length} fields`)
        }
        fields.forEach((field, index) => this.value(field, items[index]))
        return
      }
      case "array": {
        if (!Array.isArray(value)) throw new TypeError("array value is not an array")
        this.u32(0)
        const lengthAt = this.at - 4
        this.align(alignment(type.element))
        const start = this.at
        for (const item of value) this.value(type.element, item)
        this.patchU32(lengthAt, this.at - start)
        return
      }
    }
  }
  private basic(code: BasicCode, value: unknown): void {
    switch (code) {
      case "y":
        return this.u8(value as number)
      case "b":
        return this.u32(value ? 1 : 0)
      case "n":
        this.align(2)
        return this.view.setInt16(this.reserve(2), value as number, true)
      case "q":
        this.align(2)
        return this.view.setUint16(this.reserve(2), value as number, true)
      case "i":
        this.align(4)
        return this.view.setInt32(this.reserve(4), value as number, true)
      case "u":
      case "h":
        return this.u32(value as number)
      case "x":
        this.align(8)
        return this.view.setBigInt64(this.reserve(8), value as bigint, true)
      case "t":
        this.align(8)
        return this.view.setBigUint64(this.reserve(8), value as bigint, true)
      case "d":
        this.align(8)
        return this.view.setFloat64(this.reserve(8), value as number, true)
      case "s":
      case "o":
        return this.string(value as string, 4)
      case "g":
        return this.string(value as string, 1)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Messages

export const MessageType = { methodCall: 1, methodReturn: 2, error: 3, signal: 4 } as const
const NO_REPLY_EXPECTED = 0x1
const FIELD = {
  path: 1,
  interface: 2,
  member: 3,
  errorName: 4,
  replySerial: 5,
  destination: 6,
  sender: 7,
  signature: 8,
  unixFds: 9,
} as const
const FIELD_SIGNATURE: Record<number, string> = {
  1: "o",
  2: "s",
  3: "s",
  4: "s",
  5: "u",
  6: "s",
  7: "s",
  8: "g",
  9: "u",
}
const HEADER_TYPES = parseSignature("yyyyuua(yv)")

export interface DbusMessage {
  readonly type: number
  readonly flags: number
  readonly serial: number
  readonly path?: string
  readonly interface?: string
  readonly member?: string
  readonly errorName?: string
  readonly replySerial?: number
  readonly destination?: string
  readonly sender?: string
  readonly signature: string
  readonly body: readonly unknown[]
}

export type OutgoingMessage = Omit<DbusMessage, "serial" | "flags" | "sender"> & { readonly flags?: number }

export function encodeMessage(message: OutgoingMessage, serial: number): Uint8Array {
  const body = new Writer()
  const bodyTypes = parseSignature(message.signature)
  if (bodyTypes.length !== message.body.length) {
    throw new TypeError(`body has ${message.body.length} values for signature ${message.signature}`)
  }
  bodyTypes.forEach((type, index) => body.value(type, message.body[index]))
  const fields: [number, DbusVariant][] = []
  const add = (code: number, value: unknown): void => {
    if (value === undefined) return
    const signature = FIELD_SIGNATURE[code]
    if (signature === undefined) throw new TypeError(`unknown D-Bus header field ${code}`)
    fields.push([code, { signature, value }])
  }
  add(FIELD.path, message.path)
  add(FIELD.interface, message.interface)
  add(FIELD.member, message.member)
  add(FIELD.errorName, message.errorName)
  add(FIELD.replySerial, message.replySerial)
  add(FIELD.destination, message.destination)
  if (message.signature !== "") add(FIELD.signature, message.signature)
  const header = new Writer()
  const values = ["l".charCodeAt(0), message.type, message.flags ?? 0, 1, body.length, serial, fields]
  HEADER_TYPES.forEach((type, index) => header.value(type, values[index]))
  header.align(8)
  const head = header.finish()
  const out = new Uint8Array(head.length + body.length)
  out.set(head)
  out.set(body.finish(), head.length)
  return out
}

function frameEndianness(byte: number | undefined): boolean {
  if (byte === 0x6c) return true
  if (byte === 0x42) return false
  throw new DbusFramingError(`message starts with endianness byte ${String(byte)}, neither 'l' nor 'B'`)
}

/** Decodes one complete frame (as cut by {@link DbusFramer}); any malformation throws {@link DbusParseError}. */
export function decodeMessage(frame: Uint8Array): DbusMessage {
  let little: boolean
  try {
    little = frameEndianness(frame[0])
  } catch (error) {
    throw new DbusParseError((error as Error).message)
  }
  const reader = new Reader(frame, little)
  const [, type, flags, version, bodyLength, serial, rawFields] = HEADER_TYPES.map((t) => reader.value(t)) as [
    number,
    number,
    number,
    number,
    number,
    number,
    [number, DbusVariant][],
  ]
  if (version !== 1) throw new DbusParseError(`protocol version ${version} is not 1`)
  if (type < 1 || type > 4) throw new DbusParseError(`message type ${type} is not 1-4`)
  if (serial === 0) throw new DbusParseError("message serial is 0")
  reader.align(8)
  if (reader.remaining !== bodyLength) {
    throw new DbusParseError(`frame holds ${reader.remaining} body bytes, header declares ${bodyLength}`)
  }
  const fields: Record<string, unknown> = {}
  const names = Object.fromEntries(Object.entries(FIELD).map(([name, code]) => [code, name]))
  for (const [code, variant] of rawFields) {
    const name = names[code]
    if (name === undefined) continue
    if (variant.signature !== FIELD_SIGNATURE[code]) {
      throw new DbusParseError(`header field ${name} has signature ${variant.signature}, not ${FIELD_SIGNATURE[code]}`)
    }
    fields[name] = variant.value
  }
  const signature = typeof fields.signature === "string" ? fields.signature : ""
  const bodyBytes = frame.subarray(reader.offset)
  const bodyReader = new Reader(bodyBytes, little)
  const body = parseSignature(signature).map((t) => bodyReader.value(t))
  if (bodyReader.remaining !== 0) {
    throw new DbusParseError(`body signature ${JSON.stringify(signature)} leaves ${bodyReader.remaining} bytes unread`)
  }
  if (typeof fields.unixFds === "number" && fields.unixFds > 0) {
    throw new DbusParseError(`message carries ${fields.unixFds} unix fds; fd passing was not negotiated`)
  }
  return { type, flags, serial, signature, body, ...fields } as DbusMessage
}

/** Cuts a byte stream into frames. Throws {@link DbusFramingError} when the stream cannot be resynchronised. */
export class DbusFramer {
  private pending = new Uint8Array(0)
  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.pending.length + chunk.length)
    joined.set(this.pending)
    joined.set(chunk, this.pending.length)
    const frames: Uint8Array[] = []
    let at = 0
    while (joined.length - at >= 16) {
      const little = frameEndianness(joined[at])
      const view = new DataView(joined.buffer, joined.byteOffset + at, 16)
      const bodyLength = view.getUint32(4, little)
      const fieldsLength = view.getUint32(12, little)
      if (bodyLength > MAX_ARRAY_BYTES || fieldsLength > MAX_ARRAY_BYTES) {
        throw new DbusFramingError(
          `frame declares body ${bodyLength} / header fields ${fieldsLength} bytes, over 64 MiB`,
        )
      }
      const total = Math.ceil((16 + fieldsLength) / 8) * 8 + bodyLength
      if (total > MAX_MESSAGE_BYTES) throw new DbusFramingError(`frame declares ${total} bytes, over 128 MiB`)
      if (joined.length - at < total) break
      frames.push(joined.slice(at, at + total))
      at += total
    }
    this.pending = joined.slice(at)
    return frames
  }
}

export interface FrameHandlers {
  message(message: DbusMessage, frame: Uint8Array): void
  unparsed(reason: string, frame: Uint8Array): void
}

/** Feeds one chunk through the framer; an undecodable frame goes to `unparsed` and the rest keep flowing. */
export function drainFrames(framer: DbusFramer, chunk: Uint8Array, handlers: FrameHandlers): void {
  for (const frame of framer.push(chunk)) {
    let message: DbusMessage
    try {
      message = decodeMessage(frame)
    } catch (error) {
      handlers.unparsed(error instanceof Error ? error.message : String(error), frame)
      continue
    }
    handlers.message(message, frame)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Connection

export class DbusCallError extends Error {
  constructor(
    readonly errorName: string,
    detail: string,
  ) {
    super(`${errorName}: ${detail}`)
  }
}

interface ConnectionHandlers extends FrameHandlers {
  /** Framing loss or socket loss after authentication. The connection is already destroyed. */
  fatal(reason: string): void
}

class DbusConnection {
  private serial = 0
  private readonly waiting = new Map<number, { resolve(m: DbusMessage): void; reject(e: Error): void }>()
  private closing = false
  private constructor(
    private readonly socket: Socket,
    private readonly handlers: ConnectionHandlers,
  ) {}

  static async open(address: BusSocketAddress, handlers: ConnectionHandlers): Promise<DbusConnection> {
    const path = address.kind === "abstract" ? `\0${address.name}` : address.name
    const socket = connect({ path })
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", (error) => reject(new Error(`D-Bus socket ${address.name}: ${error.message}`)))
    })
    const leftover = await authenticate(socket)
    const connection = new DbusConnection(socket, handlers)
    connection.listen(leftover)
    return connection
  }

  private listen(leftover: Uint8Array): void {
    const framer = new DbusFramer()
    const handlers: FrameHandlers = {
      message: (message, frame) => {
        const waiter =
          message.replySerial !== undefined &&
          (message.type === MessageType.methodReturn || message.type === MessageType.error)
            ? this.waiting.get(message.replySerial)
            : undefined
        if (waiter && message.replySerial !== undefined) {
          this.waiting.delete(message.replySerial)
          if (message.type === MessageType.error) {
            waiter.reject(new DbusCallError(message.errorName ?? "(no error name)", String(message.body[0] ?? "")))
          } else waiter.resolve(message)
          return
        }
        this.handlers.message(message, frame)
      },
      unparsed: (reason, frame) => this.handlers.unparsed(reason, frame),
    }
    const feed = (chunk: Uint8Array): void => {
      try {
        drainFrames(framer, chunk, handlers)
      } catch (error) {
        this.fail(`framing lost: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.socket.on("data", feed)
    this.socket.on("error", (error) => this.fail(`socket error: ${error.message}`))
    this.socket.on("close", () => this.fail("bus connection closed"))
    if (leftover.length > 0) feed(leftover)
  }

  private fail(reason: string): void {
    if (this.closing) return
    this.closing = true
    this.socket.destroy()
    for (const waiter of this.waiting.values()) waiter.reject(new Error(reason))
    this.waiting.clear()
    this.handlers.fatal(reason)
  }

  send(message: OutgoingMessage): number {
    const serial = ++this.serial
    this.socket.write(encodeMessage(message, serial))
    return serial
  }

  call(message: OutgoingMessage): Promise<DbusMessage> {
    return new Promise((resolve, reject) => {
      const serial = this.send(message)
      const timer = setTimeout(() => {
        this.waiting.delete(serial)
        reject(new Error(`${message.interface}.${message.member} got no reply within ${CALL_TIMEOUT_MS}ms`))
      }, CALL_TIMEOUT_MS)
      this.waiting.set(serial, {
        resolve: (m) => (clearTimeout(timer), resolve(m)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
    })
  }

  async close(): Promise<void> {
    this.closing = true
    await new Promise<void>((resolve) => {
      this.socket.end(resolve)
    })
    this.socket.destroy()
  }
}

/** SASL EXTERNAL with the process uid; resolves with any bytes the bus sent after its OK line. */
async function authenticate(socket: Socket): Promise<Uint8Array> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("D-Bus EXTERNAL auth needs process.getuid(), absent on this platform")
  const hexUid = Buffer.from(String(uid), "ascii").toString("hex")
  socket.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${hexUid}\r\n`, "ascii")]))
  const reply = await new Promise<{ line: string; rest: Uint8Array }>((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf("\r\n")
      if (end < 0) {
        if (buffered.length > 512) finish(new Error("D-Bus auth reply exceeds 512 bytes without CRLF"))
        return
      }
      finish(undefined, { line: buffered.subarray(0, end).toString("ascii"), rest: buffered.subarray(end + 2) })
    }
    const onClose = (): void => finish(new Error("D-Bus bus closed the socket during auth"))
    const finish = (error?: Error, value?: { line: string; rest: Uint8Array }): void => {
      socket.off("data", onData)
      socket.off("close", onClose)
      if (error) reject(error)
      else if (value !== undefined) resolve(value)
      else reject(new Error("D-Bus auth completed without a reply"))
    }
    socket.on("data", onData)
    socket.on("close", onClose)
  })
  if (!reply.line.startsWith("OK ")) {
    socket.destroy()
    throw new Error(`D-Bus EXTERNAL auth for uid ${uid} refused: ${JSON.stringify(reply.line)}`)
  }
  socket.write("BEGIN\r\n")
  return reply.rest
}

// ---------------------------------------------------------------------------------------------------------------
// Record entries

interface Stamped {
  readonly monotonicMs: number
  readonly wallTime: string
}
export interface NotifyEntry extends Stamped {
  readonly kind: "notify"
  readonly sender: string
  readonly appName: string
  readonly replacesId: number
  readonly appIcon: string
  readonly summary: string
  readonly body: string
  readonly actions: readonly string[]
  readonly hintKeys: readonly string[]
  readonly expireTimeout: number
  readonly id: number
}
export interface CallEntry extends Stamped {
  readonly kind: "call"
  readonly sender: string
  readonly interface: string | null
  readonly member: string
  /** `return` for a method return, otherwise the D-Bus error name the recorder replied with. */
  readonly reply: string
}
export interface UnparsedEntry extends Stamped {
  readonly kind: "unparsed"
  readonly reason: string
  readonly rawHex: string
  readonly length: number
}
export interface IgnoredEntry extends Stamped {
  readonly kind: "ignored"
  readonly messageType: number
  readonly sender: string | null
  readonly interface: string | null
  readonly member: string | null
}
export interface FatalEntry extends Stamped {
  readonly kind: "fatal"
  readonly reason: string
}
export type NotifyRecordEntry = NotifyEntry | CallEntry | UnparsedEntry | IgnoredEntry | FatalEntry

export interface NotifyRecorderReceipt {
  readonly schema: typeof NOTIFY_RECEIPT_SCHEMA
  readonly address: string
  readonly pid: number
  readonly uniqueName: string
  readonly owned: true
  readonly name: typeof NOTIFICATIONS_NAME
  readonly recordPath: string
  readonly startedAt: string
}

/**
 * `monotonicMs` is the recorder's own monotonic clock (ms since it started; Bun's clocks are process-relative) and
 * orders entries within one record only. A reader orders against its own writes by record offset, never by this value.
 */
function stamp(): Stamped {
  return { monotonicMs: Math.round(performance.now() * 1000) / 1000, wallTime: new Date().toISOString() }
}

/** Bounded hex of an undecodable frame for the record. */
export function unparsedEntry(reason: string, frame: Uint8Array): UnparsedEntry {
  return {
    kind: "unparsed",
    reason,
    rawHex: Buffer.from(frame.subarray(0, RAW_HEX_LIMIT)).toString("hex"),
    length: frame.length,
    ...stamp(),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Recorder

export class NotifyNameRefusedError extends Error {}

const REQUEST_NAME_REPLIES: Record<number, string> = {
  1: "PRIMARY_OWNER",
  2: "IN_QUEUE",
  3: "EXISTS",
  4: "ALREADY_OWNER",
}
const DBUS_DESTINATION = { destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus" }

export interface NotifyRecorderOptions {
  readonly address: string
  readonly recordPath: string
  readonly receiptPath: string
}

export interface NotifyRecorder {
  readonly uniqueName: string
  /** Resolves on {@link stop}; rejects with the fatal reason (already recorded) when the bus stream breaks. */
  readonly finished: Promise<void>
  stop(): Promise<void>
}

export async function startNotifyRecorder(options: NotifyRecorderOptions): Promise<NotifyRecorder> {
  const busAddress = parseBusAddress(options.address)
  const record = (entry: NotifyRecordEntry): void => appendFileSync(options.recordPath, `${JSON.stringify(entry)}\n`)
  let settle!: { resolve(): void; reject(error: Error): void }
  const finished = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject }
  })
  let serving = false
  let nextId = 1

  const reply = (call: DbusMessage, signature: string, body: unknown[]): void => {
    if ((call.flags & NO_REPLY_EXPECTED) !== 0 || call.sender === undefined) return
    connection.send({
      type: MessageType.methodReturn,
      replySerial: call.serial,
      destination: call.sender,
      signature,
      body,
    })
  }
  const replyError = (call: DbusMessage, errorName: string, detail: string): void => {
    if ((call.flags & NO_REPLY_EXPECTED) !== 0 || call.sender === undefined) return
    connection.send({
      type: MessageType.error,
      replySerial: call.serial,
      destination: call.sender,
      errorName,
      signature: "s",
      body: [detail],
    })
  }
  const callEntry = (call: DbusMessage, replyName: string): CallEntry => ({
    kind: "call",
    sender: call.sender ?? "",
    interface: call.interface ?? null,
    member: call.member ?? "",
    reply: replyName,
    ...stamp(),
  })

  const serve = (call: DbusMessage, frame: Uint8Array): void => {
    const known = call.interface === undefined || call.interface === NOTIFICATIONS_NAME
    if (call.path !== NOTIFICATIONS_PATH || !known) {
      const name = "org.freedesktop.DBus.Error.UnknownMethod"
      record(callEntry(call, name))
      return replyError(call, name, `No method ${call.interface ?? "(none)"}.${call.member} on ${call.path}`)
    }
    switch (call.member) {
      case "Notify": {
        if (call.signature !== NOTIFY_SIGNATURE) {
          const reason = `Notify signature ${JSON.stringify(call.signature)} is not ${JSON.stringify(NOTIFY_SIGNATURE)}`
          record(unparsedEntry(reason, frame))
          return replyError(call, "org.freedesktop.DBus.Error.InvalidArgs", reason)
        }
        const [appName, replacesId, appIcon, summary, body, actions, hints, expireTimeout] = call.body as [
          string,
          number,
          string,
          string,
          string,
          string[],
          [string, DbusVariant][],
          number,
        ]
        // Freedesktop semantics: a non-zero replaces_id is answered with that same id.
        const id = replacesId !== 0 ? replacesId : nextId++
        record({
          kind: "notify",
          sender: call.sender ?? "",
          appName,
          replacesId,
          appIcon,
          summary,
          body,
          actions,
          hintKeys: hints.map(([key]) => key),
          expireTimeout,
          id,
          ...stamp(),
        })
        return reply(call, "u", [id])
      }
      case "GetCapabilities":
        record(callEntry(call, "return"))
        return reply(call, "as", [["body"]])
      case "GetServerInformation":
        record(callEntry(call, "return"))
        return reply(call, "ssss", [...SERVER_INFORMATION])
      case "CloseNotification":
        record(callEntry(call, "return"))
        return reply(call, "", [])
      default: {
        const name = "org.freedesktop.DBus.Error.UnknownMethod"
        record(callEntry(call, name))
        return replyError(call, name, `No method ${NOTIFICATIONS_NAME}.${call.member}`)
      }
    }
  }

  const fatal = (reason: string): void => {
    record({ kind: "fatal", reason, ...stamp() })
    settle.reject(new Error(`notify recorder lost the bus: ${reason}`))
  }
  const connection = await DbusConnection.open(busAddress, {
    message(message, frame) {
      if (serving && message.type === MessageType.methodCall) return serve(message, frame)
      const fromBus = message.sender === "org.freedesktop.DBus" && message.type === MessageType.signal
      if (fromBus && message.member === "NameLost" && message.body[0] === NOTIFICATIONS_NAME) {
        return fatal(`bus reports NameLost for ${NOTIFICATIONS_NAME}`)
      }
      if (fromBus && message.member === "NameAcquired") return
      if (!serving) {
        // The record belongs to the name owner: before the name is held nothing is written there, so say it on stderr.
        console.error(
          `notify recorder: before owning ${NOTIFICATIONS_NAME}, ignored message type ${message.type} ` +
            `${message.interface ?? "(none)"}.${message.member ?? "(none)"} from ${message.sender ?? "(none)"}`,
        )
        if (message.type === MessageType.methodCall) {
          replyError(message, "org.freedesktop.DBus.Error.UnknownMethod", `${NOTIFICATIONS_NAME} is not held yet`)
        }
        return
      }
      record({
        kind: "ignored",
        messageType: message.type,
        sender: message.sender ?? null,
        interface: message.interface ?? null,
        member: message.member ?? null,
        ...stamp(),
      })
    },
    unparsed(reason, frame) {
      if (serving) record(unparsedEntry(reason, frame))
      else {
        console.error(
          `notify recorder: before owning ${NOTIFICATIONS_NAME}, unparsed ${frame.length}-byte message: ${reason}`,
        )
      }
    },
    fatal(reason) {
      if (serving) fatal(reason)
      else console.error(`notify recorder: lost the bus before owning ${NOTIFICATIONS_NAME}: ${reason}`)
    },
  })
  finished.catch(() => undefined)

  try {
    const hello = await connection.call({
      type: MessageType.methodCall,
      ...DBUS_DESTINATION,
      interface: "org.freedesktop.DBus",
      member: "Hello",
      signature: "",
      body: [],
    })
    const uniqueName = String(hello.body[0])
    const requested = await connection.call({
      type: MessageType.methodCall,
      ...DBUS_DESTINATION,
      interface: "org.freedesktop.DBus",
      member: "RequestName",
      signature: "su",
      body: [NOTIFICATIONS_NAME, 4],
    })
    const code = Number(requested.body[0])
    if (code !== 1) {
      throw new NotifyNameRefusedError(
        `RequestName(${NOTIFICATIONS_NAME}, DO_NOT_QUEUE) replied ${code} (${REQUEST_NAME_REPLIES[code] ?? "unknown"}), ` +
          `not PRIMARY_OWNER(1); another owner holds the name on ${options.address}`,
      )
    }
    writeFileSync(options.recordPath, "", { flag: "a" })
    serving = true
    const receipt: NotifyRecorderReceipt = {
      schema: NOTIFY_RECEIPT_SCHEMA,
      address: options.address,
      pid: process.pid,
      uniqueName,
      owned: true,
      name: NOTIFICATIONS_NAME,
      recordPath: options.recordPath,
      startedAt: new Date().toISOString(),
    }
    const temporary = `${options.receiptPath}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    renameSync(temporary, options.receiptPath)
    const open = connection
    return {
      uniqueName,
      finished,
      async stop() {
        await open.close()
        settle.resolve()
      },
    }
  } catch (error) {
    await connection.close()
    throw error
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Record reader

const isString = (v: unknown): v is string => typeof v === "string"
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isNullableString = (v: unknown): v is string | null => v === null || isString(v)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)
const ENTRY_FIELDS: Record<NotifyRecordEntry["kind"], Record<string, (v: unknown) => boolean>> = {
  notify: {
    sender: isString,
    appName: isString,
    replacesId: isNumber,
    appIcon: isString,
    summary: isString,
    body: isString,
    actions: isStringArray,
    hintKeys: isStringArray,
    expireTimeout: isNumber,
    id: isNumber,
  },
  call: { sender: isString, interface: isNullableString, member: isString, reply: isString },
  unparsed: { reason: isString, rawHex: isString, length: isNumber },
  ignored: { messageType: isNumber, sender: isNullableString, interface: isNullableString, member: isNullableString },
  fatal: { reason: isString },
}

/** Parses recorder JSONL; a malformed or unterminated line is refused naming its source and line number. */
export function parseNotifyRecord(text: string, source: string): NotifyRecordEntry[] {
  if (text === "") return []
  if (!text.endsWith("\n")) throw new Error(`${source}: last line is not newline-terminated (torn or foreign write)`)
  return text
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      const where = `${source}:${index + 1}`
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`${where}: not JSON: ${line.slice(0, 120)}`)
      }
      if (typeof value !== "object" || value === null) throw new Error(`${where}: not an object`)
      const entry = value as Record<string, unknown>
      const fields = ENTRY_FIELDS[entry.kind as NotifyRecordEntry["kind"]]
      if (fields === undefined) throw new Error(`${where}: unknown kind ${JSON.stringify(entry.kind)}`)
      const checks = { monotonicMs: isNumber, wallTime: isString, ...fields }
      for (const [name, check] of Object.entries(checks)) {
        if (!check(entry[name])) throw new Error(`${where}: ${String(entry.kind)} field ${name} is missing or mistyped`)
      }
      return entry as unknown as NotifyRecordEntry
    })
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

const USAGE = "usage: bun linux-notify-recorder.ts --address <dbus-address> --record <path.jsonl> --receipt <path.json>"

function parseCliArgs(argv: readonly string[]): NotifyRecorderOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (
      flag === undefined ||
      !["--address", "--record", "--receipt"].includes(flag) ||
      value === undefined ||
      values.has(flag)
    ) {
      throw new Error(`unexpected argument ${JSON.stringify(flag)}\n${USAGE}`)
    }
    values.set(flag, value)
  }
  const get = (flag: string): string => {
    const value = values.get(flag)
    if (value === undefined || value === "") throw new Error(`missing ${flag}\n${USAGE}`)
    return value
  }
  return { address: get("--address"), recordPath: get("--record"), receiptPath: get("--receipt") }
}

if (import.meta.main) {
  try {
    const recorder = await startNotifyRecorder(parseCliArgs(process.argv.slice(2)))
    const stop = (): void => {
      void recorder.stop().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(`notify recorder: stop failed: ${error instanceof Error ? error.message : String(error)}`)
          process.exit(1)
        },
      )
    }
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
    await recorder.finished
  } catch (error) {
    console.error(`notify recorder: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
