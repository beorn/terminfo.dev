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
  xtversionPattern?: RegExp
  requireXtversion?: boolean
  forbidXtversion?: boolean
}

export const TERMINAL_IDENTITY_RULES: Record<string, TerminalIdentityRule> = {
  kitty: {
    terminal: "kitty",
    da1Pattern: /\?62;/,
    da1ForbiddenPattern: /\?1;2c/,
    xtversionPattern: /^kitty\(/i,
    requireXtversion: true,
  },
  ghostty: {
    terminal: "ghostty",
    da1Pattern: /\?62;/,
    xtversionPattern: /^ghostty\b/i,
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
    forbidXtversion: true,
  },
}

export interface VerificationResult {
  ok: boolean
  reason?: string
  checked: boolean
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
    // No specific rule registered for this terminal
    return { ok: true, checked: false }
  }

  const da1 = responses?.["device.primary-da"]
  const xtversionRaw = responses?.["device.xtversion"]
  const dcs = xtversionRaw?.startsWith("\x1bP")
    ? /^\x1bP>\|([^\x1b]+)\x1b\\(?:\x1b\[\?[0-9;]+c)?$/.exec(xtversionRaw)
    : null
  if (xtversionRaw?.startsWith("\x1bP") && !dcs) {
    return { ok: false, checked: true, reason: `Terminal "${terminal}" returned an incomplete XTVERSION DCS frame` }
  }
  const xtversion = dcs ? dcs[1] : xtversionRaw
  const xtversionResult = results?.["device.xtversion"]

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
    if (
      xtversion &&
      xtversion !== "No XTVERSION response" &&
      typeof xtversion === "string" &&
      xtversion.length > 0 &&
      xtversionResult !== false
    ) {
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
  if (rule.da1Pattern && typeof da1 === "string") {
    if (!rule.da1Pattern.test(da1)) {
      return {
        ok: false,
        checked: true,
        reason: `Terminal "${terminal}" DA1 mismatch: expected ${rule.da1Pattern}, got "${da1}"`,
      }
    }
  }

  return { ok: true, checked: true }
}
