/**
 * The identity an owned history reader publishes beside its count: which pane or surface answered, and the
 * two tty facts that make the count attributable. It is path-free by construction — a run-specific socket
 * path or host path in a corpus record is the leak the operator has objected to (@cto 41fcd747), so the tty
 * is recorded by name and the executable by basename, and a separator that survives that is a refusal.
 */
export type OwnedHistorySurface = "wezterm" | "cmux" | "kitty" | "terminal-app"

export type OwnedHistoryIdentity = Readonly<{
  readonly surface: OwnedHistorySurface
  /** The pane, window or surface id this run read, as its own CLI named it. */
  readonly pane: string | null
  /** The tty the terminal lists for that pane, by name (`ttys004`, never `/dev/ttys004`). */
  readonly listedTty: string | null
  /** The tty this run measured for itself, by name. */
  readonly measuredTty: string | null
  /**
   * null when there is no tty pair to compare: never a claim that two absent ttys matched. Anything that
   * consumes this field must read null as NOT matched (a surface with no listed tty is unproven, not equal).
   */
  readonly ttyMatch: boolean | null
  /** Whether this run read through an explicit socket, or null where the reader has no socket. */
  readonly socketPresent: boolean | null
  /** The reader's executable, by basename only. */
  readonly executable: string | null
}>

export type OwnedHistoryReceipt =
  | Readonly<{ status: "recorded"; receipt: string }>
  | Readonly<{ status: "refused"; reason: string }>

const separator = /[\\/]/u

const trimmed = (value: string | undefined): string | null => {
  const text = (value ?? "").trim()
  return text === "" ? null : text
}

/** `/dev/ttys004` and `ttys004` name the same tty; the record keeps the name, never the device path. */
export const ttyName = (value: string | undefined): string | null => {
  const name = trimmed(value)
  return name === null ? null : name.replace(/^\/dev\//u, "")
}

/** `/Applications/WezTerm.app/Contents/MacOS/wezterm` records as `wezterm`. */
export const executableName = (value: string | undefined): string | null => {
  const path = trimmed(value)
  if (path === null) return null
  const parts = path.split(separator)
  return parts[parts.length - 1] ?? null
}

export function ownedHistoryReceipt(fields: {
  readonly surface: OwnedHistorySurface
  readonly pane?: string | undefined
  readonly listedTty?: string | undefined
  readonly measuredTty?: string | undefined
  readonly socketPresent?: boolean | undefined
  readonly executable?: string | undefined
}): OwnedHistoryReceipt {
  const listedTty = ttyName(fields.listedTty)
  const measuredTty = ttyName(fields.measuredTty)
  const identity = {
    surface: fields.surface,
    pane: trimmed(fields.pane),
    listedTty,
    measuredTty,
    ttyMatch: listedTty === null || measuredTty === null ? null : listedTty === measuredTty,
    socketPresent: fields.socketPresent === undefined ? null : fields.socketPresent,
    executable: executableName(fields.executable),
  } as const satisfies OwnedHistoryIdentity
  // The reduction above is total for the inputs we build; a separator that survives it means a value we do
  // not understand reached the record, so the count goes unread rather than published with a path in it.
  for (const [field, value] of Object.entries(identity)) {
    if (typeof value === "string" && separator.test(value)) {
      return {
        status: "refused",
        reason: `owned history receipt field ${field} still carries a path separator, so the count it names is not publishable`,
      }
    }
  }
  return { status: "recorded", receipt: JSON.stringify(identity) }
}
