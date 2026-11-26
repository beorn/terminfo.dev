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

test("Linux pts/<digits> tty names record canonical pts/<digits> directly while refusing non-pts or nested paths (#37209, @cto 53fa361e)", () => {
  expect(ttyName("/dev/pts/3")).toBe("pts/3")
  expect(ttyName("  pts/3 ")).toBe("pts/3")
  const matched = recorded(
    ownedHistoryReceipt({
      surface: "wezterm",
      pane: "0",
      listedTty: "/dev/pts/3",
      measuredTty: "pts/3",
      socketPresent: true,
      executable: "/nix/store/owned-wezterm/bin/wezterm",
    }),
  )
  expect(matched).toEqual({
    surface: "wezterm",
    pane: "0",
    listedTty: "pts/3",
    measuredTty: "pts/3",
    ttyMatch: true,
    socketPresent: true,
    executable: "wezterm",
  })
  expect(
    recorded(
      ownedHistoryReceipt({ surface: "wezterm", pane: "0", listedTty: "/dev/pts/3", measuredTty: "/dev/pts/4" }),
    ),
  ).toMatchObject({ listedTty: "pts/3", measuredTty: "pts/4", ttyMatch: false })
  expect(
    recorded(ownedHistoryReceipt({ surface: "wezterm", pane: "0", listedTty: "/dev/pts/3", measuredTty: "3" })),
  ).toMatchObject({ listedTty: "pts/3", measuredTty: "3", ttyMatch: false })
  expect(
    recorded(ownedHistoryReceipt({ surface: "wezterm", pane: "0", listedTty: "/dev/pts/3", measuredTty: "pts%2F3" })),
  ).toMatchObject({ listedTty: "pts/3", measuredTty: "pts%2F3", ttyMatch: false })

  for (const invalidTty of ["/tmp/pts/3", "pts/3/child", "../pts/3", "pts\\3", "pts/", "pts/not-digits"]) {
    const refusedListed = ownedHistoryReceipt({
      surface: "wezterm",
      pane: "0",
      listedTty: invalidTty,
      measuredTty: "/dev/pts/3",
    })
    expect(refusedListed.status).toBe("refused")
    expect(refusedListed.status === "refused" && refusedListed.reason).toMatch(
      /listedTty still carries a path separator/,
    )
    const refusedMeasured = ownedHistoryReceipt({
      surface: "wezterm",
      pane: "0",
      listedTty: "/dev/pts/3",
      measuredTty: invalidTty,
    })
    expect(refusedMeasured.status).toBe("refused")
    expect(refusedMeasured.status === "refused" && refusedMeasured.reason).toMatch(
      /measuredTty still carries a path separator/,
    )
  }

  const refusedPane = ownedHistoryReceipt({ surface: "wezterm", pane: "pts/3", socketPresent: true })
  expect(refusedPane.status).toBe("refused")
  expect(refusedPane.status === "refused" && refusedPane.reason).toMatch(/pane still carries a path separator/)
})
