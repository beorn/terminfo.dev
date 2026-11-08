/**
 * @failure The iTerm reader decodes logical strings, reads a different TTY, or accepts a changed
 *   session binding; its actual binary framing and authentication headers must reach the socket.
 * @level l1
 * @consumer OwnedTerminal.readCells on the iTerm2 arm.
 * @testonly none
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import protobuf from "protobufjs"
import { afterEach, expect, test, vi } from "vitest"
import type WebSocketType from "ws"
import { readITermCells } from "./iterm2-protocol.ts"

const fixture = vi.hoisted(() => ({ home: "" }))
vi.mock("node:os", async () => ({
  ...(await vi.importActual<typeof import("node:os")>("node:os")),
  homedir: () => fixture.home,
}))
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "test-cookie test-key\n", stderr: "", signal: null })),
}))

const directories: string[] = []
afterEach(() => {
  // raw-delete-allow: only this suite's mkdtemp roots; standalone component has no removely dependency
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// Opening diagnostics must survive the existing refused-result boundary without leaking auth.
test.each([
  ["absent", "ENOENT"],
  ["refused", "ECONNREFUSED"],
  ["unauthorized", "401"],
  ["no-detail", "underlying WebSocket error unavailable"],
] as const)("physical read retains a safe opening failure: %s", async (mode, detail) => {
  fixture.home = mkdtempSync("/var/tmp/i-test-cookie-test-key-")
  directories.push(fixture.home)
  const socket = join(fixture.home, "Library/Application Support/iTerm2/private/socket")
  mkdirSync(join(socket, ".."), { recursive: true })
  if (mode === "refused") writeFileSync(socket, "not a listening socket")
  const server =
    mode === "unauthorized"
      ? Bun.serve({ unix: socket, fetch: () => new Response("denied", { status: 401 }) })
      : undefined
  const packageUrl = import.meta.resolve("ws/package.json")
  const metadata = JSON.parse(readFileSync(new URL(packageUrl), "utf8")) as { exports: { ".": { import: string } } }
  const actual = (await import(new URL(metadata.exports["."].import, packageUrl).href)) as typeof import("ws")
  const setOnError = Object.getOwnPropertyDescriptor(actual.default.prototype, "onerror")?.set
  if (!setOnError) throw new Error("The locked ws client has no onerror setter")
  // A WebSocket ErrorEvent may omit both details. Exercise the same real connection lifecycle.
  const noDetail =
    mode === "no-detail"
      ? vi.spyOn(actual.default.prototype, "onerror", "set").mockImplementation(function (
          this: WebSocketType,
          listener,
        ) {
          setOnError.call(
            this,
            listener ? () => listener({ message: "" } as Parameters<NonNullable<typeof listener>>[0]) : null,
          )
        })
      : undefined
  const replies = vi.fn()
  try {
    const result = await readITermCells({ tty: "/dev/ttys004", cols: 4, rows: 2, onReply: replies })
    expect(result).toEqual({ status: "refused", reason: expect.stringContaining(detail) })
    if (result.status !== "refused") throw new Error("Opening failure produced cells")
    expect(result.reason).not.toContain("test-cookie")
    expect(result.reason).not.toContain("test-key")
    expect(replies).not.toHaveBeenCalled()
  } finally {
    noDetail?.mockRestore()
    server?.stop(true)
  }
})

// This exercises the Unix WebSocket client against a local protocol fixture, never an iTerm process.
// The independent server reads the official schema and inspects the actual request fields.
const modes = ["match", "missing", "changed", "grid", "wide", "ws400"] as const
test.each(modes)("physical read requires an exact stable TTY: %s", async (mode) => {
  const cols = mode === "wide" ? 80 : 4
  const rows = mode === "wide" ? 25 : 2
  fixture.home = mkdtempSync("/var/tmp/i-")
  directories.push(fixture.home)
  const socket = join(fixture.home, "Library/Application Support/iTerm2/private/socket")
  mkdirSync(join(socket, ".."), { recursive: true })
  const root = protobuf.parse(readFileSync(new URL("./iterm2-api.proto", import.meta.url), "utf8"), {
    keepCase: true,
  }).root
  const client = root.lookupType("iterm2.ClientOriginatedMessage")
  const serverType = root.lookupType("iterm2.ServerOriginatedMessage")
  const requests: Record<string, unknown>[] = []
  const headers: string[] = []
  let ownReads = 0
  const server = Bun.serve({
    unix: socket,
    fetch(request, server) {
      headers.push(
        request.headers.get("x-iterm2-cookie") ?? "",
        request.headers.get("x-iterm2-key") ?? "",
        request.headers.get("x-iterm2-disable-auth-ui") ?? "",
        request.headers.get("sec-websocket-protocol") ?? "",
        request.headers.get("x-iterm2-library-version") ?? "",
      )
      // iTerm rejects a missing library header or a value without exactly two space-separated parts.
      const libraryVersion = request.headers.get("x-iterm2-library-version")
      if (mode === "ws400" || !libraryVersion || libraryVersion.split(" ").length !== 2) {
        return new Response("invalid library version", { status: 400 })
      }
      if (server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "api.iterm2.com" } })) return
      return new Response("upgrade failed", { status: 400 })
    },
    websocket: {
      message(ws, bytes) {
        if (typeof bytes === "string") throw new Error("Expected protobuf binary request")
        const request = client.toObject(client.decode(bytes), { longs: String })
        requests.push(request)
        let reply: Record<string, unknown>
        if (request.list_sessions_request) {
          reply = {
            list_sessions_response: {
              windows: [
                {
                  tabs: [
                    {
                      root: {
                        links: [
                          { session: { unique_identifier: "other", grid_size: { width: cols, height: rows } } },
                          {
                            node: {
                              links: [
                                { session: { unique_identifier: "owned", grid_size: { width: cols, height: rows } } },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          }
        } else if (request.variable_request) {
          const variable = request.variable_request
          expect(variable.get).toEqual(["tty"])
          const tty =
            variable.session_id === "owned" && mode !== "missing" && (mode !== "changed" || ownReads++ === 0)
              ? "/dev/ttys004"
              : "/dev/ttys999"
          reply = { variable_response: { status: 0, values: [JSON.stringify(tty)] } }
        } else if (request.get_property_request) {
          expect(request.get_property_request).toEqual({ session_id: "owned", name: "grid_size" })
          // iTermAPIHelper.m getGridSize answers screen.width - 1 and screen.height - 1 (zero-based
          // inclusive), so this property is one extents smaller than list_sessions — 80x25 reports
          // 79x24. The `grid` row answers a size that is genuinely different and must still refuse.
          const property = mode === "grid" ? { width: cols, height: rows - 1 } : { width: cols - 1, height: rows - 1 }
          reply = { get_property_response: { status: 0, json_value: JSON.stringify(property) } }
        } else {
          expect(request.get_buffer_request).toEqual({
            session: "owned",
            include_styles: true,
            line_range: { screen_contents_only: true },
          })
          const fixed = [
            { text: "abcd", code_points_per_cell: [{ repeats: 4 }], continuation: 2, style: [{ repeats: 4 }] },
            { text: "ef", code_points_per_cell: [{ repeats: 2 }], continuation: 1, style: [{ repeats: 4 }] },
          ]
          const full = Array.from({ length: rows }, (_, index) => ({
            text: "x".repeat(cols),
            code_points_per_cell: [{ repeats: cols }],
            continuation: index === rows - 1 ? 1 : 2,
            style: [{ repeats: cols }],
          }))
          reply = { get_buffer_response: { status: 0, contents: mode === "wide" ? full : fixed } }
        }
        ws.send(serverType.encode(serverType.fromObject({ id: request.id, ...reply })).finish())
      },
    },
  })
  const retained: Uint8Array[] = []
  const packageUrl = import.meta.resolve("ws/package.json")
  const metadata = JSON.parse(readFileSync(new URL(packageUrl), "utf8")) as { exports: { ".": { import: string } } }
  const actual = (await import(new URL(metadata.exports["."].import, packageUrl).href)) as typeof import("ws")
  const sends = vi.spyOn(actual.default.prototype, "send")
  try {
    const result = await readITermCells({
      tty: "/dev/ttys004",
      cols,
      rows,
      onReply: (bytes) => retained.push(bytes),
    })
    // A rejected upgrade never opens a socket, so no protobuf request is ever sent.
    if (mode === "ws400") expect(sends).not.toHaveBeenCalled()
    else expect(sends, JSON.stringify(result)).toHaveBeenCalled()
    expect(headers, JSON.stringify(result)).toEqual([
      "test-cookie",
      "test-key",
      "true",
      "api.iterm2.com",
      "terminfo.dev 1",
    ])
    if (mode === "match" || mode === "wide") {
      expect(result).toEqual({
        status: "read",
        app: "iterm2",
        cells: {
          cols,
          rows,
          text: mode === "wide" ? Array.from({ length: rows }, () => "x".repeat(cols)) : ["abcd", "ef  "],
          paddedRows: mode === "wide" ? [] : [2],
          droppedLines: 0,
        },
      })
      expect(retained.length).toBeGreaterThan(0)
    } else {
      // Every refusal names the values it compared, so a hosted failure is diagnosable from its text.
      const named =
        mode === "grid"
          ? [`grid_size property ${cols}x${rows - 1} plus 1`, `${cols + 1}x${rows}`, `measured grid is ${cols}x${rows}`]
          : mode === "changed"
            ? ["TTY changed during the physical read", "/dev/ttys004", "/dev/ttys999"]
            : mode === "missing"
              ? ["owned TTY /dev/ttys004 matches 0 API sessions"]
              : ["Unexpected server response: 400", 'x-iterm2-library-version "terminfo.dev 1"']
      if (result.status !== "refused") throw new Error(`expected a refusal, got ${JSON.stringify(result)}`)
      for (const value of named) expect(result.reason).toContain(value)
      if (mode === "missing") expect(requests.some((request) => request.get_buffer_request)).toBe(false)
    }
  } finally {
    sends.mockRestore()
    server.stop(true)
  }
})
