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

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`)
  return value as Record<string, unknown>
}
const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`)
  return value
}

/** Official api.proto framing over the literal Unix socket; no SDK or logical JXA fallback. */
export async function readITermCells(options: {
  tty: string
  cols: number
  rows: number
  /** Original server frames, before decoding; never authentication headers or cookie output. */
  onReply?: (bytes: Uint8Array) => void
}): Promise<TerminalTextRead> {
  let socket: WebSocketType | undefined
  const deadline = Date.now() + 5000
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
          .replaceAll(cookie, "[redacted]")
          .replaceAll(key, "[redacted]")
        finish(new Error(`API Unix WebSocket connection failed: ${detail}`, { cause }))
      }
      ws.onclose = () => finish(new Error("API Unix WebSocket closed before opening"))
    })
    let nextId = 0
    const rpc = (
      request: string,
      body: Record<string, unknown>,
      response: string,
    ): Promise<Record<string, unknown>> => {
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
            const reply = server.toObject(server.decode(bytes), { defaults: true, longs: String })
            // Notifications have no matching request ID and are retained, but are not this RPC's result.
            if (String(reply.id) !== String(id)) return
            const result = object(reply[response], response)
            if (result.status !== undefined && result.status !== 0) {
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
    const tty = async (session: string) => {
      const response = await rpc("variable_request", { session_id: session, get: ["tty"] }, "variable_response")
      const values = array(response.values, "TTY variable values")
      if (values.length !== 1 || typeof values[0] !== "string") {
        throw new Error("TTY variable did not return one JSON value")
      }
      return JSON.parse(values[0]) as unknown
    }
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
    const session = String(match.unique_identifier)
    const checkGrid = (value: unknown) => {
      const size = object(value, "session grid")
      if (size.width !== options.cols || size.height !== options.rows) {
        throw new Error("API session grid differs from measured grid")
      }
    }
    checkGrid(match.grid_size)
    const buffer = await rpc(
      "get_buffer_request",
      { session, line_range: { screen_contents_only: true }, include_styles: true },
      "get_buffer_response",
    )
    if ((await tty(session)) !== options.tty) throw new Error("API session changed its TTY during the physical read")
    const grid = await rpc("get_property_request", { session_id: session, name: "grid_size" }, "get_property_response")
    if (typeof grid.json_value !== "string") throw new Error("API grid property is not JSON")
    checkGrid(JSON.parse(grid.json_value))
    // The official decoder supplies proto2 defaults and repeated arrays from the pinned schema.
    const contents = array(buffer.contents, "get_buffer_response.contents") as ITermLineContents[]
    const cells = mapITermBufferToCells(contents, options.cols, options.rows)
    return typeof cells === "string" ? { status: "refused", reason: cells } : { status: "read", app: "iterm2", cells }
  } catch (cause) {
    return {
      status: "refused",
      reason: `iTerm2 physical read: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  } finally {
    socket?.close()
  }
}
