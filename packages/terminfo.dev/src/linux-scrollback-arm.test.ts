/**
 * @failure Linux alacritty, ghostty and xterm have capture and no history reader, so
 *   scrollback.accumulate and scrollback.total-lines report the generic screenshot todo
 *   ("not readable from the screen") instead of the arm the collector already has (#34278).
 * @level l1
 * @consumer createOwnedTerminal on the Linux arm, via linuxScrollbackArm.
 * @testonly none
 */
import { expect, test } from "vitest"
import {
  DECLARED_UNTESTABLE_TEST,
  recordExecutedProbe,
  scrollbackProbes,
  type TermProbeSource,
} from "@terminfo/probe-defs"
import { linuxScrollbackArm } from "./owned-terminal.ts"

const SCREENSHOT = "not readable from the screen"
const ROWS = ["scrollback.accumulate", "scrollback.total-lines"] as const

function source(overrides: Partial<TermProbeSource>): TermProbeSource {
  return {
    kind: "live",
    rows: 24,
    cols: 80,
    write() {},
    queryCursorPosition: async () => ({ row: 24, col: 1 }),
    measureRenderedWidth: async () => ({ kind: "no-reply", step: "sample" }) as const,
    query: async () => null,
    queryWithSentinel: async () => null,
    queryOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryWithSentinelOutcome: async () => ({ match: null, reason: "timeout", raw: "", rawBase64: "" }),
    queryMode: async () => null,
    capture: async () => {
      throw new Error("screenshot arm must not run")
    },
    ...overrides,
  }
}

function probe(id: string) {
  const found = scrollbackProbes.find((entry) => entry.id === id)
  if (!found?.term) throw new Error(`missing app callback for ${id}`)
  return found
}

const linuxReceipt = { executable: "present" }
const installedReader = () => ({ totalLines: 24, screenLines: 24 })
const arm = (appId: string | undefined, linux: object | undefined = linuxReceipt, reader: unknown = undefined) =>
  linuxScrollbackArm(linux, reader, appId)

test("linuxScrollbackArm names only the three apps that have no installed reader", () => {
  expect(arm("alacritty")).toEqual({ scrollbackUnavailable: "no pane read on this app" })
  expect(arm("ghostty").scrollbackUnavailable).toBeUndefined()
  expect(arm("ghostty").scrollbackProbeTodo).toBe("this Linux arm does not invoke Ghostty's scrollback-file action")
  expect(arm("xterm").scrollbackUnavailable).toBeUndefined()
  expect(arm("xterm").scrollbackProbeTodo).toBe("this Linux arm has no history reader for xterm")
  for (const id of [undefined, "kitty", "wezterm", "tmux", "screen", "cmux", "terminal-app"]) {
    expect(arm(id), id ?? "undefined").toEqual({})
  }
  expect(linuxScrollbackArm(undefined, undefined, "alacritty")).toEqual({})
  expect(linuxScrollbackArm(linuxReceipt, installedReader, "alacritty")).toEqual({})
  expect(linuxScrollbackArm(linuxReceipt, installedReader, "ghostty")).toEqual({})
})

test("the six Linux cells take that arm and never the screenshot todo", async () => {
  for (const app of ["alacritty", "ghostty", "xterm"] as const) {
    const named = linuxScrollbackArm(linuxReceipt, undefined, app)
    for (const id of ROWS) {
      const result = await probe(id).term?.(source(named))
      const folded = recordExecutedProbe({
        featureId: id,
        attempt: { scope: "probe", startedAt: "2026-11-14T12:30:00.000Z" },
        assertions: [],
        ...(result?.notTested ? { coverage: { featureId: id, rawReplyRef: id, ...result.notTested } } : {}),
      })
      const text = `${folded.reason ?? ""} ${result?.tests?.map((item) => item.reason).join(" ") ?? ""}`
      expect(text, `${app} ${id}`).not.toContain(SCREENSHOT)
      if (app === "alacritty") {
        expect(result?.tests, `${app} ${id}`).toEqual([
          { id: DECLARED_UNTESTABLE_TEST, status: "untestable", reason: "no pane read on this app" },
        ])
      } else {
        expect(folded.status, `${app} ${id}`).toBe("probe-todo")
        expect(folded.reason, `${app} ${id}`).toBe(named.scrollbackProbeTodo)
      }
    }
  }
})
