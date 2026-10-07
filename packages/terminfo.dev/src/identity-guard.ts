/**
 * Terminal identity guard — verifies that probed DA1 and XTVERSION responses
 * match the expected terminal before filing or accepting probe results.
 *
 * Prevents automated refreshes from filing results under the wrong terminal
 * (e.g. when a daemon from another terminal is running or launched as fallback).
 */

export interface TerminalIdentityRule {
  terminal: string
  da1Pattern?: RegExp
  da1ForbiddenPattern?: RegExp
  da2Pattern?: RegExp
  xtversionPattern?: RegExp
  requireXtversion?: boolean
  forbidXtversion?: boolean
}

export const TERMINAL_IDENTITY_RULES: Record<string, TerminalIdentityRule> = {
  kitty: {
    terminal: "kitty",
    da1Pattern: /\?62;/,
    da1ForbiddenPattern: /\?1;2c/,
    xtversionPattern: /^kitty\((?<version>\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.-]+)?)\)$/i,
    requireXtversion: true,
  },
  // Measured 2026-10-07 in xterm-visual-default-image: DA1 "?64;1;2;6;9;15;16;17;18;21;22;28;29c",
  // XTVERSION "XTerm(411)". iterm2 also answers ?64;; XTVERSION is what separates the two.
  xterm: {
    terminal: "xterm",
    da1Pattern: /\?64;/,
    xtversionPattern: /^XTerm\((?<version>\d+)\)$/,
    requireXtversion: true,
  },
  ghostty: {
    terminal: "ghostty",
    da1Pattern: /\?62;/,
    // Every admitted ghostty app run answers "ghostty 1.3.1" (2 of 2 in content/probes-apps,
    // 2026-10-07), so the prefix rule now captures the version it was only tolerating.
    xtversionPattern: /^ghostty v?(?<version>\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.-]+)?)$/i,
    requireXtversion: true,
  },
  iterm2: {
    terminal: "iterm2",
    da1Pattern: /\?64;/,
    xtversionPattern: /^iTerm2\b/i,
    requireXtversion: true,
  },
  warp: {
    terminal: "warp",
    da1Pattern: /\?62c/,
    xtversionPattern: /^Warp\(/i,
  },
  "terminal-app": {
    terminal: "terminal-app",
    da1Pattern: /\?1;2c/,
    da2Pattern: /^\x1b\[>1;95;0c(?:\x1b\[\?[0-9;]+c)?$/,
    forbidXtversion: true,
  },
}

export interface VerificationResult {
  ok: boolean
  reason?: string
  checked: boolean
}

const DA1_GRAMMAR = String.raw`\x1b\[\?[0-9;]+c`
const DA1_ONLY = new RegExp(`^${DA1_GRAMMAR}$`)
export const COMPLETE_XTVERSION = new RegExp(String.raw`^\x1bP>\|([^\x1b]+)\x1b\\(${DA1_GRAMMAR})?$`)

/** Owned identity is independent of the selected feature and never falls back on failure. */
export function deriveIdentity(responses: Record<string, string> | undefined): {
  source: "collector" | "feature"
  xtversionRaw?: string
  xtversionPayload?: string
  da1?: string
} {
  const source = responses && Object.hasOwn(responses, "collector.xtversion") ? "collector" : "feature"
  const raw = responses?.[source === "collector" ? "collector.xtversion" : "device.xtversion"]
  const complete = raw ? COMPLETE_XTVERSION.exec(raw) : null
  const da1Only = DA1_ONLY.test(raw ?? "")
  if (source === "collector" && raw && !complete && !da1Only) {
    throw new Error(`identity: XTVERSION preflight malformed, raw ${Buffer.from(raw).toString("base64")}`)
  }
  const collectorDa1 = source === "collector" ? (complete?.[2] ?? (da1Only ? raw : undefined)) : undefined
  const explicitDa1 = responses && Object.hasOwn(responses, "device.primary-da")
  const da1 = explicitDa1 ? responses["device.primary-da"] : collectorDa1
  if (explicitDa1 && source === "collector" && complete?.[2]) {
    if (!DA1_ONLY.test(da1 ?? "")) {
      throw new Error(`identity: DA1 malformed, raw ${Buffer.from(da1 ?? "").toString("base64")}`)
    }
    if (da1 !== collectorDa1) {
      throw new Error(
        `identity: DA1 mismatch, explicit ${JSON.stringify(da1)}, collector ${JSON.stringify(collectorDa1)}`,
      )
    }
  }
  return {
    source,
    xtversionRaw: raw,
    xtversionPayload: complete ? complete[1] : da1Only || raw?.startsWith("\x1bP") ? undefined : raw,
    da1,
  }
}

/**
 * A rule opts into measured-version resolution by naming its version capture `version` in
 * xtversionPattern. A rule without that group keeps the detected version, so an id we have not
 * measured resolves exactly as it did before (27874 launcher-target-family, @cto 1101133).
 */
function measuredVersionPattern(rule: TerminalIdentityRule | undefined): RegExp | undefined {
  return rule?.xtversionPattern?.source.includes("(?<version>") ? rule.xtversionPattern : undefined
}

/** Use only a complete measured reply; a detected version must agree with it. */
export function resolveMeasuredAppVersion(
  terminal: string,
  detectedVersion: string,
  responses: Record<string, string>,
): string {
  const normTerminal = terminal.toLowerCase().replace(/[^a-z0-9-]/g, "-")
  const rule = TERMINAL_IDENTITY_RULES[normTerminal] || TERMINAL_IDENTITY_RULES[terminal.toLowerCase()]
  const payloadPattern = measuredVersionPattern(rule)
  if (!payloadPattern) return detectedVersion || "unknown"
  const identity = deriveIdentity(responses)
  if (identity.source === "collector" && !identity.xtversionPayload) {
    throw new Error("identity: XTVERSION preflight silent")
  }
  // Legacy measured-version resolution requires the complete DCS, as before.
  if (identity.source === "feature" && !identity.xtversionRaw?.startsWith("\x1bP")) return detectedVersion || "unknown"
  const payload = identity.xtversionPayload
  if (!payload) return detectedVersion || "unknown"
  const version = payloadPattern.exec(payload)?.groups?.version
  if (!version) throw new Error(`${terminal} identity mismatch: measured XTVERSION ${payload}`)
  if (detectedVersion && detectedVersion !== version) {
    throw new Error(`${terminal} version mismatch: detected ${detectedVersion}, measured ${version}`)
  }
  return version
}

/**
 * Verify that DA1 and XTVERSION probe responses match the expected terminal identity.
 */
export function verifyTerminalIdentity(
  terminal: string,
  responses?: Record<string, string>,
  results?: Record<string, boolean>,
): VerificationResult {
  const normTerminal = terminal.toLowerCase().replace(/[^a-z0-9-]/g, "-")
  const rule = TERMINAL_IDENTITY_RULES[normTerminal] || TERMINAL_IDENTITY_RULES[terminal.toLowerCase()]

  if (!rule) {
    return { ok: false, checked: false, reason: `no identity profile for "${terminal}"` }
  }

  let identity: ReturnType<typeof deriveIdentity>
  try {
    identity = deriveIdentity(responses)
    if (rule.requireXtversion && identity.source === "collector" && !identity.xtversionPayload) {
      throw new Error("identity: XTVERSION preflight silent")
    }
  } catch (error) {
    return { ok: false, checked: true, reason: (error as Error).message }
  }
  const { da1, xtversionRaw, xtversionPayload: xtversion } = identity
  if (xtversionRaw?.startsWith("\x1bP") && !xtversion) {
    return { ok: false, checked: true, reason: `Terminal "${terminal}" returned an incomplete XTVERSION DCS frame` }
  }
  const xtversionResult = identity.source === "feature" ? results?.["device.xtversion"] : undefined

  // Check required XTVERSION
  if (rule.requireXtversion) {
    if (!xtversion || xtversion === "No XTVERSION response" || xtversionResult === false) {
      return {
        ok: false,
        checked: true,
        reason: `Terminal "${terminal}" requires an XTVERSION response, but received none or false`,
      }
    }
  }

  // Check forbidden XTVERSION
  if (rule.forbidXtversion) {
    if (xtversion && xtversion !== "No XTVERSION response") {
      return {
        ok: false,
        checked: true,
        reason: `Terminal "${terminal}" does not support XTVERSION, but received: "${xtversion}"`,
      }
    }
  }

  // Check XTVERSION pattern
  if (rule.xtversionPattern && typeof xtversion === "string" && xtversion !== "No XTVERSION response") {
    if (!rule.xtversionPattern.test(xtversion)) {
      return {
        ok: false,
        checked: true,
        reason: `Terminal "${terminal}" XTVERSION mismatch: expected ${rule.xtversionPattern}, got "${xtversion}"`,
      }
    }
  }

  // Check forbidden DA1 pattern
  if (rule.da1ForbiddenPattern && typeof da1 === "string") {
    if (rule.da1ForbiddenPattern.test(da1)) {
      return {
        ok: false,
        checked: true,
        reason: `Terminal "${terminal}" DA1 mismatch: forbidden pattern ${rule.da1ForbiddenPattern} matched "${da1}"`,
      }
    }
  }

  // Check required DA1 pattern
  if (rule.da1Pattern && !rule.da1Pattern.test(da1 ?? "")) {
    return {
      ok: false,
      checked: true,
      reason: `Terminal "${terminal}" DA1 mismatch: expected ${rule.da1Pattern}, got "${da1 ?? ""}"`,
    }
  }

  if (rule.da2Pattern && !rule.da2Pattern.test(responses?.["device.secondary-da"] ?? "")) {
    return {
      ok: false,
      checked: true,
      reason: `Terminal "${terminal}" DA2 mismatch: expected ${rule.da2Pattern}`,
    }
  }

  return { ok: true, checked: true }
}
