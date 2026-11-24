/**
 * @failure Witness window B accepts unauthenticated calls, wrong run ids, non-DECRQM/non-OSC-color requests,
 * or returns a reading without re-verifying ownership around every read (#34080 Slice 2, @cto d43c34cc (e)).
 * @level l1
 * @consumer Terminal.app window-scoped owner arm (owned-terminal.ts, serve.ts, app.ts).
 * @testonly none
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  createWitnessClient,
  isAllowedWitnessAttribute,
  parseWitnessRegistration,
  startWitnessResponder,
  stopWitnessResponder,
  type RunningWitnessResponder,
} from "./witness-window.ts"

const runId = "0123456789abcdef0123456789abcdef"
const active: RunningWitnessResponder[] = []
const tempDirs: string[] = []

afterEach(async () => {
  while (active.length > 0) {
    await active.pop()!.close()
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("witness-window read-only allowlist", () => {
  test("admits only DECRQM (dec-mode, ansi-mode) and OSC color queries", () => {
    expect(isAllowedWitnessAttribute({ kind: "dec-mode", mode: 7 })).toBe(true)
    expect(isAllowedWitnessAttribute({ kind: "ansi-mode", mode: 4 })).toBe(true)
    expect(isAllowedWitnessAttribute({ kind: "palette", index: 1 })).toBe(true)
    expect(isAllowedWitnessAttribute({ kind: "foreground" })).toBe(true)
    expect(isAllowedWitnessAttribute({ kind: "background" })).toBe(true)
    expect(isAllowedWitnessAttribute({ kind: "cursor-colour" })).toBe(true)
    expect(isAllowedWitnessAttribute({ kind: "highlight-background" })).toBe(true)
    expect(isAllowedWitnessAttribute({ kind: "highlight-foreground" })).toBe(true)
  })

  test("refuses sgr, pointer-shape, extra keys, and out-of-range parameters", () => {
    for (const bad of [
      { kind: "sgr" },
      { kind: "pointer-shape" },
      { kind: "dec-mode", mode: 0 },
      { kind: "dec-mode", mode: 7, write: "\x1b[?7l" },
      { kind: "palette", index: 256 },
      { kind: "palette", index: -1 },
      { kind: "foreground", extra: true },
      { kind: "raw", bytes: "\x1b]4;1;rgb:ff/00/00\x07" },
      null,
      "dec:7",
    ]) {
      expect(isAllowedWitnessAttribute(bad)).toBe(false)
    }
  })
})

describe("witness-window loopback responder & client", () => {
  test("binds loopback with run-id + bearer auth, writes registration, answers allowed queries, rejects mutations, and stops cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terminfo-witness-"))
    tempDirs.push(dir)
    const regPath = join(dir, "witness.json")
    const seen: string[] = []
    const responder = await startWitnessResponder({
      runId,
      registrationPath: regPath,
      ttyPath: "/dev/ttys012",
      registerSignals: false,
      reader: async (attr) => {
        seen.push(attr.kind)
        if (attr.kind === "dec-mode" && attr.mode === 7) return "1"
        if (attr.kind === "palette" && attr.index === 1) return "rgb:c2c2/3636/2121"
        return null
      },
    })
    active.push(responder)

    const onDisk = parseWitnessRegistration(readFileSync(regPath, "utf8"))
    expect(onDisk).toEqual(responder.registration)
    expect(onDisk.tty).toBe("/dev/ttys012")

    // Reject missing/wrong token and wrong run id.
    const noAuth = await fetch(`http://127.0.0.1:${onDisk.port}/read`, {
      method: "POST",
      body: JSON.stringify({ attribute: { kind: "dec-mode", mode: 7 } }),
    })
    expect(noAuth.status).toBe(401)

    const badRun = await fetch(`http://127.0.0.1:${onDisk.port}/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${onDisk.token}`, "x-terminfo-run-id": "f".repeat(32) },
      body: JSON.stringify({ attribute: { kind: "dec-mode", mode: 7 } }),
    })
    expect(badRun.status).toBe(403)

    // Reject non-allowlisted attribute (no write path, no SGR/pointer).
    const disallowed = await fetch(`http://127.0.0.1:${onDisk.port}/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${onDisk.token}`, "x-terminfo-run-id": runId },
      body: JSON.stringify({ attribute: { kind: "sgr" } }),
    })
    expect(disallowed.status).toBe(400)

    const unknownRoute = await fetch(`http://127.0.0.1:${onDisk.port}/write`, {
      method: "POST",
      headers: { authorization: `Bearer ${onDisk.token}`, "x-terminfo-run-id": runId },
      body: "{}",
    })
    expect(unknownRoute.status).toBe(404)

    // Client checks ownership before & after every read and returns parsed values.
    const check = vi.fn()
    const client = createWitnessClient({
      app: "terminal-app",
      endpoint: { runId, port: onDisk.port, token: onDisk.token },
      check,
    })
    expect(await client.read({ kind: "dec-mode", mode: 7 })).toBe("1")
    expect(await client.read({ kind: "palette", index: 1 })).toBe("rgb:c2c2/3636/2121")
    expect(await client.read({ kind: "foreground" })).toBeUndefined()
    expect(await client.read({ kind: "sgr" })).toBeUndefined()
    // 3 allowed HTTP reads x 2 checks (before + after); disallowed sgr returned undefined before HTTP.
    expect(check).toHaveBeenCalledTimes(6)
    expect(seen).toEqual(["dec-mode", "palette", "foreground"])

    // Revoked ownership check refuses before reading.
    check.mockImplementationOnce(() => {
      throw new Error("owned Terminal window no longer exists uniquely")
    })
    await expect(client.read({ kind: "dec-mode", mode: 7 })).rejects.toThrow(/no longer exists uniquely/)

    // Clean stop via /stop closes the server and resolves `closed`.
    await stopWitnessResponder({ runId, port: onDisk.port, token: onDisk.token })
    await responder.closed
  })
})
