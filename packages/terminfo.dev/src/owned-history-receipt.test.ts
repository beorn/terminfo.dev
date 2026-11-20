/**
 * @failure A history count is published with the run's socket or host path in its identity record, or with
 *   two ttys recorded as matching when one was never measured (@cto 41fcd747).
 * @level l1
 * @consumer Every owned history reader that attaches `TerminalScrollbackReading.receipt`.
 * @testonly none
 */
import { expect, test } from "vitest"
import { executableName, ownedHistoryReceipt, ttyName } from "./owned-history-receipt.ts"

const recorded = (receipt: ReturnType<typeof ownedHistoryReceipt>): Record<string, unknown> => {
  if (receipt.status !== "recorded") throw new Error(receipt.reason)
  return JSON.parse(receipt.receipt) as Record<string, unknown>
}

test("a tty records by name and an executable by basename, so no host path reaches the record", () => {
  expect(ttyName("/dev/ttys004")).toBe("ttys004")
  expect(ttyName("  ttys004 ")).toBe("ttys004")
  expect(executableName("/Applications/WezTerm.app/Contents/MacOS/wezterm")).toBe("wezterm")
  expect(executableName("C:\\Program Files\\WezTerm\\wezterm.exe")).toBe("wezterm.exe")
  const receipt = recorded(
    ownedHistoryReceipt({
      surface: "wezterm",
      pane: "17",
      listedTty: "/dev/ttys004",
      measuredTty: "ttys004",
      socketPresent: true,
      executable: "/opt/wezterm/bin/wezterm",
    }),
  )
  expect(receipt).toEqual({
    surface: "wezterm",
    pane: "17",
    listedTty: "ttys004",
    measuredTty: "ttys004",
    ttyMatch: true,
    socketPresent: true,
    executable: "wezterm",
  })
  expect(JSON.stringify(receipt)).not.toMatch(/[\\/]/u)
})

test("a differing tty pair records false, and an unmeasured tty records no match at all", () => {
  expect(
    recorded(ownedHistoryReceipt({ surface: "wezterm", pane: "17", listedTty: "ttys009", measuredTty: "ttys004" })),
  ).toMatchObject({ listedTty: "ttys009", measuredTty: "ttys004", ttyMatch: false })
  // Windows publishing no socket, no pane list and no tty: absent stays absent, never a claimed match.
  expect(recorded(ownedHistoryReceipt({ surface: "wezterm", pane: "0", socketPresent: true }))).toMatchObject({
    pane: "0",
    listedTty: null,
    measuredTty: null,
    ttyMatch: null,
    socketPresent: true,
    executable: null,
  })
})

test("a value that keeps a path separator refuses the record rather than publishing it", () => {
  const refused = ownedHistoryReceipt({ surface: "wezterm", pane: "/dev/ttys004/child", socketPresent: true })
  expect(refused.status).toBe("refused")
  expect(refused.status === "refused" && refused.reason).toMatch(/pane still carries a path separator/)
})
