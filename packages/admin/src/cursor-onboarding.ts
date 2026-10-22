/**
 * Cursor has no documented way to skip its first-run onboarding. Cursor 3.25.9 ships a hidden argv
 * flag, `--skip-onboarding`, and its onboarding contribution returns before rendering when it is set.
 * The flag is undocumented, so every launch first proves the installed bundle still honours it.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Bundle substrings measured in the reviewed Cursor 3.25.9 darwin-arm64 build (commit 5d4df965,
 * zip SHA-256 03c6fb01…bf763, pinned in .github/workflows/macos-measurement.yml). Paths are relative
 * to the app bundle. */
export const CURSOR_SKIP_ONBOARDING_PINS = [
  // The main process argv schema accepts the flag, so it reaches the window's environment.
  { file: "Contents/Resources/app/out/main.js", substring: '"skip-onboarding":{type:"boolean"}' },
  // The workbench environment service exposes it as `skipOnboarding`.
  {
    file: "Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js",
    substring: 'get skipOnboarding(){return!!this.args["skip-onboarding"]}',
  },
  // maybeOnboard() returns before renderPopupBar() when it is set.
  {
    file: "Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js",
    substring: "this._nativeWorkbenchEnvironmentService.isGlass||this.environmentService.skipOnboarding||",
  },
] as const

function cursorVersion(appPath: string): string {
  const plist = join(appPath, "Contents", "Info.plist")
  let text: string
  try {
    text = readFileSync(plist, "utf8")
  } catch (cause) {
    return `Cursor version unreadable from ${plist} (${cause instanceof Error ? cause.message : String(cause)})`
  }
  const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1]
  return version === undefined
    ? `Cursor version unreadable from ${plist} (no XML CFBundleShortVersionString)`
    : `Cursor ${version}`
}

/** Throw unless the Cursor app at `appPath` still ships every pinned `--skip-onboarding` check. */
export function assertCursorSkipOnboardingShipped(appPath: string): void {
  const contents = new Map<string, string>()
  for (const pin of CURSOR_SKIP_ONBOARDING_PINS) {
    const path = join(appPath, pin.file)
    let text = contents.get(path)
    if (text === undefined) {
      try {
        text = readFileSync(path, "utf8")
      } catch (cause) {
        throw new Error(
          `${cursorVersion(appPath)}: cannot read ${path} to confirm --skip-onboarding still skips onboarding (expected substring ${pin.substring}); refusing to launch Cursor into its onboarding modal`,
          { cause },
        )
      }
      contents.set(path, text)
    }
    if (!text.includes(pin.substring)) {
      throw new Error(
        `${cursorVersion(appPath)}: ${path} no longer contains ${pin.substring}, so --skip-onboarding may not skip onboarding; re-measure the bundle and update CURSOR_SKIP_ONBOARDING_PINS before launching Cursor`,
      )
    }
  }
}
