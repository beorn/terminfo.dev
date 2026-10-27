import type { ConsoleBufferOwner } from "@terminfo/probe-defs"

/**
 * Why a text-evidence row is shown but not counted.
 *
 * @cto's ruling on 30033 (verdict f1f3c64b) rejected leaving the exclusion unexplained — option C —
 * because "an exclusion the site cannot explain reads as a terminal verdict". The two arms fail for
 * different reasons, so each names its own: Windows reads the console host's buffer rather than what
 * the terminal drew, and never decides; macOS reads the app's own text snapshot and may decide a
 * character claim only once that app's hosted run passes the five readback shapes.
 */
export interface TextEvidenceRead {
  readonly assertionType: string
  readonly conclusive: boolean
  readonly os: string
  /** The console host the cited run recorded, when it has one. */
  readonly host?: ConsoleBufferOwner
  readonly textQualificationReason?: string
}

export function textEvidenceExplanation(read: TextEvidenceRead | undefined): string | undefined {
  if (read === undefined || read.assertionType !== "buffer_state" || read.conclusive) return undefined
  if (read.os === "windows") {
    // When the run recorded the host, the page names it and prints the digest in full, so a reader
    // can check it rather than being told it exists somewhere (@cto ruling 6255e75d condition 3).
    if (read.host !== undefined) {
      return `Read as text from the console host’s buffer (${read.host.image}, ${read.host.executablePath}, ${read.host.executableSha256}), not from the cells the terminal drew — shown, not counted.`
    }
    return "Read as text from the console host that owns the window’s buffer, not from the cells the terminal drew — shown, not counted. The host is recorded in the run artifact."
  }
  if (read.os === "macos") {
    if (read.textQualificationReason !== undefined) {
      return `Read from the app’s own text snapshot — shown, not counted. ${read.textQualificationReason}`
    }
    return "Read from the app’s own text snapshot — shown, not counted. A conclusive text result requires a character-only claim declared by its suite and the same run’s five readback shapes."
  }
  return "Read as text rather than from the cells the terminal drew — shown, not counted."
}
