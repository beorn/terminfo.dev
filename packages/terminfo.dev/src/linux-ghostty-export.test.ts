/**
 * @failure The Ghostty export reader counts a file Ghostty did not hand over for this press, a leftover file from
 *   an earlier press, an empty or missing export, or a path it guessed; or miscounts the dump's lines (#34278,
 *   @cto a1663f9d's five conditions). No earlier test covers it: the Linux arm had no Ghostty reader.
 * @level l1
 * @consumer The Linux owned-terminal Ghostty scrollback count, through readGhosttyExport.
 * @testonly none
 */
import { describe, expect, it } from "vitest"
import { ScrollbackReadingUnavailable } from "@terminfo/probe-defs"
import {
  exportedHistoryLines,
  GHOSTTY_EXPORT_METHOD,
  readGhosttyExport,
  type GhosttyExportDeps,
} from "./linux-ghostty-export.ts"

const PATH = "/tmp/GYpv59njdnxWZOuAM3bNgw/history.txt"
/** Ghostty 1.4.0's measured dump for 60 lines on 24 rows: lines 1..36, the last unterminated. */
const DUMP = Array.from({ length: 36 }, (_, i) => `line ${i + 1}`).join("\n")

function deps(over: Partial<GhosttyExportDeps> & { typed?: string | null; mtimeMs?: number; text?: string } = {}) {
  const pressed: string[] = []
  const removed: string[] = []
  let reads = 0
  const typed = over.typed === undefined ? `${PATH}\r` : over.typed
  const d: GhosttyExportDeps = {
    press: async (keys) => void pressed.push(keys),
    readPasted: async (pattern, inject) => {
      await inject()
      return typed === null ? null : pattern.exec(typed)
    },
    now: () => 1_000_000,
    stat: () => ({ isFile: true, mtimeMs: over.mtimeMs ?? 1_000_050 }),
    readOnce: () => {
      reads++
      return over.text ?? DUMP
    },
    remove: (path) => void removed.push(path),
    screenRows: () => 24,
    ...over,
  }
  return { d, pressed, removed, reads: () => reads }
}

describe("readGhosttyExport", () => {
  it("counts the history Ghostty handed over plus the screen, read once, then removed", async () => {
    const { d, pressed, removed, reads } = deps()
    const reading = await readGhosttyExport(d)
    expect(reading.totalLines).toBe(36 + 24)
    expect(reading.screenLines).toBe(24)
    expect(pressed).toEqual(["ctrl+shift+F12", "Return"])
    expect(reads()).toBe(1)
    expect(removed).toEqual([PATH])
    expect(JSON.parse(reading.receipt!)).toMatchObject({ method: GHOSTTY_EXPORT_METHOD, path: PATH, historyLines: 36 })
  })

  for (const [name, over, reason] of [
    ["no path typed before the timeout", { typed: null }, /typed no file path/],
    ["a bare slash", { typed: "/\r" }, /typed no file path/],
    ["a leftover file older than the press", { mtimeMs: 900_000 }, /predates the key press/],
    ["an empty export", { text: "" }, /export is empty/],
    ["a path that is not a file", { stat: () => ({ isFile: false, mtimeMs: 1_000_050 }) }, /not a file/],
    [
      "a path that cannot be read",
      {
        stat: () => {
          throw new Error("ENOENT")
        },
      },
      /cannot be read/,
    ],
  ] as const) {
    it(`is unavailable, never a count, on ${name}`, async () => {
      const error = await readGhosttyExport(deps(over as never).d).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ScrollbackReadingUnavailable)
      expect((error as Error).message).toMatch(reason)
    })
  }

  it("takes only an absolute path the pane received, never text without the terminating Return", async () => {
    const error = await readGhosttyExport(deps({ typed: PATH }).d).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ScrollbackReadingUnavailable)
  })
})

describe("exportedHistoryLines", () => {
  it("counts an unterminated last line, a terminated one the same, and nothing as zero", () => {
    expect(exportedHistoryLines("a\nb")).toBe(2)
    expect(exportedHistoryLines("a\nb\n")).toBe(2)
    expect(exportedHistoryLines("")).toBe(0)
  })
})
