/**
 * Cursor's first-run onboarding and two notification toasts cover the probe terminal, and only part of
 * that is reachable through documented settings:
 *
 * - Onboarding: Cursor 3.25.9 ships a hidden argv flag, `--skip-onboarding`, and its onboarding
 *   contribution returns before rendering when it is set.
 * - "New update available": the upstream `update.mode` setting; Cursor's own update service resolves
 *   it and is Disabled under "none" before any check, so the toast's "ready" state never arrives.
 * - "Want to launch Cursor from the command line?": no setting. The prompt reads `cmdLineHookState`
 *   from Cursor's application storage, and its "Never show again" button records `ignored`. The launch
 *   seeds that record before Cursor starts.
 *
 * Each of these is a Cursor implementation detail, so every launch first proves the installed bundle
 * still carries it.
 */

import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

/** Bundle substrings measured in the reviewed Cursor 3.25.9 darwin-arm64 build (commit 5d4df965,
 * zip SHA-256 03c6fb01…bf763, pinned in .github/workflows/macos-measurement.yml). Paths are relative
 * to the app bundle; `because` names what the launch relies on. */
export const CURSOR_BUNDLE_PINS = [
  // The main process argv schema accepts the flag, so it reaches the window's environment.
  {
    file: "Contents/Resources/app/out/main.js",
    substring: '"skip-onboarding":{type:"boolean"}',
    because: "--skip-onboarding may not skip onboarding",
  },
  // The workbench environment service exposes it as `skipOnboarding`.
  {
    file: "Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js",
    substring: 'get skipOnboarding(){return!!this.args["skip-onboarding"]}',
    because: "--skip-onboarding may not skip onboarding",
  },
  // maybeOnboard() returns before renderPopupBar() when it is set.
  {
    file: "Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js",
    substring: "this._nativeWorkbenchEnvironmentService.isGlass||this.environmentService.skipOnboarding||",
    because: "--skip-onboarding may not skip onboarding",
  },
  // The update service's initialize() sets Disabled when this returns no quality, before any check;
  // the update toast is shown only from the "ready" state.
  {
    file: "Contents/Resources/app/out/main.js",
    substring: 'getProductQualityForUpdateMode(e){return e==="none"?void 0:this.productService.quality}',
    because: 'update.mode "none" may not stop the update toast',
  },
  // Cursor's own reader of application storage names <user-data-dir>/User/globalStorage/state.vscdb.
  {
    file: "Contents/Resources/app/out/main.js",
    substring:
      'getGlobalStoragePath(){return L(this.environmentMainService.userDataPath,"User","globalStorage","state.vscdb")}',
    because: "the seeded application storage may not reach the command-line toast",
  },
  // The application-user record is stored under this key...
  {
    file: "Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js",
    substring:
      'bis="src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage",zfe=`${bis}.applicationUser`',
    because: "the seeded application storage may not reach the command-line toast",
  },
  // ...in application scope (-1)...
  {
    file: "Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js",
    substring:
      "[this.applicationUserPersistentStorage,this._setApplicationUserPersistentStorage]=this.loadPersistentStorage(-1,0,zfe,",
    because: "the seeded application storage may not reach the command-line toast",
  },
  // ...and the command-line prompt reads cmdLineHookState from it and is skipped when it is ignored.
  {
    file: "Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js",
    substring: "v=this.reactiveStorageService.applicationUserPersistentStorage.cmdLineHookState",
    because: "the seeded cmdLineHookState may not stop the command-line toast",
  },
  {
    file: "Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js",
    substring: "!this.nativeWorkbenchEnvironmentService.isGlass&&!v.ignored&&v.timesShown<2",
    because: "the seeded cmdLineHookState may not stop the command-line toast",
  },
] as const

/** Cursor's application-scope storage key for its application-user reactive storage record. */
export const CURSOR_APPLICATION_USER_STORAGE_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser"

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

/** Throw unless the Cursor app at `appPath` still ships every pinned launch quirk. */
export function assertCursorBundlePinsShipped(appPath: string): void {
  const contents = new Map<string, string>()
  for (const pin of CURSOR_BUNDLE_PINS) {
    const path = join(appPath, pin.file)
    let text = contents.get(path)
    if (text === undefined) {
      try {
        text = readFileSync(path, "utf8")
      } catch (cause) {
        throw new Error(
          `${cursorVersion(appPath)}: cannot read ${path} to confirm the expected substring ${pin.substring}, without which ${pin.because}; refusing to launch Cursor into a covered terminal`,
          { cause },
        )
      }
      contents.set(path, text)
    }
    if (!text.includes(pin.substring)) {
      throw new Error(
        `${cursorVersion(appPath)}: ${path} no longer contains ${pin.substring}, so ${pin.because}; re-measure the bundle and update CURSOR_BUNDLE_PINS before launching Cursor`,
      )
    }
  }
}

/** Record Cursor's command-line prompt as dismissed ("Never show again") in a fresh user-data-dir's
 * application storage. `<userDataDir>/User` must exist; `User/globalStorage` must not. */
export function dismissCursorCommandLinePrompt(userDataDir: string): void {
  const directory = join(userDataDir, "User", "globalStorage")
  mkdirSync(directory, { mode: 0o700 })
  const database = new DatabaseSync(join(directory, "state.vscdb"))
  try {
    // Cursor's own schema; its CREATE TABLE IF NOT EXISTS leaves this table in place.
    database.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
    // Cursor fills every other application-user field from its defaults when it loads this record.
    database
      .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
      .run(CURSOR_APPLICATION_USER_STORAGE_KEY, JSON.stringify({ cmdLineHookState: { ignored: true, timesShown: 0 } }))
  } finally {
    database.close()
  }
}
