/**
 * Whether a run's launch is the terminal's DEFAULT configuration, as far as notifications go (#33333,
 * @cto a6fddd6e condition 4).
 *
 * The claim is launch-scoped on purpose. It asserts only what this run controls and records: the launch line
 * the launcher wrote into its own receipt, and, under tmux, the server's live `allow-passthrough` value. It
 * never speaks about a user's dotfiles, because the owned launch never reads them.
 */
export interface NotificationDefaultsReading {
  readonly state: "default" | "non-default" | "unknown"
  readonly reason: string
}

/**
 * A launch line that names any of these is not the app's default for notifications, so a silent target write
 * under it would describe a configuration we changed rather than the terminal as it ships.
 */
const NOTIFICATION_SETTING = /\b(notif\w*|bell\w*|allow-passthrough)\b/i

/** The value tmux's own default gives `allow-passthrough`: anything else is a modified pass-through. */
const PASSTHROUGH_DEFAULT = "off"

export function qualifyNotificationDefaults(input: {
  /** The exact command line this run launched, from the owned receipt. Absent: nothing to qualify. */
  readonly launchLine?: string
  /** Present only for a tmux run: the live server value, or why it could not be read. */
  readonly passthrough?: { readonly value: string } | { readonly reason: string }
}): NotificationDefaultsReading {
  const launchLine = input.launchLine?.trim()
  if (launchLine === undefined || launchLine === "") {
    return {
      state: "unknown",
      reason: "This run records no launch line, so the configuration it ran at cannot be stated",
    }
  }
  const named = NOTIFICATION_SETTING.exec(launchLine)
  if (named !== null) {
    return {
      state: "non-default",
      reason: `The owned launch names a notification setting (${named[0]}), so this is not the terminal's default configuration`,
    }
  }
  if (input.passthrough !== undefined) {
    if ("reason" in input.passthrough) {
      return {
        state: "unknown",
        reason: `The multiplexer's allow-passthrough value could not be read: ${input.passthrough.reason}`,
      }
    }
    const value = input.passthrough.value.trim()
    if (value !== PASSTHROUGH_DEFAULT) {
      return {
        state: "non-default",
        reason: `The multiplexer's allow-passthrough reads ${JSON.stringify(value)}, not its default ${JSON.stringify(PASSTHROUGH_DEFAULT)}, so a negative would describe a modified pass-through`,
      }
    }
    return {
      state: "default",
      reason:
        "The owned launch line names no notification setting and the multiplexer's allow-passthrough reads its default off",
    }
  }
  return {
    state: "default",
    reason: "The owned launch line names no notification setting, so this run is at the terminal's default configuration",
  }
}

/**
 * Read tmux's `allow-passthrough` from the owned server. A window option in current tmux, a session option in
 * none of them: try the window form, fall back once, and refuse by name instead of guessing a value.
 */
export async function readMuxAllowPassthrough(options: {
  readonly run: (args: readonly string[]) => Promise<string>
}): Promise<{ readonly value: string } | { readonly reason: string }> {
  const failures: string[] = []
  for (const args of [
    ["show-options", "-g", "-w", "-v", "allow-passthrough"],
    ["show-options", "-g", "-v", "allow-passthrough"],
  ]) {
    try {
      const value = (await options.run(args)).trim()
      if (value === "") {
        failures.push(`${args.join(" ")} returned nothing`)
        continue
      }
      return { value }
    } catch (error) {
      failures.push(`${args.join(" ")}: ${(error as Error).message}`)
    }
  }
  return { reason: failures.join("; ") }
}
