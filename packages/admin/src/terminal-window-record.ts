// #33152 (@cto 56e401d9 point 3; conditions and wording agreed with @dev/11, packet /hh/var/@dev11/33152/packet.md):
// the hosted Terminal.app run record carries the launch and the disposal of its owned window, or the job refuses by name.
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const LAUNCH_PROOF_KEY = "collector.windowLaunchProof"
/** Shared with the local daemon path, where presence alone marks a finalised draft (serve.ts). */
export const DISPOSAL_KEY = "collector.windowDisposal"
const LAUNCH_FILE = "terminal-launch.json"
const DISPOSAL_FILE = "terminal-window-disposal.json"
const WHO = "owned Terminal window"
/**
 * @cto 5c2b1f65 condition 3, written into the record: the launcher's single-owner rule
 * (terminal-app-receipt.ts, "Expected exactly one new single-tab Terminal window with returned TTY").
 */
const OWNER_RULE =
  "the one new single-tab window whose tty is the launched tty; any other new window, such as the cold start's startup window, carries another tty and is listed in newIds only"

interface NewWindow {
  windowId: number
  tabCount: number
  tty: string | null
}

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const isTTY = (value: unknown): value is string => typeof value === "string" && value.startsWith("/dev/")
const isIds = (value: unknown): value is number[] => Array.isArray(value) && value.every(isId)
const isNewWindows = (value: unknown): value is NewWindow[] =>
  Array.isArray(value) &&
  value.every(
    (row: unknown) =>
      typeof row === "object" &&
      row !== null &&
      isId((row as NewWindow).windowId) &&
      Number.isSafeInteger((row as NewWindow).tabCount) &&
      (typeof (row as NewWindow).tty === "string" || (row as NewWindow).tty === null),
  )

function read(path: string, file: string, refuse: (field: string, value: unknown) => never) {
  const bytes = readFileSync(path)
  let value: unknown
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    refuse("(file)", bytes.toString("utf8").slice(0, 80))
  }
  if (typeof value !== "object" || value === null) refuse("(file)", value)
  return { value: value as Record<string, unknown>, sha256: createHash("sha256").update(bytes).digest("hex"), file }
}

/**
 * Copy the launch census and the disposal readback, each with its side file's sha256, into run.json's rawReplies.
 * Every check runs before the one write, so a refusal leaves run.json exactly as the collector wrote it.
 * runId is written by the collector and never touched here.
 */
export function finaliseTerminalWindowRecord(out: string): void {
  const launchPath = join(out, LAUNCH_FILE)
  if (!existsSync(launchPath)) {
    // @chief: a launch that ran and recorded nothing is never reported as "no launch".
    const ran = existsSync(join(out, "launcher.log")) ? "; launcher.log shows the launch arm ran" : ""
    throw new Error(`${WHO}: ${LAUNCH_FILE} is absent, so this run opened no window it can name${ran}`)
  }
  const malformed = (field: string, value: unknown): never => {
    throw new Error(`${WHO}: ${LAUNCH_FILE} is malformed at ${field} (${JSON.stringify(value) ?? "undefined"})`)
  }
  const launch = read(launchPath, LAUNCH_FILE, malformed)
  const window = launch.value.terminalWindow as Record<string, unknown> | undefined
  const windowId = window?.windowId
  const tty = window?.tty
  if (!isId(windowId)) return malformed("terminalWindow.windowId", windowId)
  if (!isTTY(tty)) return malformed("terminalWindow.tty", tty)
  const { beforeIds, afterIds } = launch.value
  if (!isIds(beforeIds)) return malformed("beforeIds", beforeIds)
  if (!isIds(afterIds)) return malformed("afterIds", afterIds)
  const newIds = launch.value.newIds
  if (!isNewWindows(newIds)) return malformed("newIds", newIds)
  if (beforeIds.includes(windowId)) {
    throw new Error(
      `${WHO} ${windowId} was already present before the launch: before census held ${beforeIds.join(",")}`,
    )
  }
  if (!afterIds.includes(windowId)) malformed("afterIds", afterIds)
  // A cold start opens Terminal's startup window beside ours (run 42560226484): other new ids are recorded, not refused.
  const fresh = newIds.filter((row) => !beforeIds.includes(row.windowId) && afterIds.includes(row.windowId))
  const onTTY = fresh.filter((row) => row.tty === tty)
  if (onTTY.length > 1) {
    throw new Error(
      `${WHO}: two windows answer to the launched tty ${tty} (ids ${onTTY.map((row) => row.windowId).join(", ")})`,
    )
  }
  const [owned] = onTTY
  if (owned?.tabCount !== 1 || owned.windowId !== windowId) malformed("newIds", newIds)

  const disposalPath = join(out, DISPOSAL_FILE)
  if (!existsSync(disposalPath)) {
    throw new Error(`${WHO} ${windowId}: ${DISPOSAL_FILE} is absent, so the close is not proved`)
  }
  const disposal = read(disposalPath, DISPOSAL_FILE, (field, value): never => {
    throw new Error(
      `${WHO} ${windowId}: ${DISPOSAL_FILE} is malformed at ${field} (${JSON.stringify(value) ?? "undefined"})`,
    )
  })
  for (const [field, launched] of [
    ["windowId", windowId],
    ["tty", tty],
  ] as const) {
    if (disposal.value[field] !== launched) {
      throw new Error(`${WHO}: launch/disposal disagree on ${field}: ${launched} vs ${String(disposal.value[field])}`)
    }
  }
  const remaining = disposal.value.remaining
  if (!Number.isSafeInteger(remaining) || (remaining as number) < 0) {
    throw new Error(
      `${WHO} ${windowId}: ${DISPOSAL_FILE} is malformed at remaining (${JSON.stringify(remaining) ?? "undefined"})`,
    )
  }
  if (remaining !== 0) {
    throw new Error(`${WHO} ${windowId} survived its close: ${String(remaining)} windows still answer to that id`)
  }

  const runPath = join(out, "run.json")
  if (!existsSync(runPath)) {
    throw new Error(`${WHO} ${windowId}: run.json is absent, so no run record can carry the launch and the close`)
  }
  const run = JSON.parse(readFileSync(runPath, "utf8")) as { rawReplies?: Record<string, string> | null }
  if (typeof run.rawReplies !== "object" || run.rawReplies === null) {
    throw new Error(`${WHO} ${windowId}: run.json has no rawReplies, so it cannot carry the launch and the close`)
  }
  run.rawReplies[LAUNCH_PROOF_KEY] = JSON.stringify({
    windowId,
    tty,
    beforeIds,
    afterIds,
    newIds,
    owner: OWNER_RULE,
    source: LAUNCH_FILE,
    sha256: launch.sha256,
  })
  run.rawReplies[DISPOSAL_KEY] = JSON.stringify({
    windowId,
    tty,
    remaining,
    source: DISPOSAL_FILE,
    sha256: disposal.sha256,
  })
  writeFileSync(runPath, JSON.stringify(run, null, 2))
}

/** Placement: a hosted Terminal.app record without both structured entries cannot claim its owned window. */
export function assertTerminalWindowRecord(rawReplies: Record<string, string>, where: string): void {
  for (const [key, file] of [
    [LAUNCH_PROOF_KEY, LAUNCH_FILE],
    [DISPOSAL_KEY, DISPOSAL_FILE],
  ] as const) {
    const lacks = (): never => {
      throw new Error(
        `${where}: hosted Terminal.app record lacks ${key}, so it cannot claim an owned window opened and closed by this run`,
      )
    }
    // The local daemon path writes a proof sentence into collector.windowDisposal: not JSON, so not this record.
    let value: Record<string, unknown> | null
    try {
      value = JSON.parse(rawReplies[key] ?? "") as Record<string, unknown> | null
    } catch {
      return lacks()
    }
    if (value?.source !== file || typeof value.sha256 !== "string" || !isId(value.windowId)) lacks()
    if (key === LAUNCH_PROOF_KEY && !(isIds(value?.beforeIds) && isIds(value.afterIds) && isNewWindows(value.newIds))) {
      lacks()
    }
  }
}
