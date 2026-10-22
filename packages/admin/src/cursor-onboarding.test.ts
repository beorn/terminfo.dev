/**
 * @failure The Cursor launch relies on a hidden flag, the update.mode setting or a seeded storage key that the installed bundle no longer honours, so onboarding or a notification toast covers the probe terminal instead of the launch failing loud.
 * @level l1
 * @consumer Cursor's cliLaunch prepare step in packages/admin/src/app.ts.
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, test } from "vitest"
import {
  CURSOR_APPLICATION_USER_STORAGE_KEY,
  CURSOR_BUNDLE_PINS,
  assertCursorBundlePinsShipped,
  dismissCursorCommandLinePrompt,
} from "./cursor-onboarding.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fakeCursorApp(omit?: string): string {
  const appPath = join(mkdtempSync(join(tmpdir(), "terminfo-cursor-")), "Cursor.app")
  roots.push(dirname(appPath))
  mkdirSync(join(appPath, "Contents"), { recursive: true })
  writeFileSync(
    join(appPath, "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleShortVersionString</key>\n\t<string>9.9.9</string></dict></plist>",
  )
  for (const pin of CURSOR_BUNDLE_PINS) {
    const path = join(appPath, pin.file)
    mkdirSync(dirname(path), { recursive: true })
    const text = pin.substring === omit ? "minified();" : `before;${pin.substring}after;`
    writeFileSync(path, text, { flag: "a" })
  }
  return appPath
}

test("passes when the shipped Cursor bundle still honours every pinned launch quirk", () => {
  expect(() => assertCursorBundlePinsShipped(fakeCursorApp())).not.toThrow()
})

test.each(CURSOR_BUNDLE_PINS)("refuses the launch when $file lacks $substring", (pin) => {
  const appPath = fakeCursorApp(pin.substring)
  expect(() => assertCursorBundlePinsShipped(appPath)).toThrow(
    expect.objectContaining({
      message: expect.stringContaining(join(appPath, pin.file)),
    }),
  )
  expect(() => assertCursorBundlePinsShipped(appPath)).toThrow(pin.substring)
  expect(() => assertCursorBundlePinsShipped(appPath)).toThrow(pin.because)
  expect(() => assertCursorBundlePinsShipped(appPath)).toThrow("Cursor 9.9.9")
})

test("refuses the launch when the bundle file is missing and names the unreadable version", () => {
  const appPath = join(mkdtempSync(join(tmpdir(), "terminfo-cursor-")), "Cursor.app")
  roots.push(dirname(appPath))
  expect(() => assertCursorBundlePinsShipped(appPath)).toThrow(join(appPath, CURSOR_BUNDLE_PINS[0]!.file))
  expect(() => assertCursorBundlePinsShipped(appPath)).toThrow(/Cursor version unreadable from .*Info\.plist/)
})

// Cursor shows "Want to launch Cursor from the command line?" unless application storage says the
// prompt was dismissed; there is no setting for it. app.test.ts mocks node:sqlite, so only a real
// database proves Cursor's own ItemTable schema and the stored row survive the round trip.
test("seeds Cursor's application storage so the command-line prompt reads as dismissed", () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "terminfo-cursor-user-data-"))
  roots.push(userDataDir)
  mkdirSync(join(userDataDir, "User"))
  dismissCursorCommandLinePrompt(userDataDir)
  const database = new DatabaseSync(join(userDataDir, "User", "globalStorage", "state.vscdb"))
  try {
    // Cursor 3.25.9 main.js opens application storage with this statement; it must be a no-op.
    database.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
    const rows = database.prepare("SELECT key, value FROM ItemTable").all()
    expect(rows).toEqual([
      {
        key: CURSOR_APPLICATION_USER_STORAGE_KEY,
        value: JSON.stringify({ cmdLineHookState: { ignored: true, timesShown: 0 } }),
      },
    ])
  } finally {
    database.close()
  }
  // A second seed into the same profile is a reused user-data-dir, never a merge.
  expect(() => dismissCursorCommandLinePrompt(userDataDir)).toThrow(/EEXIST/)
})
