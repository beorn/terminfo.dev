/**
 * @failure The tmux pre-flight's helper lost CLIPBOARD and the run could only infer who took it from receipts
 *          (33003); the taker read must name the client, and a crashed read must cost one read, never the run.
 * @level   l1 — the child is faked for the X answers; one test spawns the real child with a library that cannot
 *          load, to prove a failing child comes back as a named read.
 * @consumer createClipboardOwnership in linux-clipboard.ts (33693, @cto 379b191a)
 * @testonly none
 */
import { expect, test } from "vitest"
import { mappedLibX11, readSelectionTaker, selectionOwnerIo, type SelectionOwnerIo } from "./linux-selection-owner.ts"

const answered = (stdout: object, xprop: Record<string, string> = {}): SelectionOwnerIo => ({
  child: async () => ({ code: 0, signal: null, stdout: JSON.stringify(stdout), stderr: "" }),
  xprop: async (window) => xprop[window] ?? "",
})

test("the taker is named by the WM_CLASS of a top-level window of the owner's X client", async () => {
  // Kitty owns the selection from a helper window with no properties; its client's top-level window names it.
  const read = await readSelectionTaker(
    "clipboard",
    "/lib/libX11.so.6",
    answered(
      { owner: String(0x600005), mask: String(0x1fffff), children: [String(0x200001), String(0x60000d)] },
      { "0x60000d": 'WM_CLASS(STRING) = "kitty", "kitty"\n_NET_WM_PID(CARDINAL) = 77\n' },
    ),
  )
  expect(read).toEqual({
    read: true,
    at: expect.any(String),
    window: "0x600005",
    clientWindows: ["0x60000d"],
    takerClass: '"kitty", "kitty"',
    takerPid: 77,
  })
})

test("an owner whose client has no named window is still read, without a class", async () => {
  const read = await readSelectionTaker(
    "clipboard",
    "/lib/libX11.so.6",
    answered({ owner: String(0x200001), mask: String(0x1fffff), children: [String(0x60000d)] }),
  )
  expect(read).toEqual({ read: true, at: expect.any(String), window: "0x200001", clientWindows: [] })
})

test("no owner, a crashed child and unreadable output are named reads that failed, never a throw", async () => {
  expect(
    await readSelectionTaker("primary", "/lib/x", answered({ owner: "0", mask: String(0x1fffff), children: [] })),
  ).toEqual({ read: false, at: expect.any(String), reason: "primary has no owner" })
  const crashed: SelectionOwnerIo = {
    child: async () => ({ code: null, signal: "SIGSEGV", stdout: "", stderr: "" }),
    xprop: async () => "",
  }
  expect(await readSelectionTaker("clipboard", "/lib/x", crashed)).toEqual({
    read: false,
    at: expect.any(String),
    reason: "taker child signal SIGSEGV",
  })
  const garbled: SelectionOwnerIo = {
    child: async () => ({ code: 0, signal: null, stdout: "not json", stderr: "" }),
    xprop: async () => "",
  }
  expect(await readSelectionTaker("clipboard", "/lib/x", garbled)).toMatchObject({
    read: false,
    reason: 'taker child printed no JSON: "not json"',
  })
})

test("child JSON with a missing or malformed field is a named read that failed, never a TypeError", async () => {
  for (const printed of [
    { owner: "12" },
    { owner: "twelve", mask: "1", children: [] },
    { owner: "12", mask: "1", children: ["zz"] },
    { owner: "12", mask: "1", children: "13" },
    null,
  ]) {
    const io: SelectionOwnerIo = {
      child: async () => ({ code: 0, signal: null, stdout: JSON.stringify(printed), stderr: "" }),
      xprop: async () => "",
    }
    expect(await readSelectionTaker("clipboard", "/lib/x", io)).toEqual({
      read: false,
      at: expect.any(String),
      reason: `taker child printed JSON without a numeric owner, mask and children list: ${JSON.stringify(JSON.stringify(printed))}`,
    })
  }
})

test("the real child fails alone when its library cannot load, and the read names its exit", async () => {
  const io = selectionOwnerIo({ ...process.env, DISPLAY: ":0" }, async () => "")
  const read = await readSelectionTaker("clipboard", "/nonexistent/libX11.so.6", io, 10_000)
  expect(read.read).toBe(false)
  expect(read.read === false && read.reason).toMatch(/^taker child exited [1-9]\d*: /)
})

test("the library path comes from the helper's own mappings, and a helper without one is named", () => {
  const maps =
    "7f00-7f01 r--p 0 08:01 1 /nix/store/aaa-libx11-1.8.14/lib/libX11.so.6.4.0\n" +
    "7f02-7f03 r--p 0 08:01 2 /nix/store/bbb-glibc/lib/libc.so.6\n"
  expect(mappedLibX11(94, () => maps)).toBe("/nix/store/aaa-libx11-1.8.14/lib/libX11.so.6.4.0")
  expect(() => mappedLibX11(94, () => "7f02-7f03 r--p 0 08:01 2 /lib/libc.so.6\n")).toThrow(
    "helper 94 has no libX11.so.6 mapped, so the selection taker cannot be read",
  )
})
