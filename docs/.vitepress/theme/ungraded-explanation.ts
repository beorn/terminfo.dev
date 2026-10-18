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
  readonly evidence: string
  readonly conclusive: boolean
  readonly os: string
}

export function textEvidenceExplanation(read: TextEvidenceRead | undefined): string | undefined {
  if (read === undefined || read.evidence !== "text" || read.conclusive) return undefined
  if (read.os === "windows") {
    return "Read as text from the console host that owns the window’s buffer, not from the cells the terminal drew — shown, not counted."
  }
  if (read.os === "macos") {
    return "Read from the app’s own text snapshot, not from the cells it drew — ungraded until that app’s hosted run passes the five readback shapes."
  }
  return "Read as text rather than from the cells the terminal drew — shown, not counted."
}
