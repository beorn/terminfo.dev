import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { connect } from "node:net"
import protobuf from "protobufjs"
import type WebSocketType from "ws"
import { mapITermBufferToCells, type ITermLineContents, type TerminalTextRead } from "./darwin-terminal-text.ts"

/** The existing CLI builder embeds the exact vendored bytes; source execution reads that file. */
declare const __TERMINFO_ITERM_PROTO__: string | undefined

const LIBRARY_VERSION = "terminfo.dev 1"

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`)
  return value as Record<string, unknown>
}
const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`)
  return value
}

type Rpc = (
  request: string,
  body: Record<string, unknown>,
  response: string,
  options?: RpcOptions,
) => Promise<Record<string, unknown>>
interface RpcOptions {
  /**
   * Nonzero statuses this caller decides itself; any other nonzero status still throws. A status the
   * caller accepts is returned in `result.status`, never folded into a generic refusal (34570).
   */
  acceptStatus?: readonly number[]
  /**
   * Decode without proto2 defaults, so an absent optional field stays absent instead of reading as its
   * default (an absent prompt_state is not EDITING). An absent `status` then means its declared default OK.
   */
  presence?: boolean
}

/** One authenticated API connection bound to the single session whose TTY is the measured owner's. */
interface ITermApiSession {
  rpc: Rpc
  /** The matched session's unique identifier. */
  session: string
  /** The list_sessions record of the matched session. */
  match: Record<string, unknown>
  /** One session variable, decoded from its JSON value. */
  variable: (session: string, name: string) => Promise<unknown>
}

/**
 * Authenticate, open the literal Unix socket, and resolve exactly one session by the owned TTY, then run
 * `work` on that session and close the socket. Extracted from readITermCells unchanged (34570), so the
 * cell read and the prompt-mark read share one auth path, one socket owner and one session resolver.
 */
async function withITermApiSession<T>(
  options: { tty: string; onReply?: (bytes: Uint8Array) => void; deadlineMs: number },
  work: (api: ITermApiSession) => Promise<T>,
): Promise<T> {
  let socket: WebSocketType | undefined
  const deadline = Date.now() + options.deadlineMs
  const remaining = () => {
    const time = deadline - Date.now()
    if (time <= 0) throw new Error("API read deadline exceeded")
    return time
  }
  try {
    // Bun aliases bare `ws` imports to its builtin. Resolve the installed package's exported
    // ESM entry instead, so the declared/locked ws artifact is the client we actually execute.
    const packageUrl = import.meta.resolve("ws/package.json")
    const packageJson = JSON.parse(readFileSync(new URL(packageUrl), "utf8")) as {
      exports: { ".": { import: string } }
    }
    const { default: WebSocket } = (await import(new URL(packageJson.exports["."].import, packageUrl).href)) as {
      default: typeof WebSocketType
    }
    // Lazy load: another terminal arm does not depend on iTerm's protocol resource being present.
    // The build retains these exact official bytes inside the bundle; parser failure has no fallback.
    const proto =
      typeof __TERMINFO_ITERM_PROTO__ === "undefined"
        ? readFileSync(new URL("./iterm2-api.proto", import.meta.url), "utf8")
        : __TERMINFO_ITERM_PROTO__
    const root = protobuf.parse(proto, {
      keepCase: true,
    }).root
    const client = root.lookupType("iterm2.ClientOriginatedMessage")
    const server = root.lookupType("iterm2.ServerOriginatedMessage")
    const auth = spawnSync(
      "/usr/bin/osascript",
      [
        "-e",
        `
if not (application "iTerm2" is running) then error "iTerm2 is not running"
tell application "iTerm2"
  if not frontmost then error "iTerm2 is not frontmost"
  return request cookie and key for app named "terminfo.dev"
end tell`,
      ],
      { encoding: "utf8", timeout: remaining(), killSignal: "SIGKILL" },
    )
    if (auth.error || auth.status !== 0 || auth.signal) {
      throw new Error(
        `cookie request failed (${auth.error?.message || auth.stderr.trim().slice(0, 300) || auth.signal || auth.status}); no auth UI retry`,
      )
    }
    const credentials = auth.stdout.trim().split(" ")
    if (credentials.length !== 2 || credentials.some((value) => !value || /\s/u.test(value))) {
      throw new Error("cookie request did not return a cookie and key")
    }
    const [cookie, key] = credentials
    if (!cookie || !key) throw new Error("cookie or key is absent")
    const path = join(homedir(), "Library/Application Support/iTerm2/private/socket")
    const ws = new WebSocket("ws://localhost/", ["api.iterm2.com"], {
      createConnection: () => connect(path),
      headers: {
        origin: "ws://localhost/",
        "x-iterm2-cookie": cookie,
        "x-iterm2-key": key,
        "x-iterm2-disable-auth-ui": "true",
        "x-iterm2-advisory-name": "terminfo.dev",
        "x-iterm2-library-version": LIBRARY_VERSION,
      },
    })
    socket = ws
    ws.binaryType = "arraybuffer"
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("API socket open deadline exceeded")), remaining())
      const finish = (error?: Error) => {
        clearTimeout(timer)
        ws.onopen = null
        ws.onerror = null
        ws.onclose = null
        if (error) reject(error)
        else resolve()
      }
      ws.onopen = () => finish()
      ws.onerror = (event) => {
        const cause = event.error instanceof Error ? event.error : undefined
        const code = cause && "code" in cause && typeof cause.code === "string" ? cause.code : ""
        const message = cause?.message || event.message || "underlying WebSocket error unavailable"
        const detail = [code, message]
          .filter(Boolean)
          .join(": ")
          .replaceAll(homedir(), "~")
          .replaceAll(cookie, "[redacted]")
          .replaceAll(key, "[redacted]")
        finish(
          new Error(
            `API Unix WebSocket connection failed: ${detail}; sent x-iterm2-library-version ${JSON.stringify(LIBRARY_VERSION)}`,
            { cause },
          ),
        )
      }
      ws.onclose = () => finish(new Error("API Unix WebSocket closed before opening"))
    })
    let nextId = 0
    const rpc: Rpc = (request, body, response, rpcOptions = {}) => {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`${response} deadline exceeded`)), remaining())
        const finish = (error?: Error, result?: Record<string, unknown>) => {
          clearTimeout(timer)
          ws.onmessage = null
          ws.onerror = null
          ws.onclose = null
          if (error) reject(error)
          else if (result) resolve(result)
          else reject(new Error(`${response} returned no result`))
        }
        ws.onerror = () => finish(new Error(`${response} socket failed`))
        ws.onclose = () => finish(new Error(`${response} socket closed`))
        ws.onmessage = (event) => {
          try {
            if (!(event.data instanceof ArrayBuffer)) throw new Error("API returned a nonbinary message")
            const bytes = new Uint8Array(event.data)
            options.onReply?.(bytes)
            const reply = server.toObject(
              server.decode(bytes),
              rpcOptions.presence ? { longs: String } : { defaults: true, longs: String },
            )
            // Notifications have no matching request ID and are retained, but are not this RPC's result.
            if (String(reply.id) !== String(id)) return
            const result = object(reply[response], response)
            if (
              result.status !== undefined &&
              result.status !== 0 &&
              !rpcOptions.acceptStatus?.includes(Number(result.status))
            ) {
              throw new Error(`${response} status ${String(result.status)}`)
            }
            finish(undefined, result)
          } catch (cause) {
            finish(cause instanceof Error ? cause : new Error(String(cause)))
          }
        }
        if (ws.readyState !== WebSocket.OPEN) {
          finish(new Error(`${response} socket is not open`))
          return
        }
        ws.send(client.encode(client.fromObject({ id, [request]: body })).finish())
      })
    }
    const list = await rpc("list_sessions_request", {}, "list_sessions_response")
    const sessions: Record<string, unknown>[] = []
    const walk = (value: unknown) => {
      const node = object(value, "split tree")
      for (const value of array(node.links, "split links")) {
        const link = object(value, "split link")
        if (link.session) sessions.push(object(link.session, "session"))
        else if (link.node) walk(link.node)
      }
    }
    for (const value of array(list.windows, "windows")) {
      const window = object(value, "window")
      for (const value of array(window.tabs, "tabs")) walk(object(value, "tab").root)
    }
    const variable = async (session: string, name: string) => {
      const response = await rpc("variable_request", { session_id: session, get: [name] }, "variable_response")
      const values = array(response.values, `${name === "tty" ? "TTY" : name} variable values`)
      if (values.length !== 1 || typeof values[0] !== "string") {
        throw new Error(`${name === "tty" ? "TTY" : name} variable did not return one JSON value: got ${values.length}`)
      }
      return JSON.parse(values[0]) as unknown
    }
    const tty = (session: string) => variable(session, "tty")
    const matches: Record<string, unknown>[] = []
    for (const session of sessions) {
      if (typeof session.unique_identifier !== "string" || !session.unique_identifier) {
        throw new Error("Session ID absent")
      }
      if ((await tty(session.unique_identifier)) === options.tty) matches.push(session)
    }
    if (matches.length !== 1) throw new Error(`owned TTY ${options.tty} matches ${matches.length} API sessions`)
    const match = matches[0]
    if (!match) throw new Error("The matched TTY session is absent")
    return await work({ rpc, session: String(match.unique_identifier), match, variable })
  } finally {
    socket?.close()
  }
}

/** Official api.proto framing over the literal Unix socket; no SDK or logical JXA fallback. */
export async function readITermCells(options: {
  tty: string
  cols: number
  rows: number
  /** Original server frames, before decoding; never authentication headers or cookie output. */
  onReply?: (bytes: Uint8Array) => void
}): Promise<TerminalTextRead> {
  try {
    return await withITermApiSession({ ...options, deadlineMs: 5000 }, async ({ rpc, session, match, variable }) => {
      const tty = (session: string) => variable(session, "tty")
      const checkGrid = (value: unknown, source: string) => {
        const size = object(value, "session grid")
        if (size.width !== options.cols || size.height !== options.rows) {
          throw new Error(
            `API session grid from ${source} is ${String(size.width)}x${String(size.height)}, measured grid is ${options.cols}x${options.rows}`,
          )
        }
      }
      checkGrid(match.grid_size, "list_sessions")
      const buffer = await rpc(
        "get_buffer_request",
        { session, line_range: { screen_contents_only: true }, include_styles: true },
        "get_buffer_response",
      )
      const reread = await tty(session)
      if (reread !== options.tty) {
        throw new Error(
          `API session TTY changed during the physical read: expected ${options.tty}, now ${String(reread)}`,
        )
      }
      const grid = await rpc(
        "get_property_request",
        { session_id: session, name: "grid_size" },
        "get_property_response",
      )
      if (typeof grid.json_value !== "string") {
        throw new Error(`API grid property is not JSON: got ${typeof grid.json_value}`)
      }
      // The `grid_size` property is zero-based inclusive: iTermAPIHelper.m getGridSize answers
      // session.screen.width - 1 and session.screen.height - 1 (v3.6.11), one less than the
      // list_sessions value checked above. Restore those extents here and keep the check exact, so a
      // session that really changed geometry still refuses.
      const property = object(JSON.parse(grid.json_value), "session grid property")
      checkGrid(
        { width: Number(property.width) + 1, height: Number(property.height) + 1 },
        `grid_size property ${String(property.width)}x${String(property.height)} plus 1`,
      )
      // The official decoder supplies proto2 defaults and repeated arrays from the pinned schema.
      const contents = array(buffer.contents, "get_buffer_response.contents") as ITermLineContents[]
      const cells = mapITermBufferToCells(contents, options.cols, options.rows)
      return typeof cells === "string" ? { status: "refused", reason: cells } : { status: "read", app: "iterm2", cells }
    })
  } catch (cause) {
    return {
      status: "refused",
      reason: `iTerm2 physical read: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}

/** One iTerm2 Coord as the API returns it; `y` is an int64 decoded as a decimal string. */
export interface ITermCoordRange {
  start: { x: number; y: string }
  end: { x: number; y: string }
}

/**
 * The fields of one GetPromptResponse exactly as present on the wire (34570). Every field is optional
 * because proto2 presence is kept: an absent prompt_state is absent, never the EDITING default, and an
 * absent unique_prompt_id is never synthesised (v3.6.11 prompt.py checks HasField for both).
 */
export interface ITermPromptMark {
  promptState?: "EDITING" | "RUNNING" | "FINISHED" | `unknown-${number}`
  uniquePromptId?: string
  promptRange?: ITermCoordRange
  commandRange?: ITermCoordRange
  outputRange?: ITermCoordRange
  exitStatus?: number
}

/**
 * A prompt read: the mark, or the API's own PROMPT_UNAVAILABLE (status 3), which v3.6.11 answers when the
 * session has no prompt mark at all. That is not proof shell integration is absent (@cto R4). The other
 * nonzero statuses, SESSION_NOT_FOUND (1) and REQUEST_MALFORMED (2), and every transport failure throw,
 * each under its own name.
 */
export type ITermPromptRead = { status: "mark"; mark: ITermPromptMark } | { status: "prompt-unavailable" }

/** The two reads a prompt-mark row needs on the owned session, over one authenticated socket. */
export interface ITermPromptSession {
  readPrompt: () => Promise<ITermPromptRead>
  /** A `user.<name>` session variable set by OSC 1337 SetUserVar; the write-order fence of each phase. */
  readUserVariable: (name: string) => Promise<unknown>
}

const PROMPT_STATES = ["EDITING", "RUNNING", "FINISHED"] as const
const PROMPT_STATUS_NAMES: Record<number, string> = { 1: "SESSION_NOT_FOUND", 2: "REQUEST_MALFORMED" }

function coordRange(value: unknown, label: string): ITermCoordRange {
  const range = object(value, label)
  const coord = (point: unknown, side: string) => {
    const c = object(point, `${label}.${side}`)
    if (!Number.isSafeInteger(c.x) || typeof c.y !== "string" || !/^-?\d+$/.test(c.y)) {
      throw new Error(`${label}.${side} is not an API coordinate`)
    }
    return { x: c.x as number, y: c.y }
  }
  return { start: coord(range.start, "start"), end: coord(range.end, "end") }
}

/** Map one decoded GetPromptResponse, keeping field presence. */
function iTermPromptReadOf(response: Record<string, unknown>): ITermPromptRead {
  const status = response.status === undefined ? 0 : Number(response.status)
  if (status === 3) return { status: "prompt-unavailable" }
  if (status !== 0) {
    throw new Error(`get_prompt_response ${PROMPT_STATUS_NAMES[status] ?? "unknown status"} (status ${String(status)})`)
  }
  const mark: ITermPromptMark = {}
  if (response.prompt_state !== undefined) {
    const state = Number(response.prompt_state)
    mark.promptState = PROMPT_STATES[state] ?? `unknown-${state}`
  }
  if (response.unique_prompt_id !== undefined) {
    if (typeof response.unique_prompt_id !== "string") {
      throw new Error("get_prompt_response unique_prompt_id is not text")
    }
    mark.uniquePromptId = response.unique_prompt_id
  }
  if (response.prompt_range !== undefined) mark.promptRange = coordRange(response.prompt_range, "prompt_range")
  if (response.command_range !== undefined) mark.commandRange = coordRange(response.command_range, "command_range")
  if (response.output_range !== undefined) mark.outputRange = coordRange(response.output_range, "output_range")
  if (response.exit_status !== undefined) {
    if (!Number.isSafeInteger(response.exit_status)) {
      throw new Error("get_prompt_response exit_status is not an integer")
    }
    mark.exitStatus = response.exit_status as number
  }
  return { status: "mark", mark }
}

/**
 * Run `work` against the owned session's prompt mark and user variables over one authenticated socket,
 * resolved by the same TTY match as readITermCells (34570, @cto R1). A prompt row takes several fenced
 * phases, so its deadline is the row's, not the single cell read's 5 s.
 */
export async function withITermPromptSession<T>(
  options: { tty: string; onReply?: (bytes: Uint8Array) => void; deadlineMs: number },
  work: (session: ITermPromptSession) => Promise<T>,
): Promise<T> {
  return withITermApiSession(options, async ({ rpc, session, variable }) => {
    const result = await work({
      readPrompt: async () =>
        iTermPromptReadOf(
          await rpc("get_prompt_request", { session }, "get_prompt_response", {
            presence: true,
            acceptStatus: [1, 2, 3],
          }),
        ),
      readUserVariable: (name) => {
        if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`user variable name ${JSON.stringify(name)} is not plain`)
        return variable(session, `user.${name}`)
      },
    })
    const reread = await variable(session, "tty")
    if (reread !== options.tty) {
      throw new Error(`API session TTY changed during the prompt read: expected ${options.tty}, now ${String(reread)}`)
    }
    return result
  })
}
