/**
 * @failure Terminal.app plist isolation allows profile or colour mutations in com.apple.Terminal.plist, or
 *   refuses AppKit's harmless `NSWindow Frame *` window-position autosave (@cto 03d0efca, #34080).
 * @level l1
 * @consumer Terminal.app owned collection beforeSave isolation proof (`app.ts`).
 * @testonly none
 */
import { describe, expect, test } from "vitest"
import {
  diffTerminalAppPlist,
  parseTopLevelPlistDictXml,
  verifyTerminalAppPlistIsolation,
  type TerminalAppPlistSnapshot,
} from "./terminal-app-plist.ts"

const BASE_PLIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Default Window Settings</key>
  <string>Clear Dark</string>
  <key>NSWindow Frame TTWindow</key>
  <string>964 536 860 499 0 0 1920 1049 </string>
  <key>NSWindow Frame TTWindow Clear Dark</key>
  <string>993 507 860 499 0 0 1920 1049 </string>
  <key>Window Settings</key>
  <dict>
    <key>Clear Dark</key>
    <dict>
      <key>BackgroundColor</key>
      <data>YnBsaXN0MDDUAQIDBAUG</data>
    </dict>
  </dict>
</dict>
</plist>`

const FRAME_ONLY_DIFF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Default Window Settings</key>
  <string>Clear Dark</string>
  <key>NSWindow Frame TTWindow</key>
  <string>964 536 860 499 0 0 1920 1049 </string>
  <key>Window Settings</key>
  <dict>
    <key>Clear Dark</key>
    <dict>
      <key>BackgroundColor</key>
      <data>YnBsaXN0MDDUAQIDBAUG</data>
    </dict>
  </dict>
</dict>
</plist>`

const PROFILE_MUTATED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Default Window Settings</key>
  <string>Clear Dark</string>
  <key>NSWindow Frame TTWindow</key>
  <string>964 536 860 499 0 0 1920 1049 </string>
  <key>Window Settings</key>
  <dict>
    <key>Clear Dark</key>
    <dict>
      <key>BackgroundColor</key>
      <data>TVVUQVRFRF9DT0xPUg==</data>
    </dict>
  </dict>
</dict>
</plist>`

const snap = (xml: string): TerminalAppPlistSnapshot => ({
  path: "/Users/codi/Library/Preferences/com.apple.Terminal.plist",
  present: true,
  entries: parseTopLevelPlistDictXml(xml),
})

describe("key-level com.apple.Terminal.plist isolation (@cto 03d0efca)", () => {
  test("passes when the plist is unchanged", () => {
    const before = snap(BASE_PLIST_XML)
    const after = snap(BASE_PLIST_XML)
    expect(verifyTerminalAppPlistIsolation(before, after)).toEqual({
      plistPath: before.path,
      beforePresent: true,
      afterPresent: true,
      allowedChangedKeys: [],
      disallowedChangedKeys: [],
    })
  })

  test("passes when only NSWindow Frame * keys change and names them in the receipt", () => {
    const before = snap(BASE_PLIST_XML)
    const after = snap(FRAME_ONLY_DIFF_XML)
    expect(diffTerminalAppPlist(before, after)).toEqual({
      allowedChangedKeys: ["NSWindow Frame TTWindow Clear Dark"],
      disallowedChangedKeys: [],
    })
    expect(verifyTerminalAppPlistIsolation(before, after)).toEqual({
      plistPath: before.path,
      beforePresent: true,
      afterPresent: true,
      allowedChangedKeys: ["NSWindow Frame TTWindow Clear Dark"],
      disallowedChangedKeys: [],
    })
  })

  test("fails loudly by key name when any non-NSWindow-Frame key changes", () => {
    const before = snap(BASE_PLIST_XML)
    const after = snap(PROFILE_MUTATED_XML)
    expect(diffTerminalAppPlist(before, after)).toEqual({
      allowedChangedKeys: ["NSWindow Frame TTWindow Clear Dark"],
      disallowedChangedKeys: ["Window Settings"],
    })
    expect(() => verifyTerminalAppPlistIsolation(before, after)).toThrow(
      /changed non-window-frame key\(s\): Window Settings/,
    )
  })
})
