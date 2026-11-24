/**
 * Key-level isolation check for `~/Library/Preferences/com.apple.Terminal.plist` (#34080, @cto 03d0efca).
 *
 * AppKit autosaves `NSWindow Frame *` keys in `com.apple.Terminal.plist` when Terminal.app opens and closes
 * windows, even with zero OSC writes, so a raw file sha256 fails on unrelated window-position saves. This
 * module converts the binary plist to XML via `/usr/bin/plutil -convert xml1 -o -`, compares every top-level
 * `<dict>` key before and after a run, and passes ONLY if every added/removed/modified key matches the one
 * named allow-list (`NSWindow Frame *`). Any other changed key (e.g. `Window Settings`, colors, profiles)
 * fails loudly by key name.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const TERMINAL_APP_PLIST_ALLOWED_KEY_PATTERN = /^NSWindow Frame /

/**
 * Replace any collecting-host home directory prefix (`/Users/<account>` or `/home/<account>`,
 * other than the shared `runner` account) with `~` before writing a receipt into a run record
 * that may be committed to `content/` (#30568, #34080).
 */
export function redactHostHomePaths(value: string): string {
  return value.replace(/(?<![\w.~-])\/(?:Users|home)\/(?!runner(?=[/"'\s\\]|$))[^/"'\s\\]+(?=[/"'\s\\]|$)/g, "~")
}

export interface TerminalAppPlistSnapshot {
  readonly path: string
  readonly present: boolean
  readonly entries: Readonly<Record<string, string>>
}

export interface TerminalAppPlistDiff {
  readonly allowedChangedKeys: readonly string[]
  readonly disallowedChangedKeys: readonly string[]
}

export interface TerminalAppPlistIsolationReceipt {
  readonly plistPath: string
  readonly beforePresent: boolean
  readonly afterPresent: boolean
  readonly allowedChangedKeys: readonly string[]
  readonly disallowedChangedKeys: readonly []
}

export function defaultTerminalAppPlistPath(homeDir = homedir()): string {
  return join(homeDir, "Library", "Preferences", "com.apple.Terminal.plist")
}

/**
 * Parse the top-level `<dict>` of an XML property list (`plutil -convert xml1`) into exact key -> raw XML value
 * entries without losing `<data>` blobs or nested structures.
 */
export function parseTopLevelPlistDictXml(xml: string): Record<string, string> {
  const plistStart = xml.indexOf("<plist")
  if (plistStart < 0) throw new Error("Terminal.app plist XML is missing a <plist> root element")
  const dictOpenMatch = /<dict(?:\s[^>]*)?>/.exec(xml.slice(plistStart))
  if (!dictOpenMatch) {
    if (/<dict\s*\/>/.test(xml.slice(plistStart))) return {}
    throw new Error("Terminal.app plist XML is missing a top-level <dict>")
  }
  let pos = plistStart + dictOpenMatch.index + dictOpenMatch[0].length
  const entries: Record<string, string> = {}

  const skipWhitespaceAndComments = (): void => {
    while (pos < xml.length) {
      const ws = /^\s+/.exec(xml.slice(pos))
      if (ws) {
        pos += ws[0].length
        continue
      }
      if (xml.startsWith("<!--", pos)) {
        const end = xml.indexOf("-->", pos + 4)
        if (end < 0) throw new Error("Terminal.app plist XML contains an unterminated comment")
        pos = end + 3
        continue
      }
      break
    }
  }

  const readElement = (): { tag: string; raw: string } => {
    skipWhitespaceAndComments()
    if (xml[pos] !== "<") {
      throw new Error(`Terminal.app plist XML expected '<' at offset ${pos}`)
    }
    const openMatch = /^<([A-Za-z0-9_:-]+)(?:\s[^>]*)?(\/?)>/.exec(xml.slice(pos))
    if (!openMatch) {
      throw new Error(`Terminal.app plist XML malformed element at offset ${pos}`)
    }
    const tag = openMatch[1] as string
    const selfClosing = openMatch[2] === "/"
    const start = pos
    pos += openMatch[0].length
    if (selfClosing) {
      return { tag, raw: xml.slice(start, pos) }
    }
    let depth = 1
    const tagRegex = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?(/?)>`, "g")
    tagRegex.lastIndex = pos
    while (depth > 0) {
      const match = tagRegex.exec(xml)
      if (!match) throw new Error(`Terminal.app plist XML unterminated <${tag}> starting at offset ${start}`)
      const isClose = match[1] === "/"
      const isSelfClose = match[2] === "/"
      if (isClose) depth -= 1
      else if (!isSelfClose) depth += 1
      pos = tagRegex.lastIndex
    }
    return { tag, raw: xml.slice(start, pos) }
  }

  while (pos < xml.length) {
    skipWhitespaceAndComments()
    if (xml.startsWith("</dict>", pos)) {
      return entries
    }
    const keyEl = readElement()
    if (keyEl.tag !== "key") {
      throw new Error(`Terminal.app plist XML expected <key> inside top-level <dict>, got <${keyEl.tag}>`)
    }
    const keyText = keyEl.raw
      .replace(/^<key[^>]*>/, "")
      .replace(/<\/key>$/, "")
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
    const valEl = readElement()
    entries[keyText] = valEl.raw.trim()
  }
  throw new Error("Terminal.app plist XML top-level <dict> was not closed")
}

/** Snapshot `com.apple.Terminal.plist` top-level keys via `/usr/bin/plutil -convert xml1 -o -`. */
export function snapshotTerminalAppPlist(plistPath = defaultTerminalAppPlistPath()): TerminalAppPlistSnapshot {
  if (!existsSync(plistPath)) {
    return { path: plistPath, present: false, entries: {} }
  }
  const result = spawnSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", plistPath], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error || result.signal || result.status !== 0) {
    const detail = result.error?.message ?? (String(result.stderr ?? "").trim() || `exit ${String(result.status)}`)
    throw new Error(`Terminal.app plist snapshot failed for ${plistPath}: ${detail}`)
  }
  return {
    path: plistPath,
    present: true,
    entries: parseTopLevelPlistDictXml(String(result.stdout ?? "")),
  }
}

/** Classify every added, removed, or modified top-level key against the `NSWindow Frame *` allow-list. */
export function diffTerminalAppPlist(
  before: TerminalAppPlistSnapshot,
  after: TerminalAppPlistSnapshot,
): TerminalAppPlistDiff {
  const allKeys = new Set<string>([...Object.keys(before.entries), ...Object.keys(after.entries)])
  const allowedChangedKeys: string[] = []
  const disallowedChangedKeys: string[] = []
  for (const key of [...allKeys].sort()) {
    if (before.entries[key] === after.entries[key]) continue
    if (TERMINAL_APP_PLIST_ALLOWED_KEY_PATTERN.test(key)) allowedChangedKeys.push(key)
    else disallowedChangedKeys.push(key)
  }
  return { allowedChangedKeys, disallowedChangedKeys }
}

/**
 * Verify that no non-`NSWindow Frame *` key changed in `com.apple.Terminal.plist` across a Terminal.app run
 * (@cto 03d0efca condition 1). Any other changed key fails loudly by name.
 */
export function verifyTerminalAppPlistIsolation(
  before: TerminalAppPlistSnapshot,
  after: TerminalAppPlistSnapshot,
): TerminalAppPlistIsolationReceipt {
  if (before.present && !after.present) {
    throw new Error(`Terminal.app plist isolation failed: ${before.path} disappeared during the run`)
  }
  const diff = diffTerminalAppPlist(before, after)
  if (diff.disallowedChangedKeys.length > 0) {
    throw new Error(
      `Terminal.app plist isolation failed: ${after.path} changed non-window-frame key(s): ${diff.disallowedChangedKeys.join(", ")}`,
    )
  }
  return {
    plistPath: redactHostHomePaths(after.path),
    beforePresent: before.present,
    afterPresent: after.present,
    allowedChangedKeys: diff.allowedChangedKeys,
    disallowedChangedKeys: [],
  }
}
