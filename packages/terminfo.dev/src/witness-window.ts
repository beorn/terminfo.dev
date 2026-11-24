/**
 * Read-only witness window B responder & client for Terminal.app window-scoped ownership (#34080 Slice 2, @cto d43c34cc).
 *
 * Security & isolation invariants:
 * - Binds strictly to 127.0.0.1 (loopback only) on an ephemeral port.
 * - Bound to one launch run id (`TERMINFO_RUN_ID`) with a 256-bit per-launch bearer token checked via timingSafeEqual.
 * - Answers ONLY read-only DECRQM (dec-mode, ansi-mode) and OSC color queries (palette, foreground, background,
 *   cursor-colour, highlight-background, highlight-foreground) via attribute-ledger's `readbackFor`.
 * - Has NO write path and rejects every other attribute, route, or method loudly.
 * - Exits cleanly on `POST /stop` or SIGHUP/SIGTERM/SIGINT when witness window B closes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { writeFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { attributeKey, readbackFor, type LedgerAttribute } from "./probes/attribute-ledger.ts"
import { queryWithSentinelOutcome, withRawMode, withTTYOperation } from "./tty.ts"
import { tty } from "./owned-process.ts"

const RUN_ID_PATTERN = /^[0-9a-f]{32}$/
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

export type WitnessAllowedAttribute = Extract<
  LedgerAttribute,
  | { kind: "dec-mode" }
  | { kind: "ansi-mode" }
  | { kind: "palette" }
  | { kind: "foreground" }
  | { kind: "background" }
  | { kind: "cursor-colour" }
  | { kind: "highlight-background" }
  | { kind: "highlight-foreground" }
>

export interface WitnessRegistration {
  readonly runId: string
  readonly pid: number
  readonly port: number
  readonly token: string
  readonly tty: string
}

export interface WitnessEndpoint {
  readonly runId: string
  readonly port: number
  readonly token: string
}

const exactKeys = (object: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key))

/** Only DECRQM (dec/ansi mode) and OSC color queries (4/10/11/12/17/19) are permitted on the witness window. */
export function isAllowedWitnessAttribute(value: unknown): value is WitnessAllowedAttribute {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const object = value as Record<string, unknown>
  switch (object.kind) {
    case "dec-mode":
    case "ansi-mode":
      return (
        exactKeys(object, ["kind", "mode"]) &&
        typeof object.mode === "number" &&
        Number.isSafeInteger(object.mode) &&
        object.mode >= 1 &&
        object.mode <= 99_999
      )
    case "palette":
      return (
        exactKeys(object, ["kind", "index"]) &&
        typeof object.index === "number" &&
        Number.isSafeInteger(object.index) &&
        object.index >= 0 &&
        object.index <= 255
      )
    case "foreground":
    case "background":
    case "cursor-colour":
    case "highlight-background":
    case "highlight-foreground":
      return exactKeys(object, ["kind"])
    default:
      return false
  }
}

export function parseWitnessRegistration(raw: string): WitnessRegistration {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error("Invalid witness registration JSON", { cause: error })
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid witness registration: expected object")
  }
  const obj = parsed as Record<string, unknown>
  if (
    !exactKeys(obj, ["runId", "pid", "port", "token", "tty"]) ||
    typeof obj.runId !== "string" ||
    !RUN_ID_PATTERN.test(obj.runId) ||
    typeof obj.pid !== "number" ||
    !Number.isSafeInteger(obj.pid) ||
    obj.pid < 1 ||
    typeof obj.port !== "number" ||
    !Number.isSafeInteger(obj.port) ||
    obj.port < 1 ||
    obj.port > 65535 ||
    typeof obj.token !== "string" ||
    !TOKEN_PATTERN.test(obj.token) ||
    typeof obj.tty !== "string"
  ) {
    throw new Error("Invalid witness registration fields")
  }
  return {
    runId: obj.runId,
    pid: obj.pid,
    port: obj.port,
    token: obj.token,
    tty: tty(obj.tty),
  }
}

function bearerMatches(header: string | undefined, expectedToken: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false
  const supplied = header.slice("Bearer ".length)
  const a = Buffer.from(supplied, "utf8")
  const b = Buffer.from(expectedToken, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}

function readRequestBody(req: IncomingMessage, maxBytes = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on("data", (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error("Witness request body exceeds limit"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

export type WitnessQueryReader = (attribute: WitnessAllowedAttribute) => Promise<string | null>

/** Default live TTY reader for witness window B: strictly readback queries, never a state-mutating write. */
export const defaultWitnessQueryReader: WitnessQueryReader = async (attribute) => {
  const readback = readbackFor(attribute)
  if ("unprovable" in readback) return null
  const outcome = await withTTYOperation(() =>
    withRawMode(() => queryWithSentinelOutcome(readback.query, readback.pattern)),
  )
  return outcome.reason === "reply" ? readback.read(outcome.raw) : null
}

export interface StartWitnessOptions {
  readonly runId: string
  readonly registrationPath?: string
  readonly ttyPath?: string
  readonly reader?: WitnessQueryReader
  readonly registerSignals?: boolean
}

export interface RunningWitnessResponder {
  readonly registration: WitnessRegistration
  readonly closed: Promise<void>
  readonly close: () => Promise<void>
}

/**
 * Start the loopback-only read-only witness responder inside witness window B.
 * Requires `TERMINFO_RUN_ID` to match `options.runId` unless a custom test reader is injected.
 */
export async function startWitnessResponder(options: StartWitnessOptions): Promise<RunningWitnessResponder> {
  if (!RUN_ID_PATTERN.test(options.runId)) {
    throw new Error(`Witness responder requires a 32-hex run id, received ${JSON.stringify(options.runId)}`)
  }
  if (options.reader === undefined && process.env.TERMINFO_RUN_ID !== options.runId) {
    throw new Error("Witness responder TERMINFO_RUN_ID does not match requested --run-id")
  }
  if (options.registrationPath !== undefined && !isAbsolute(options.registrationPath)) {
    throw new Error(`Witness registration path must be absolute: ${JSON.stringify(options.registrationPath)}`)
  }
  const token = randomBytes(32).toString("hex")
  const reader = options.reader ?? defaultWitnessQueryReader

  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  let closing = false
  let serverClosePromise: Promise<void> | undefined
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method not allowed" })
        return
      }
      if (!bearerMatches(req.headers.authorization, token)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized witness token" })
        return
      }
      if (req.headers["x-terminfo-run-id"] !== options.runId) {
        sendJson(res, 403, { ok: false, error: "Witness run id mismatch" })
        return
      }
      const url = req.url ?? ""
      if (url === "/stop") {
        sendJson(res, 200, { ok: true, stopping: true })
        void close()
        return
      }
      if (url !== "/read") {
        sendJson(res, 404, { ok: false, error: "Unknown witness route; only /read and /stop exist" })
        return
      }
      let body: unknown
      try {
        body = JSON.parse(await readRequestBody(req))
      } catch {
        sendJson(res, 400, { ok: false, error: "Invalid JSON body" })
        return
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        !exactKeys(body as Record<string, unknown>, ["attribute"])
      ) {
        sendJson(res, 400, { ok: false, error: "Expected exact body { attribute }" })
        return
      }
      const attribute = (body as { attribute: unknown }).attribute
      if (!isAllowedWitnessAttribute(attribute)) {
        sendJson(res, 400, {
          ok: false,
          error: "Witness responder only answers DECRQM and OSC color queries; no write path exists",
        })
        return
      }
      const value = await reader(attribute)
      sendJson(res, 200, { ok: true, key: attributeKey(attribute), value })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res)
  })

  const signalHandlers: Array<[NodeJS.Signals, () => void]> = []
  const close = (): Promise<void> => {
    if (serverClosePromise) return serverClosePromise
    closing = true
    for (const [sig, handler] of signalHandlers) process.off(sig, handler)
    serverClosePromise = new Promise<void>((resolve) => {
      server.close(() => {
        resolveClosed()
        resolve()
      })
    })
    return serverClosePromise
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    await close()
    throw new Error("Witness responder did not bind an IPv4 loopback port")
  }
  const ttyPath = tty(options.ttyPath ?? "/dev/tty")
  const registration: WitnessRegistration = {
    runId: options.runId,
    pid: process.pid,
    port: address.port,
    token,
    tty: ttyPath,
  }
  if (options.registrationPath !== undefined) {
    writeFileSync(options.registrationPath, `${JSON.stringify(registration)}\n`, { flag: "wx", mode: 0o600 })
  }
  if (options.registerSignals !== false) {
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      const handler = () => {
        if (!closing) void close()
      }
      signalHandlers.push([sig, handler])
      process.on(sig, handler)
    }
  }
  return { registration, closed, close }
}

/** Client used by window A's worker to read witness window B before and after each admitted window cell. */
export function createWitnessClient(options: {
  readonly app: string
  readonly endpoint: WitnessEndpoint
  /** Re-proves BOTH window A and witness window B ownership around every read. */
  readonly check: () => void
  readonly timeoutMs?: number
}): { readonly app: string; readonly read: (attribute: LedgerAttribute) => Promise<string | undefined> } {
  const timeoutMs = options.timeoutMs ?? 5_000
  return {
    app: options.app,
    read: async (attribute) => {
      if (!isAllowedWitnessAttribute(attribute)) return undefined
      options.check()
      const res = await fetch(`http://127.0.0.1:${options.endpoint.port}/read`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.endpoint.token}`,
          "x-terminfo-run-id": options.endpoint.runId,
        },
        body: JSON.stringify({ attribute }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      options.check()
      if (!res.ok) {
        throw new Error(`Witness window read failed (${res.status}): ${await res.text()}`)
      }
      const parsed = (await res.json()) as { ok?: unknown; value?: unknown }
      if (parsed.ok !== true) throw new Error(`Witness window read returned non-ok payload: ${JSON.stringify(parsed)}`)
      return typeof parsed.value === "string" ? parsed.value : undefined
    },
  }
}

/** Ask witness window B's loopback responder to exit cleanly. */
export async function stopWitnessResponder(endpoint: WitnessEndpoint, timeoutMs = 5_000): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${endpoint.port}/stop`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      "x-terminfo-run-id": endpoint.runId,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`Witness window stop failed (${res.status}): ${await res.text()}`)
  }
}
