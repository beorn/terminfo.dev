/** A null clipboard config is no claim. Hosted Mac provenance is a launcher string, or absent. */
export function clipboardConfigAgrees(
  provenance: { fixture: { config: string | null } } | undefined,
  clipboard: { config: string | null },
): void {
  if (!provenance || clipboard.config === null) return
  if (provenance.fixture.config !== clipboard.config) {
    throw new Error("Owned clipboard profile config differs from runtime provenance")
  }
}

export const CLIPBOARD_READ_ALLOWED_KEY = "collector.clipboardReadAllowed" as const
export const READ_ALLOWED_NOT_IN_FORCE = "read allowed by setting, not proved in force" as const

export interface XtermReadAllowedReadback {
  readonly target: "xterm"
  readonly method: "OSC 61 ; allowWindowOps ST"
  readonly sequence: "\x1b]61;allowWindowOps\x1b\\"
  readonly outbound: "\x1b]61;allowWindowOps\x1b\\\x1b[c"
  readonly reason: string
  readonly raw: string
  readonly rawBase64: string
  readonly disallowedWindowOps?: readonly string[]
  readonly getSelectionAbsent?: boolean
  readonly inForce: boolean
}

export interface AlacrittyReadAllowedReadback {
  readonly target: "alacritty"
  readonly method: "alacritty msg get-config -w -1"
  readonly command: readonly ["alacritty", "msg", "get-config", "-w", "-1"]
  readonly socket: string | null
  readonly exitStatus: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
  readonly osc52?: string
  readonly rawOsc52?: string
  readonly setting?: string
  readonly inForce: boolean
}

export type ClipboardReadAllowedReadback = XtermReadAllowedReadback | AlacrittyReadAllowedReadback

const XTERM_DISALLOWED_REPLY_RE = /\x1b\]61;([^\x07\x1b]*)(?:\x07|\x1b\\)/

/**
 * Parse xterm's XTQDISALLOWED (`OSC 61 ; allowWindowOps ST`) reply (#33134).
 * In force when xterm answers `OSC 61 ; <disallowedWindowOps> ST` and `GetSelection` is absent from the list.
 */
export function parseXtermReadAllowedReply(outcome: {
  readonly reason: string
  readonly raw: string
  readonly rawBase64: string
}): XtermReadAllowedReadback {
  const match = XTERM_DISALLOWED_REPLY_RE.exec(outcome.raw)
  if (!match || match[1] === undefined) {
    return {
      target: "xterm",
      method: "OSC 61 ; allowWindowOps ST",
      sequence: "\x1b]61;allowWindowOps\x1b\\",
      outbound: "\x1b]61;allowWindowOps\x1b\\\x1b[c",
      reason: outcome.reason,
      raw: outcome.raw,
      rawBase64: outcome.rawBase64,
      inForce: false,
    }
  }
  const disallowedWindowOps = match[1]
    .split(",")
    .map((op) => op.trim())
    .filter((op) => op.length > 0)
  const getSelectionAbsent = !disallowedWindowOps.includes("GetSelection")
  return {
    target: "xterm",
    method: "OSC 61 ; allowWindowOps ST",
    sequence: "\x1b]61;allowWindowOps\x1b\\",
    outbound: "\x1b]61;allowWindowOps\x1b\\\x1b[c",
    reason: outcome.reason,
    raw: outcome.raw,
    rawBase64: outcome.rawBase64,
    disallowedWindowOps,
    getSelectionAbsent,
    inForce: getSelectionAbsent,
  }
}

function canonicalAlacrittyOsc52(raw: string): string {
  switch (raw.toLowerCase()) {
    case "copypaste":
      return "CopyPaste"
    case "onlycopy":
      return "OnlyCopy"
    case "onlypaste":
      return "OnlyPaste"
    case "disabled":
      return "Disabled"
    default:
      return raw
  }
}

/**
 * Parse Alacritty 0.17.0's `alacritty msg get-config -w -1` output over `ALACRITTY_SOCKET` (#33134).
 * In force when `ALACRITTY_SOCKET` is present, the command exits 0, and `terminal.osc52` is `CopyPaste`
 * (serialized by Alacritty 0.17.0 as `"copypaste"`).
 */
export function parseAlacrittyReadAllowedConfig(input: {
  readonly socket: string | null | undefined
  readonly exitStatus: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}): AlacrittyReadAllowedReadback {
  const socket = typeof input.socket === "string" && input.socket.trim().length > 0 ? input.socket : null
  const base = {
    target: "alacritty" as const,
    method: "alacritty msg get-config -w -1" as const,
    command: ["alacritty", "msg", "get-config", "-w", "-1"] as const,
    socket,
    exitStatus: input.exitStatus,
    stdout: input.stdout,
    stderr: input.stderr,
    ...(input.error !== undefined && { error: input.error }),
  }
  if (!socket || input.exitStatus !== 0 || input.error !== undefined) {
    return { ...base, inForce: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(input.stdout)
  } catch (cause) {
    return {
      ...base,
      error: `Invalid JSON from alacritty msg get-config -w -1: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      inForce: false,
    }
  }
  const terminal =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).terminal
      : undefined
  const rawOsc52 =
    terminal !== null && typeof terminal === "object" && !Array.isArray(terminal)
      ? (terminal as Record<string, unknown>).osc52
      : undefined
  if (typeof rawOsc52 !== "string" || rawOsc52.trim().length === 0) {
    return { ...base, error: "alacritty msg get-config -w -1 returned no terminal.osc52 string", inForce: false }
  }
  const osc52 = canonicalAlacrittyOsc52(rawOsc52)
  const inForce = osc52 === "CopyPaste"
  return {
    ...base,
    osc52,
    rawOsc52,
    setting: `terminal.osc52 = ${osc52}`,
    inForce,
  }
}

/**
 * Verify whether a supplement run recorded a same-launch read-back proving the read-allowed setting in force (#33134).
 * Missing read-back returns the base `notInForce` reason; a contrary or failed read-back returns `notInForce` with
 * the specific recorded discrepancy so the cell stays open with its reason.
 */
export function verifyReadAllowedInForce(
  app: string,
  rawReplies: Readonly<Record<string, string>> | undefined,
  notInForce: string = READ_ALLOWED_NOT_IN_FORCE,
): { readonly inForce: true; readonly summary: string } | { readonly inForce: false; readonly reason: string } {
  const source = rawReplies?.[CLIPBOARD_READ_ALLOWED_KEY]
  if (typeof source !== "string" || source.trim().length === 0) {
    return { inForce: false, reason: notInForce }
  }
  let record: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(source)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { inForce: false, reason: `${notInForce} (malformed ${CLIPBOARD_READ_ALLOWED_KEY} record)` }
    }
    record = parsed as Record<string, unknown>
  } catch {
    return { inForce: false, reason: `${notInForce} (malformed ${CLIPBOARD_READ_ALLOWED_KEY} JSON)` }
  }
  if (app === "xterm") {
    if (record.target !== "xterm") {
      return {
        inForce: false,
        reason: `${notInForce} (recorded read-back targets ${String(record.target ?? "unknown")}, expected xterm)`,
      }
    }
    const reparsed = parseXtermReadAllowedReply({
      reason: typeof record.reason === "string" ? record.reason : "unknown",
      raw: typeof record.raw === "string" ? record.raw : "",
      rawBase64: typeof record.rawBase64 === "string" ? record.rawBase64 : "",
    })
    if (reparsed.disallowedWindowOps === undefined) {
      return {
        inForce: false,
        reason: `${notInForce} (OSC 61 ; allowWindowOps ST returned no disallowedWindowOps reply)`,
      }
    }
    if (
      !reparsed.inForce ||
      !reparsed.getSelectionAbsent ||
      record.inForce !== true ||
      record.getSelectionAbsent !== true
    ) {
      return {
        inForce: false,
        reason: `${notInForce} (OSC 61 ; allowWindowOps ST lists GetSelection in disallowedWindowOps: ${reparsed.disallowedWindowOps.join(",")})`,
      }
    }
    return {
      inForce: true,
      summary: `OSC 61 ; allowWindowOps ST disallowedWindowOps=${reparsed.disallowedWindowOps.join(",") || "(none)"} (GetSelection absent)`,
    }
  }
  if (app === "alacritty") {
    if (record.target !== "alacritty") {
      return {
        inForce: false,
        reason: `${notInForce} (recorded read-back targets ${String(record.target ?? "unknown")}, expected alacritty)`,
      }
    }
    const reparsed = parseAlacrittyReadAllowedConfig({
      socket: typeof record.socket === "string" ? record.socket : null,
      exitStatus: typeof record.exitStatus === "number" ? record.exitStatus : null,
      stdout: typeof record.stdout === "string" ? record.stdout : "",
      stderr: typeof record.stderr === "string" ? record.stderr : "",
      ...(typeof record.error === "string" && { error: record.error }),
    })
    if (!reparsed.socket) {
      return {
        inForce: false,
        reason: `${notInForce} (alacritty msg get-config -w -1 had no ALACRITTY_SOCKET)`,
      }
    }
    if (reparsed.exitStatus !== 0 || reparsed.error !== undefined) {
      return {
        inForce: false,
        reason: `${notInForce} (alacritty msg get-config -w -1 failed: ${
          reparsed.error ?? `exit ${String(reparsed.exitStatus)}`
        })`,
      }
    }
    if (!reparsed.inForce || reparsed.osc52 !== "CopyPaste" || record.inForce !== true) {
      return {
        inForce: false,
        reason: `${notInForce} (alacritty msg get-config -w -1 reported terminal.osc52 = ${
          reparsed.osc52 ?? "missing"
        }, expected CopyPaste)`,
      }
    }
    return {
      inForce: true,
      summary: "alacritty msg get-config -w -1 over ALACRITTY_SOCKET: terminal.osc52 = CopyPaste",
    }
  }
  return { inForce: false, reason: notInForce }
}
