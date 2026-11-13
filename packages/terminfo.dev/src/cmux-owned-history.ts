/**
 * The pinned cmux app's own retained history, read from the surface this run owns (31741 follow-up).
 *
 * cmux's socket answers only processes started inside the app — `socketControlMode: cmuxOnly`, measured on
 * the fleet Mac 2026-11-13 with the config file byte-identical before and after — so a read from a command
 * the run typed into its own surface reaches this instance and no other. Four further facts make it a
 * reading of THIS surface rather than "a cmux on this Mac": the run's nonce brackets the block it wrote, the
 * markers come back complete and in order, the config hash the run recorded at launch is unchanged, and the
 * surface id it acquired at grant. Every refusal is named and none of them is a grade.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { spawnSync } from "node:child_process"
import type { TerminalScrollbackReading } from "../../probe-defs/src/types.ts"

/** The app bundle's own CLI. cmux is macOS-only, so there is no second install this run could mean. */
export const CMUX_HISTORY_EXECUTABLE = "/Applications/cmux.app/Contents/MacOS/cmux"

/** Where cmux keeps the socket guard on this account. */
export function cmuxConfigPath(home: string): string {
  return join(home, ".config", "cmux", "cmux.json")
}

/** The five refusals the cmux arm can raise (@cto af8608c3 condition 2). Each is a probe failure, never a grade. */
export type CmuxRefusal =
  | "cmux-surface-not-owned"
  | "cmux-read-empty"
  | "cmux-marker-missing"
  | "cmux-markers-out-of-order"
  | "cmux-config-hash-changed"

export type CmuxRefused = Readonly<{ status: "refused"; refusal: CmuxRefusal; reason: string }>

/**
 * How this run proves the read is its own surface: a block of numbered markers it wrote (probe arms that
 * write their own fixture), or the single nonce line it wrote before reading (the ordinary owned arm).
 */
export type CmuxOwnership =
  | Readonly<{ kind: "markers"; prefix: string; count: number; nonce: string }>
  | Readonly<{ kind: "nonce"; nonce: string }>
  // Ownership was proved once at grant; this read only names the surface and must not write.
  | Readonly<{ kind: "surface" }>

/**
 * The cmux CLI that can read an OWNED surface's history, or undefined when this run owns no cmux surface.
 * A declared path counts only when it is absolute: a relative or empty declaration is not a program this
 * run chose, and answering through it would hand an untrusted binary the run's own socket.
 */
export function ownedCmuxHistoryExecutable(input: {
  readonly platform: string
  readonly ownsCmuxSurface: boolean
  readonly declaredExecutable?: string | undefined
}): string | undefined {
  if (!input.ownsCmuxSurface || input.platform !== "darwin") return undefined
  const declared = input.declaredExecutable
  if (declared === undefined) return CMUX_HISTORY_EXECUTABLE
  return declared.trim() !== "" && isAbsolute(declared) ? declared : undefined
}

export type CmuxExecutableProof = Readonly<{
  path: string
  sha256: string
  /** The version the app reports about itself. Never a version borrowed from a release note. */
  version: string
}>

/**
 * Pin the CLI the run reads through: its path, its bytes and the version the app reports about itself. The
 * WezTerm contract (@cto af8608c3): a reader with no version behind it is an unmeasured identity that names
 * its reason, never a version invented from the bundle and never a null passed off as one.
 */
export function cmuxExecutableProof(
  executable: string,
):
  | { readonly status: "measured"; readonly proof: CmuxExecutableProof }
  | { readonly status: "unmeasured"; readonly reason: string } {
  try {
    const sha256 = createHash("sha256").update(readFileSync(executable)).digest("hex")
    const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5000 })
    const reported =
      result.status === 0 && typeof result.stdout === "string" ? (result.stdout.split("\n")[0] ?? "").trim() : ""
    if (result.error !== undefined || result.signal != null || result.status !== 0 || reported === "") {
      return {
        status: "unmeasured",
        reason:
          "cmux CLI " +
          JSON.stringify(executable) +
          " reported no version (sha256 " +
          sha256 +
          "; exit " +
          String(result.status) +
          ")",
      }
    }
    return { status: "measured", proof: { path: executable, sha256, version: reported } }
  } catch (error) {
    return {
      status: "unmeasured",
      reason:
        "cmux CLI " +
        JSON.stringify(executable) +
        " could not be read: " +
        (error instanceof Error ? error.message : String(error)),
    }
  }
}

export type CmuxHistoryIdentity = Readonly<{
  historyReadsThroughCli: true
  historyExecutable?: CmuxExecutableProof
  historyExecutableUnmeasured?: string
}>

/** What the arm records about the CLI it reads through: a measured proof, or the named reason it has none. */
export function cmuxHistoryIdentity(executable: string | undefined): CmuxHistoryIdentity | undefined {
  if (executable === undefined) return undefined
  const proof = cmuxExecutableProof(executable)
  return proof.status === "measured"
    ? { historyExecutable: proof.proof, historyReadsThroughCli: true }
    : { historyReadsThroughCli: true, historyExecutableUnmeasured: proof.reason }
}

const lines = (transcript: string): readonly string[] => {
  const split = transcript.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
  return split.length > 0 && split[split.length - 1] === "" ? split.slice(0, -1) : split
}

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

/**
 * Condition 3 of the plan: the read is graded by the marker lines this probe wrote — every one present,
 * exactly once, in the order it was written — not by how many lines came back. Lines that are neither
 * markers nor this run's sentinels are carried verbatim instead of dropped, so the measured delta (a fresh
 * surface prints its login banner and prompt before the block) stays visible in the run record.
 */
export function cmuxMarkerProof(input: {
  readonly transcript: string
  readonly prefix: string
  readonly count: number
  readonly nonce: string
}): { readonly status: "graded"; readonly markers: number; readonly extras: readonly string[] } | CmuxRefused {
  const rows = lines(input.transcript)
  if (rows.length === 0 || input.transcript.trim() === "") {
    return { status: "refused", refusal: "cmux-read-empty", reason: "cmux read returned no lines" }
  }
  if (input.nonce.trim() === "") {
    return {
      status: "refused",
      refusal: "cmux-surface-not-owned",
      reason: "the run has no nonce, so no returned line can be shown to be this run's block",
    }
  }
  const begin = `CMUX-${input.nonce}-BEGIN`
  const end = `CMUX-${input.nonce}-END`
  const opens = rows.reduce((total, line) => total + (line === begin ? 1 : 0), 0)
  const closes = rows.reduce((total, line) => total + (line === end ? 1 : 0), 0)
  if (opens !== 1 || closes !== 1) {
    return {
      status: "refused",
      refusal: "cmux-surface-not-owned",
      reason: `this run's sentinels appear ${opens} and ${closes} times; a block it wrote has one of each`,
    }
  }
  const marker = new RegExp(`^${escaped(input.prefix)}(\\d+)$`, "u")
  const read = rows.flatMap((line, index) => {
    const matched = marker.exec(line)
    return matched === null ? [] : [{ index, value: Number(matched[1]) }]
  })
  const opening = rows.indexOf(begin)
  const closing = rows.indexOf(end)
  const first = read.at(0)
  const last = read.at(-1)
  if (first === undefined || last === undefined || opening > first.index || closing < last.index) {
    return {
      status: "refused",
      refusal: "cmux-surface-not-owned",
      reason: "the marker block is not bracketed by this run's own sentinels, so it is not this surface's history",
    }
  }
  const seen = new Map<number, number>()
  for (const entry of read) seen.set(entry.value, (seen.get(entry.value) ?? 0) + 1)
  for (let id = 1; id <= input.count; id += 1) {
    const count = seen.get(id) ?? 0
    if (count !== 1) {
      return {
        status: "refused",
        refusal: "cmux-marker-missing",
        reason: `${input.prefix}${id} came back ${count} times; the probe wrote it once`,
      }
    }
  }
  const firstBroken = read.findIndex((entry, index) => entry.value !== index + 1)
  if (firstBroken !== -1 || read.length !== input.count) {
    const at = firstBroken === -1 ? read.length : firstBroken
    return {
      status: "refused",
      refusal: "cmux-markers-out-of-order",
      reason: `marker ${at + 1} of ${input.count} is ${input.prefix}${read[at]?.value ?? "absent"}, not ${input.prefix}${at + 1}`,
    }
  }
  const extras = rows.filter((line) => line !== begin && line !== end && marker.exec(line) === null)
  return { status: "graded", markers: read.length, extras }
}

/**
 * The ownership proof of the arm that has no block of its own: the run writes ONE line into the surface it
 * is running in (`CMUX-<nonce>-BEGIN`) and the read must contain it. A read that cannot find the line is a
 * read of some other surface, or of none; a duplicate means two surfaces answered, which is not a reading.
 * Unlike the marker proof this needs no expected count, so the ordinary probe arm can use it.
 */
export function cmuxNonceProof(input: {
  readonly transcript: string
  readonly nonce: string
}): { readonly status: "graded"; readonly extras: readonly string[] } | CmuxRefused {
  const rows = lines(input.transcript)
  if (rows.length === 0 || input.transcript.trim() === "") {
    return { status: "refused", refusal: "cmux-read-empty", reason: "cmux read returned no lines" }
  }
  if (input.nonce.trim() === "") {
    return {
      status: "refused",
      refusal: "cmux-surface-not-owned",
      reason: "the run has no nonce, so no returned line can be shown to be this run's own output",
    }
  }
  const marker = `CMUX-${input.nonce}-BEGIN`
  const seen = rows.reduce((total, line) => total + (line === marker ? 1 : 0), 0)
  if (seen !== 1) {
    return {
      status: "refused",
      refusal: "cmux-surface-not-owned",
      reason: `this run's sentinel appears ${seen} times in the read; a surface it wrote to shows it once`,
    }
  }
  return { status: "graded", extras: rows.filter((line) => line !== marker) }
}

/**
 * The socket guard, as the run can actually observe it. `cmuxOnly` is the app's own rule; what the run must
 * prove is that the rule did not move under it, and a fresh runner may have no config file at all. Absent at
 * launch and absent after is an honest observation ("no file to change"); one side absent and the other
 * present is a change; an unreadable file or an unrecorded launch leaves the guard unproven and refuses.
 */
export type CmuxConfigObservation =
  | Readonly<{ read: "present"; sha256: string }>
  | Readonly<{ read: "absent" }>
  | Readonly<{ read: "unreadable"; reason: string }>

export function observeCmuxConfig(path: string): CmuxConfigObservation {
  try {
    return { read: "present", sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { read: "absent" }
    return {
      read: "unreadable",
      reason: `cmux config ${JSON.stringify(path)} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function cmuxConfigGuard(input: {
  readonly atLaunch: CmuxConfigObservation | undefined
  readonly afterRun: CmuxConfigObservation | undefined
}): { readonly status: "unchanged"; readonly observed: "present" | "absent" } | CmuxRefused {
  const refuse = (reason: string): CmuxRefused => ({ status: "refused", refusal: "cmux-config-hash-changed", reason })
  const launch = input.atLaunch
  const after = input.afterRun
  if (launch === undefined) return refuse("cmux config was not observed at launch, so cmuxOnly is unproven")
  if (after === undefined) return refuse("cmux config was not observed after the run, so cmuxOnly is unproven")
  if (launch.read === "unreadable") return refuse(launch.reason)
  if (after.read === "unreadable") return refuse(after.reason)
  if (launch.read !== after.read) {
    return refuse(`cmux config went from ${launch.read} at launch to ${after.read} after the run`)
  }
  if (launch.read === "present" && after.read === "present" && launch.sha256 !== after.sha256) {
    return refuse(`cmux config changed during the run: ${launch.sha256} became ${after.sha256}`)
  }
  return { status: "unchanged", observed: launch.read }
}

export type OwnedCmuxRead =
  | Readonly<{ status: "read"; reading: TerminalScrollbackReading; receipt: string }>
  | CmuxRefused

type CommandOutcome = Readonly<{
  status: number | null
  signal?: NodeJS.Signals | null
  error?: Error
  stdout?: Buffer | string | null
  stderr?: Buffer | string | null
}>

const text = (value: Buffer | string | null | undefined): string =>
  value == null ? "" : Buffer.isBuffer(value) ? value.toString("utf8") : value

/**
 * Read the surface this run owns. The surface is named when the run knows it, so a second surface in the
 * same instance cannot answer for ours; when it is absent the CLI's own caller-surface rule applies, which
 * the inside-surface measurement exercised (300 lines written, 302 returned, stderr empty).
 *
 * Unreported fields stay absent: cmux answers no viewport offset and no capacity, so `viewportOffset` and
 * `capacity` are never inferred from the line count.
 */
export function readOwnedCmuxHistory(options: {
  readonly executable: string
  readonly surface?: string | undefined
  readonly rows?: number | undefined
  readonly ownership: CmuxOwnership
  readonly configAtLaunch: CmuxConfigObservation | undefined
  readonly observeConfig: () => CmuxConfigObservation
  readonly spawn?: (args: readonly string[]) => CommandOutcome
}): OwnedCmuxRead {
  const args = [
    "read-screen",
    ...(options.surface === undefined ? [] : ["--surface", options.surface]),
    "--scrollback",
  ] as const
  const result =
    options.spawn === undefined
      ? spawnSync(options.executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 })
      : options.spawn(args)
  const stdout = text(result.stdout)
  const stderr = text(result.stderr)
  // The command's own output goes to the collector's stderr log; the published reason stays value-free
  // except for the one diagnostic a reader needs, which cmux writes at phrase length.
  if (stderr.trim() !== "") console.error(`cmux read-screen: ${stderr.trim()}`)
  const succeeded = result.error === undefined && result.signal == null && result.status === 0
  if (succeeded && stdout.trim() === "") {
    return { status: "refused", refusal: "cmux-read-empty", reason: "cmux read-screen returned no lines" }
  }
  if (!succeeded) {
    return {
      status: "refused",
      refusal: "cmux-surface-not-owned",
      reason: `cmux read-screen answered nothing this run may read (${result.error?.message ?? result.signal ?? `exit ${result.status}`})`,
    }
  }
  const proof =
    options.ownership.kind === "surface"
      ? { status: "graded" as const, extras: undefined }
      : options.ownership.kind === "markers"
        ? cmuxMarkerProof({
            transcript: stdout,
            nonce: options.ownership.nonce,
            prefix: options.ownership.prefix,
            count: options.ownership.count,
          })
        : options.ownership.kind === "nonce"
          ? cmuxNonceProof({ transcript: stdout, nonce: options.ownership.nonce })
          : undefined
  if (proof !== undefined && proof.status === "refused") return proof
  const guard = cmuxConfigGuard({ atLaunch: options.configAtLaunch, afterRun: options.observeConfig() })
  if (guard.status === "refused") return guard
  const totalLines = lines(stdout).length
  return {
    status: "read",
    reading: { totalLines, ...(options.rows === undefined ? {} : { screenLines: options.rows }) },
    receipt: JSON.stringify({
      surface: options.surface ?? null,
      ownership: options.ownership.kind,
      markers: proof !== undefined && "markers" in proof ? proof.markers : null,
      extras: proof?.extras ?? null,
      totalLines,
      screenLines: options.rows ?? null,
      config:
        options.configAtLaunch === undefined
          ? "unrecorded"
          : options.configAtLaunch.read === "present"
            ? { read: "present", sha256: options.configAtLaunch.sha256 }
            : { read: options.configAtLaunch.read },
    }),
  }
}
