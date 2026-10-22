/**
 * @failure The Cursor launch passes --skip-onboarding to a bundle that no longer honours it, so the onboarding modal hides the probe terminal and calibration times out instead of failing loud.
 * @level l1
 * @consumer Cursor's cliLaunch prepare step in packages/admin/src/app.ts.
 * @testonly none
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { CURSOR_SKIP_ONBOARDING_PINS, assertCursorSkipOnboardingShipped } from "./cursor-onboarding.ts"

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
  for (const pin of CURSOR_SKIP_ONBOARDING_PINS) {
    const path = join(appPath, pin.file)
    mkdirSync(dirname(path), { recursive: true })
    const text = pin.substring === omit ? "minified();" : `before;${pin.substring}after;`
    writeFileSync(path, text, { flag: "a" })
  }
  return appPath
}

test("passes when the shipped Cursor bundle still honours --skip-onboarding", () => {
  expect(() => assertCursorSkipOnboardingShipped(fakeCursorApp())).not.toThrow()
})

test.each(CURSOR_SKIP_ONBOARDING_PINS)("refuses the launch when $file lacks $substring", (pin) => {
  const appPath = fakeCursorApp(pin.substring)
  expect(() => assertCursorSkipOnboardingShipped(appPath)).toThrow(
    expect.objectContaining({
      message: expect.stringContaining(join(appPath, pin.file)),
    }),
  )
  expect(() => assertCursorSkipOnboardingShipped(appPath)).toThrow(pin.substring)
  expect(() => assertCursorSkipOnboardingShipped(appPath)).toThrow("Cursor 9.9.9")
})

test("refuses the launch when the bundle file is missing and names the unreadable version", () => {
  const appPath = join(mkdtempSync(join(tmpdir(), "terminfo-cursor-")), "Cursor.app")
  roots.push(dirname(appPath))
  expect(() => assertCursorSkipOnboardingShipped(appPath)).toThrow(join(appPath, CURSOR_SKIP_ONBOARDING_PINS[0]!.file))
  expect(() => assertCursorSkipOnboardingShipped(appPath)).toThrow(/Cursor version unreadable from .*Info\.plist/)
})
