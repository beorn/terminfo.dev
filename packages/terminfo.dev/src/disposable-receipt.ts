import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { PLACEHOLDER, parseAppLaunchReceipt } from "../../run-parser/src/app-launch.ts"
import type {
  AppLaunchReceipt,
  DarwinMuxAttachmentProof,
  LinuxMuxAttachmentProof,
  MuxAttachmentProof,
} from "@terminfo/probe-defs"

/**
 * A disposable-ownership receipt is what authorizes mutate+readback against a terminal (27832).
 * Only a receipt that names a kind whose terminal is provably not a person's may enable a write:
 * a Linux Xvfb container the apparatus creates, runs once and removes, or a GitHub-hosted runner
 * whose VM is shown never to be reused. An absent, unparsable or foreign receipt leaves the
 * untouched default path; nothing here accepts a flag or a caller option in place of a receipt.
 *
 * The collector verifies this ONCE, before its first write, and records the kind and the digest;
 * it is never a per-probe decision.
 *
 * WHAT THESE CHECKS PROVE: CONSISTENCY, not ORIGIN (27874). They prove the bytes are present and
 * hash to the digest the run cites, that the receipt binds to the run's own detected target, and
 * that the identity fields are not degenerate. They do NOT prove where the receipt came from: a
 * hand-written receipt with random-looking digests passes every one of them, and `arch` is only a
 * floor (amd64 | arm64). Origin is the apparatus handoff (launcher-target-family): a receipt the
 * apparatus wrote OUTSIDE the measured environment, handed to the collector read-only, and refused
 * if the measured environment rewrote it. Do not name a check here "verify" if it cannot verify.
 */
export type DisposableKind = "linux-xvfb-container" | "github-hosted-runner"

/** 27910 CTO amendment 1: one source/scope authority for producer and admission. Image constants
 * are provenance, never non-reuse witnesses. Linux retains its ratified machine/platform set.
 * Darwin's en0 MAC qualified in two fresh jobs of run 37583024982 (stable within, different across).
 * That bounded probe did not exercise a reboot; the VM scope follows the ruling's outcome A. */
export const HOSTED_IDENTITY_SOURCES = {
  Linux: {
    sources: {
      machineIdSha256: { source: "/etc/machine-id", scope: "vm" },
      productUuidSha256: { source: "/sys/class/dmi/id/product_uuid", scope: "vm" },
      bootIdSha256: { source: "/proc/sys/kernel/random/boot_id", scope: "boot" },
    },
    nonReuse: ["machineIdSha256", "productUuidSha256"],
  },
  macOS: {
    sources: {
      machineIdSha256: {
        source: "en0 MAC",
        scope: "vm",
        command: "ifconfig",
        args: ["en0"],
        pattern: "\\bether\\s+([0-9a-f:]{17})\\b",
      },
      productUuidSha256: {
        source: "IOPlatformUUID",
        scope: "image",
        command: "ioreg",
        args: ["-rd1", "-c", "IOPlatformExpertDevice"],
        pattern: '"IOPlatformUUID"\\s*=\\s*"([^"\\n]+)"',
      },
      bootIdSha256: {
        source: "kern.bootsessionuuid",
        scope: "boot",
        command: "sysctl",
        args: ["-n", "kern.bootsessionuuid"],
        pattern: "^(\\S+)\\s*$",
      },
    },
    nonReuse: ["machineIdSha256", "bootIdSha256"],
  },
  /** 27931: run 37591243907, two fresh jobs, two samples 63 s apart each. NIC MAC and SMBIOS UUID
   * were stable within each job and different across jobs. MachineGuid was identical across jobs
   * (image), so it is excluded. The probe did not exercise a reboot. */
  Windows: {
    sources: {
      machineIdSha256: {
        source: "primary NIC MAC",
        scope: "vm",
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-Command",
          "Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Sort-Object ifIndex | Select-Object -First 1 -ExpandProperty MacAddress",
        ],
        pattern:
          "^([0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2})\\s*$",
      },
      productUuidSha256: {
        source: "SMBIOS UUID",
        scope: "vm",
        command: "powershell.exe",
        args: ["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystemProduct).UUID"],
        pattern: "^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\\s*$",
      },
      bootIdSha256: {
        source: "Win32_OperatingSystem.LastBootUpTime",
        scope: "boot",
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
        ],
        pattern: "^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z)\\s*$",
      },
    },
    nonReuse: ["machineIdSha256", "productUuidSha256"],
  },
} as const

/** What a ratified source entry must carry for the hosted producer to measure it. Declared here so
 * the sampler reads typed fields instead of widening the ratified table to `any`. */
interface HostedSource {
  readonly source: string
  readonly scope: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly pattern?: string
}

/** The one identity sampler. The hosted producer runs pre-checkout with Node's type
 * stripping, so this module keeps to Node built-ins and the parser it already imports. The caller
 * supplies the environment reader: which variables exist is the producer's policy, never this
 * module's, and no value is ever invented when a ratified source returns nothing. */
export function sampleHostedIdentity(required: (key: string) => string): Record<string, string> {
  const os = required("RUNNER_OS")
  if (!Object.hasOwn(HOSTED_IDENTITY_SOURCES, os)) {
    throw new Error(
      `Hosted receipt has no producer for RUNNER_OS=${JSON.stringify(os)}; ratified entries are ${Object.keys(HOSTED_IDENTITY_SOURCES).join(", ")}`,
    )
  }
  return sampleIdentity(os as keyof typeof HOSTED_IDENTITY_SOURCES, "Hosted receipt", true)
}

/** The same sources, sampled on a host the caller owns. The os is the caller's explicit argument,
 * never a hosted-runner variable, and nothing it prints claims a hosted runner or the hosted
 * scopes (vm, image): those describe disposable runners, not an owned machine. */
export function sampleOwnedHostIdentity(os: string): Record<string, string> {
  if (!Object.hasOwn(HOSTED_IDENTITY_SOURCES, os)) {
    throw new Error(
      `Owned host identity has no source table for os ${JSON.stringify(os)}; known entries are ${Object.keys(HOSTED_IDENTITY_SOURCES).join(", ")}`,
    )
  }
  return sampleIdentity(os as keyof typeof HOSTED_IDENTITY_SOURCES, "Owned host identity", false)
}

function sampleIdentity(
  os: keyof typeof HOSTED_IDENTITY_SOURCES,
  subject: string,
  hosted: boolean,
): Record<string, string> {
  const ratified = HOSTED_IDENTITY_SOURCES[os] as {
    sources: Record<string, HostedSource>
  }
  return Object.fromEntries(
    Object.entries(ratified.sources).map(([field, source]) => {
      const { command, args, pattern } = source
      if (command === undefined || args === undefined || pattern === undefined) {
        throw new Error(
          `${subject} ${field}: source ${source.source} ${hosted ? "is not produced by the hosted producer" : "has no command to measure it"}`,
        )
      }
      const result = spawnSync(command, [...args], { encoding: "utf8" })
      if (result.error || result.status !== 0) {
        throw new Error(
          `${subject} ${field}: ${command} failed with exit ${result.status}, signal ${result.signal}; cannot measure ${source.source}`,
        )
      }
      const value = new RegExp(pattern).exec(result.stdout)?.[1]
      if (!value) {
        throw new Error(`${subject} ${field}: ${source.source} returned no value; no identity is substituted`)
      }
      if (/^(0{8}-0{4}-0{4}-0{4}-0{12}|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$/.test(value)) {
        throw new Error(
          `${subject} ${field}: ${source.source} returned degenerate UUID (all-zero or all-F); refusing by name`,
        )
      }
      if (/^00[:-]00[:-]00[:-]00[:-]00[:-]00$/.test(value)) {
        throw new Error(`${subject} ${field}: ${source.source} returned degenerate all-zero MAC; refusing by name`)
      }
      const hash = createHash("sha256").update(value).digest("hex")
      const label = `${command} ${args.join(" ")}`
      const scope = hosted ? ` · ${source.scope}` : ""
      process.stderr.write(`${field}: ${label}${scope} · ${Buffer.byteLength(value)} bytes · sha256:${hash}\n`)
      return [field, hash]
    }),
  )
}

/** The transport receipt's kind. It records where a run started and what bytes it moved; it grants
 * nothing, so parsing it as disposable authority is refused by name rather than as an unknown kind. */
export const TRANSPORT_RECEIPT_KIND = "owned-app-transport"

export interface ReceiptTarget {
  kind: string
  id: string
  os: string
}

export interface DisposableReceipt {
  kind: DisposableKind
  runId: string
  collectedAt: string
  /** What the receipt says it measured, when its kind declares one. The collector binds this to the
   * run the receipt authorizes, so a receipt for one target cannot enable writes against another. */
  declaredTarget?: ReceiptTarget
  /** The identity the receipt names, when its kind declares one, so a reader on main can see what
   * the claim rests on instead of only a digest of bytes it cannot read (27874). */
  identity?: ContainerIdentity
  /** sha256 of the exact bytes the verdict was read from, so a run names the receipt it trusted. */
  sha256: string
  /** The launch receipt the apparatus measured, validated by the ONE parser run-parser validates
   * with, for the collector to copy into origin.appLaunch without adding or editing a field. A kind
   * whose production flow measures no launch (Linux, Windows) carries none, and says so by absence. */
  appLaunch?: AppLaunchReceipt
}

/** Every identity field a container receipt names, as the launcher wrote it. None is derived here:
 * this is the receipt's own claim, recorded verbatim so it can be read beside the run it authorizes. */
export interface ContainerIdentity {
  imageId: string
  imageTarSha256: string
  arch: string
  nixLockRevision: string
  frozenRunnerSha256: string
  buildReceiptSha256: string
}

const RUN_ID = /^[0-9a-f]{32}$/
const DIGEST = /^[0-9a-f]{64}$/
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const CLIPBOARD_PROFILES = ["default", "allow", "deny-read"] as const
/** The architectures `docker inspect` reports for the container the launcher loads, and asserts. */
const CONTAINER_ARCHES = ["amd64", "arm64"] as const
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(where: string, detail: string): never {
  throw new Error(`Disposable ownership receipt (${where}): ${detail}`)
}

function object(source: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const value = source[key]
  if (!isRecord(value)) fail(where, `${key} must be an object`)
  return value
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== "string" || value === "") fail(where, `${key} must be a non-empty string`)
  return value
}

function digest(source: Record<string, unknown>, key: string, where: string): string {
  const value = text(source, key, where)
  if (!DIGEST.test(value)) fail(where, `${key} must be a sha256 digest`)
  return value
}

/** A value the apparatus derived from bytes. It must carry real entropy: a placeholder is refused
 * by name, because admitting one is admitting a receipt nothing derived (27874). */
function measured(
  source: Record<string, unknown>,
  key: string,
  where: string,
  options: { digest?: boolean; scheme?: boolean } = {},
): string {
  const value = text(source, key, where)
  let bare = value
  if (options.scheme) {
    if (!value.startsWith("sha256:")) fail(where, `${key} must name its scheme, sha256:…`)
    bare = value.slice("sha256:".length)
  }
  if (options.digest && !DIGEST.test(bare)) fail(where, `${key} must be a sha256 digest`)
  if (PLACEHOLDER.test(bare)) {
    fail(where, `${key} is a placeholder: one repeated character, so no bytes were measured`)
  }
  return value
}

function oneOf(source: Record<string, unknown>, key: string, allowed: readonly string[], where: string): string {
  const value = text(source, key, where)
  if (!allowed.includes(value)) fail(where, `${key} must be one of ${allowed.join(", ")}`)
  return value
}

/** D3 (@cto 6710987a): `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>` to whole epoch seconds. Anything but
 * one C-locale UTC instant refuses by name: no sub-second reader is measured, so none is offered. */
const LS_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const LS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
export function parseLstart(raw: string): number {
  const match =
    /^ *(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ 1-3][0-9]|[1-9]) ([0-2][0-9]):([0-5][0-9]):([0-5][0-9]) ([0-9]{4}) *\n?$/.exec(
      raw,
    )
  if (!match) throw new Error(`lstart ${JSON.stringify(raw)} is not one C-locale "Www Mmm dd hh:mm:ss yyyy" line`)
  const [, weekday, month, day, hour, minute, second, year] = match
  const monthIndex = LS_MONTHS.indexOf(month ?? "")
  const ms = Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second))
  const at = new Date(ms)
  if (
    at.getUTCFullYear() !== Number(year) ||
    at.getUTCMonth() !== monthIndex ||
    at.getUTCDate() !== Number(day) ||
    at.getUTCHours() !== Number(hour) ||
    LS_WEEKDAYS[at.getUTCDay()] !== weekday
  ) {
    throw new Error(`lstart ${JSON.stringify(raw)} names no real UTC second`)
  }
  return ms / 1000
}

/** Parse retained custody data only. Live process authority remains in the existing Linux owner. */
export function parseMuxAttachmentProof(value: unknown): MuxAttachmentProof {
  const where = "mux attachment"
  const fields = (input: unknown, keys: readonly string[], subject: string): Record<string, unknown> => {
    if (
      !isRecord(input) ||
      Object.keys(input).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(input, key))
    ) {
      fail(subject, "invalid fields")
    }
    return input
  }
  const integer = (input: unknown, minimum: number, subject: string): number => {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum || input > 0xffffffff) {
      fail(subject, "invalid process or tty number")
    }
    return input
  }
  const path = (source: Record<string, unknown>, key: string, subject: string): string => {
    const result = text(source, key, subject)
    if (!result.startsWith("/") || result.includes("\0")) fail(subject, `${key} must be an absolute path`)
    return result
  }
  const process = (input: unknown, subject: string, extra: readonly string[] = []) => {
    const row = fields(input, ["pid", "startTicks", ...extra], subject)
    const startTicks = text(row, "startTicks", subject)
    if (!/^[1-9][0-9]*$/.test(startTicks)) fail(subject, "startTicks must be positive decimal ticks")
    return { pid: integer(row.pid, 2, subject), startTicks }
  }
  const ttyProcess = (key: string) => {
    const row = object(source, key, where)
    return { ...process(row, `${where} ${key}`, ["ttyRdev"]), ttyRdev: integer(row.ttyRdev, 0, `${where} ${key}`) }
  }
  const source = fields(
    value,
    [
      "platform",
      "mux",
      "bootId",
      "receiptSha256",
      "launchRunId",
      "captureRunId",
      "preflightCollector",
      "outerShell",
      "outerTerminal",
      "collector",
      "attachedClient",
      "chain",
      "executable",
      "config",
      "socketPath",
      "session",
    ],
    where,
  )
  const id = (key: string) => {
    const result = text(source, key, where)
    if (!RUN_ID.test(result)) fail(where, `invalid ${key}`)
    return result
  }
  if (source.platform === "darwin") {
    const birth = (row: Record<string, unknown>, subject: string): number => {
      const value = row.startedAtEpochSeconds
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        fail(subject, "startedAtEpochSeconds must be a whole epoch second")
      }
      return value
    }
    const pidOf = (row: Record<string, unknown>, subject: string): number => integer(row.pid, 2, subject)
    const birthProcess = (key: string) => {
      const row = fields(object(source, key, where), ["pid", "startedAtEpochSeconds"], `${where} ${key}`)
      return { pid: pidOf(row, `${where} ${key}`), startedAtEpochSeconds: birth(row, `${where} ${key}`) }
    }
    /** D4.5: a TTY is optional only on the row the run measured with none. On Darwin "no TTY" is not
     * zero — the kernel writes NODEV (0xffffffff) — so both 0 and NODEV refuse, named, never admitted
     * as an integer the shared zero check could miss. */
    const ttyRdev = (row: Record<string, unknown>, subject: string, required: boolean): number | null => {
      const value = row.ttyRdev
      if (value === null) {
        if (required) fail(subject, "has no TTY")
        return null
      }
      // A wrong type or a negative is not a measured "no TTY": name the shape the reader needs, so a
      // string like "ttys000" points at the cause instead of reading as an absent device (@cto e5016c9f).
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        fail(subject, "ttyRdev must be a device number or null")
      }
      if (value === 0 || value === 0xffffffff) fail(subject, "has no TTY")
      return value
    }
    const requiredTty = (row: Record<string, unknown>, subject: string): number => {
      const value = ttyRdev(row, subject, true)
      if (value === null) fail(subject, "has no TTY")
      return value
    }
    const ttyBirthProcess = (key: string) => {
      const subject = `${where} ${key}`
      const row = fields(object(source, key, where), ["pid", "startedAtEpochSeconds", "ttyRdev"], subject)
      return {
        pid: pidOf(row, subject),
        startedAtEpochSeconds: birth(row, subject),
        ttyRdev: requiredTty(row, subject),
      }
    }
    if (!Array.isArray(source.chain) || source.chain.length < 3) {
      fail(where, "chain must include the collector, the mux, the login hop and the outer app")
    }
    const lastIndex = source.chain.length - 1
    const chainKeys = ["pid", "ppid", "uid", "startedAtEpochSeconds", "executablePath", "ttyRdev"] as const
    const kernelKeys = [
      "kernelExecutable",
      "kernelExecutableReader",
      "kernelExecutableError",
      "kernelExecutableAttempts",
    ] as const
    /** #30518: the kernel-executed path travels with a row, never in place of `executablePath` (argv0).
     * A submitted row may omit the whole group — that is the tmux reader this cut keeps — but a group
     * that is present must be complete, so a half-written record cannot read as "reader not run". */
    const kernel = (
      input: unknown,
      subject: string,
    ): Partial<{
      kernelExecutable: string | null
      kernelExecutableReader: "proc_pidpath" | "KERN_PROCARGS2" | null
      kernelExecutableError: string | null
      kernelExecutableAttempts: { reader: string; result: number | string | null; error: string | null }[]
    }> => {
      if (!isRecord(input) || !Object.hasOwn(input, "kernelExecutable")) {
        return {}
      }
      for (const key of kernelKeys) if (!Object.hasOwn(input, key)) fail(subject, `kernel group is missing ${key}`)
      const executable = input.kernelExecutable
      const resolved = executable === null ? null : path(input, "kernelExecutable", subject)
      const reader = input.kernelExecutableReader
      if (reader !== null && reader !== "proc_pidpath" && reader !== "KERN_PROCARGS2") {
        fail(subject, "kernelExecutableReader must name proc_pidpath, KERN_PROCARGS2 or null")
      }
      const error = input.kernelExecutableError
      if (error !== null && typeof error !== "string") fail(subject, "kernelExecutableError must be text or null")
      // R3 (@cto): kernelExecPath produces only two shapes — a path with its reader and no error, or
      // no path with the reason. Anything else is not a read, so it refuses instead of grading.
      if (resolved !== null && reader === null) fail(subject, "a kernel executable path names no reader")
      if (resolved === null && reader !== null) fail(subject, "kernelExecutableReader names a reader but no path")
      if (resolved !== null && error !== null) fail(subject, "a kernel executable path carries an error")
      if (resolved === null && reader === null && error === null) {
        fail(subject, "a kernel read with no path names neither a reader nor an error")
      }
      const attempts = input.kernelExecutableAttempts
      if (!Array.isArray(attempts)) fail(subject, "kernelExecutableAttempts must be an array")
      for (const [index, attempt] of attempts.entries()) {
        const row = fields(attempt, ["reader", "result", "error"], `${subject} kernelExecutableAttempts[${index}]`)
        text(row, "reader", `${subject} kernelExecutableAttempts[${index}]`)
        const result = row.result
        if (result !== null && typeof result !== "string" && typeof result !== "number") {
          fail(`${subject} kernelExecutableAttempts[${index}]`, "result must be a number, text or null")
        }
        if (row.error !== null && typeof row.error !== "string") {
          fail(`${subject} kernelExecutableAttempts[${index}]`, "error must be text or null")
        }
      }
      return {
        kernelExecutable: resolved,
        kernelExecutableReader: reader,
        kernelExecutableError: error,
        kernelExecutableAttempts: attempts as {
          reader: string
          result: number | string | null
          error: string | null
        }[],
      }
    }
    /** Darwin argv0 is not always a path: Screen's pane login runs as the bare word `login` (@cto
     * 12:11 PDT, Q2 NO to a command path), and the kernel path beside it is what proves the binary.
     * This keeps the argv0 verbatim and refuses only a shape that is neither a path nor a command word. */
    const argv0 = (row: Record<string, unknown>, subject: string): string => {
      const result = text(row, "executablePath", subject)
      if (result.includes("\0") || /\s/.test(result)) {
        fail(subject, "executablePath must be a path or a bare command word")
      }
      return result
    }
    const chain = source.chain.map((input, index) => {
      const subject = `${where} chain[${index}]`
      const keys = isRecord(input) ? Object.keys(input) : []
      const carriesKernel = keys.some((key) => (kernelKeys as readonly string[]).includes(key))
      if (!isRecord(input) || keys.length !== chainKeys.length + (carriesKernel ? kernelKeys.length : 0)) {
        fail(subject, "invalid fields")
      }
      const base = carriesKernel ? [...chainKeys, ...kernelKeys] : [...chainKeys]
      const row = fields(input, base, subject)
      return {
        pid: pidOf(row, subject),
        ppid: integer(row.ppid, 0, subject),
        uid: integer(row.uid, 0, subject),
        startedAtEpochSeconds: birth(row, subject),
        // R1 (@cto): only Screen's own argv0 is not a path. Every other Darwin row — including every
        // tmux row, which may carry no kernel group — keeps the absolute-path rule it had.
        executablePath: source.mux === "screen" ? argv0(row, subject) : path(row, "executablePath", subject),
        // Screen's backend (chain[2]) deliberately owns no PTY, so the screen arm is the one chain
        // whose measured row 2 may carry no TTY; assertScreenChain proves that shape is exactly 7 rows.
        ttyRdev: ttyRdev(row, subject, index !== lastIndex && !(source.mux === "screen" && index === 2)),
        ...kernel(row, subject),
      }
    })
    // D4.4: every hop's parent is the next row, so the chain is the measured ancestry, not a list.
    for (const [index, hop] of chain.slice(0, -1).entries()) {
      const next = chain[index + 1]
      if (!next || hop.ppid !== next.pid) {
        fail(`${where} chain[${index}]`, `ppid ${hop.ppid} does not name the next process`)
      }
    }
    const executable = fields(source.executable, ["path", "sha256", "version"], `${where} executable`)
    const config = fields(source.config, ["path", "sha256"], `${where} config`)
    const proof: DarwinMuxAttachmentProof = {
      platform: "darwin",
      mux: oneOf(source, "mux", ["tmux", "screen"], where) as DarwinMuxAttachmentProof["mux"],
      bootId: text(source, "bootId", where),
      receiptSha256: measured(source, "receiptSha256", where, { digest: true }),
      launchRunId: id("launchRunId"),
      captureRunId: id("captureRunId"),
      preflightCollector: birthProcess("preflightCollector"),
      outerShell: ttyBirthProcess("outerShell"),
      outerTerminal: birthProcess("outerTerminal"),
      collector: ttyBirthProcess("collector"),
      attachedClient: ttyBirthProcess("attachedClient"),
      chain,
      executable: {
        path: path(executable, "path", `${where} executable`),
        sha256: measured(executable, "sha256", where, { digest: true }),
        version: text(executable, "version", where),
      },
      config: {
        path: path(config, "path", `${where} config`),
        sha256: measured(config, "sha256", where, { digest: true }),
      },
      socketPath: path(source, "socketPath", where),
      session: text(source, "session", where),
    }
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(proof.bootId)) fail(where, "invalid bootId")
    const sameProcess = (
      a: { pid: number; startedAtEpochSeconds: number },
      b: { pid: number; startedAtEpochSeconds: number },
    ) => a.pid === b.pid && a.startedAtEpochSeconds === b.startedAtEpochSeconds
    if (proof.mux === "screen") {
      // Screen's rows prove themselves through the kernel path, so its arm is a whole arm: it owns
      // every custody rule below rather than sharing the argv0 rules that name the wrong field.
      assertScreenChain(where, proof, sameProcess)
    } else {
      assertMuxChain<{ pid: number; startedAtEpochSeconds: number }>(where, proof, sameProcess, 3)
    }
    return proof
  }
  if (source.platform !== "linux") fail(where, "platform must be linux or darwin")
  const mux = oneOf(source, "mux", ["tmux", "screen"], where) as LinuxMuxAttachmentProof["mux"]
  const bootId = text(source, "bootId", where)
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId)) fail(where, "invalid bootId")
  if (!Array.isArray(source.chain) || source.chain.length < 2) fail(where, "chain must include collector and outer app")
  const chain = source.chain.map((input, index) => {
    const subject = `${where} chain[${index}]`
    const row = fields(input, ["pid", "startTicks", "executablePath", "ttyRdev"], subject)
    return {
      ...process(row, subject, ["executablePath", "ttyRdev"]),
      executablePath: path(row, "executablePath", subject),
      ttyRdev: integer(row.ttyRdev, 0, subject),
    }
  })
  const executable = fields(source.executable, ["path", "sha256", "version"], `${where} executable`)
  const config = fields(source.config, ["path", "sha256"], `${where} config`)
  const proof: LinuxMuxAttachmentProof = {
    platform: "linux",
    mux,
    bootId,
    receiptSha256: measured(source, "receiptSha256", where, { digest: true }),
    launchRunId: id("launchRunId"),
    captureRunId: id("captureRunId"),
    preflightCollector: process(source.preflightCollector, `${where} preflightCollector`),
    outerShell: ttyProcess("outerShell"),
    outerTerminal: process(source.outerTerminal, `${where} outerTerminal`),
    collector: ttyProcess("collector"),
    attachedClient: ttyProcess("attachedClient"),
    chain,
    executable: {
      path: path(executable, "path", `${where} executable`),
      sha256: measured(executable, "sha256", where, { digest: true }),
      version: text(executable, "version", where),
    },
    config: {
      path: path(config, "path", `${where} config`),
      sha256: measured(config, "sha256", where, { digest: true }),
    },
    socketPath: path(source, "socketPath", where),
    session: text(source, "session", where),
  }
  assertMuxChain<{ pid: number; startTicks: string }>(
    where,
    proof,
    (a, b) => a.pid === b.pid && a.startTicks === b.startTicks,
  )
  return proof
}

/**
 * The positional custody checks every mux arm shares (#30518 D4.1). The chain runs from the collector
 * through the declared mux processes to the outer shell, then the outer terminal; the collector, the
 * shell and the attached client obey three PTY rules. `sameProcess` is the arm's process identity.
 */
function assertMuxChain<Identity extends { pid: number }>(
  where: string,
  proof: {
    collector: Identity & { ttyRdev: number }
    outerShell: Identity & { ttyRdev: number }
    outerTerminal: Identity
    attachedClient: { ttyRdev: number }
    chain: readonly (Identity & { executablePath: string; ttyRdev: number | null; uid?: number })[]
    executable: { path: string }
  },
  sameProcess: (a: Identity, b: Identity) => boolean,
  /** 2 on Linux (shell immediately before the terminal); 3 on Darwin, where the measured login hop sits
   * between them. `shellBelowLogin` names the root hop the Darwin arm requires. */
  shellFromEnd: 2 | 3 = 2,
): void {
  const { chain } = proof
  const first = chain[0]
  const last = chain[chain.length - 1]
  if (!first || !last) fail(where, "chain must include collector and outer app")
  if (!sameProcess(first, proof.collector) || first.ttyRdev !== proof.collector.ttyRdev) {
    fail(where, "chain collector identity or TTY differs from collector")
  }
  if (!sameProcess(last, proof.outerTerminal)) {
    fail(where, "chain does not end at the declared outer terminal identity")
  }
  if (shellFromEnd === 3) {
    // D4.3: the measured root allowance — exactly one uid-0 /usr/bin/login below the outer shell.
    const login = chain.at(-2)
    if (!login) fail(where, "chain has no hop below the outer shell")
    const rootHop = login as unknown as { pid: number; ppid: number; uid: number; executablePath: string }
    if (rootHop.executablePath !== "/usr/bin/login") fail(where, "chain root hop is not /usr/bin/login")
    if (rootHop.uid !== 0) fail(where, "chain root hop is not uid 0")
    // Its parent is checked by the arm's ppid walk (D4.4), which refuses a break anywhere in the chain.
    // The allowance is exactly that one hop: every other row carries the collector's uid (@cto
    // e5016c9f), so a root-owned mux server or shell cannot ride the login hop's exception.
    const collectorUid = first.uid
    if (collectorUid === undefined) fail(where, "chain collector carries no uid")
    for (const [index, row] of chain.entries()) {
      if (index === chain.length - 2) continue
      if (row.uid !== collectorUid) {
        fail(`${where} chain[${index}]`, `uid ${row.uid} is not the collector's uid ${collectorUid}`)
      }
    }
  }
  const shell = chain.at(-shellFromEnd)
  if (!shell || !sameProcess(shell, proof.outerShell) || shell.ttyRdev !== proof.outerShell.ttyRdev) {
    fail(where, "outer shell identity or TTY is absent immediately below the outer terminal")
  }
  if (new Set(chain.map((row) => row.pid)).size !== chain.length) fail(where, "chain repeats a process")
  if (
    proof.collector.ttyRdev === 0 ||
    proof.outerShell.ttyRdev === 0 ||
    proof.collector.ttyRdev === proof.outerShell.ttyRdev
  ) {
    fail(where, "collector and outer shell must name distinct PTYs")
  }
  if (proof.attachedClient.ttyRdev !== proof.outerShell.ttyRdev) {
    fail(where, "attached client TTY differs from outer shell")
  }
  const muxProcesses = chain.slice(1, -shellFromEnd)
  if (muxProcesses.length === 0) fail(where, "chain has no declared mux process between collector and outer shell")
  for (const row of muxProcesses) {
    if (row.executablePath !== proof.executable.path) {
      fail(where, `chain process ${row.pid} does not name the declared mux executable`)
    }
  }
}

/** The one version line Screen's arm admits (#30518 A4): Apple's 4.00.03 build measured on r14. Any
 * other build refuses by name - an unqualified version is not a smaller claim, it is a different
 * program whose chain shape nothing here measured. */
const SCREEN_VERSION = /(?:^|\n)Screen version 4\.00\.03(?=[\s(]|$)/

/** The pane login's kernel path (R1/R2). argv0 is bare `login` on Darwin, so this path is the only
 * evidence that the uid-0 hop below the mux is the login program and not something renamed to it. */
const SCREEN_PANE_LOGIN = "/usr/bin/login"

/**
 * Screen's Darwin arm (#30518, @cto e29901ef with A1-A4). Seven rows, child to parent: collector,
 * pane login, mux server, mux client, outer shell, root login, outer app. The frontend forks a backend
 * and the backend renames itself `SCREEN`, so the mux path is read from the kernel, never from argv0;
 * the pane TTY and the attachment are read from the rows themselves, never from a screen query.
 *
 * Every refusal names the rule and the pid it read, because the honesty of this arm is that each field
 * was measured: a uid-0 row whose kernel read went unanswered refuses by name rather than falling back
 * to argv0. R1-R4 are the four positional rules the r14 run measured true; the shape comparison against
 * r13b (r5) stays in the harness and is deliberately not a production admission rule.
 */
function assertScreenChain<Identity extends { pid: number; startedAtEpochSeconds: number }>(
  where: string,
  proof: {
    collector: Identity & { ttyRdev: number }
    outerShell: Identity & { ttyRdev: number }
    outerTerminal: Identity
    attachedClient: Identity & { ttyRdev: number }
    chain: readonly (Identity & {
      ppid: number
      uid: number
      ttyRdev: number | null
      executablePath: string
      kernelExecutable?: string | null
      kernelExecutableReader?: "proc_pidpath" | "KERN_PROCARGS2" | null
      kernelExecutableError?: string | null
    })[]
    executable: { path: string; version: string }
  },
  sameProcess: (a: Identity, b: Identity) => boolean,
): void {
  const chain = proof.chain
  if (chain.length !== 7) fail(where, `screen chain has ${chain.length} rows; the measured shape has 7`)
  if (new Set(chain.map((row) => row.pid)).size !== chain.length) fail(where, "chain repeats a process")
  const collectorRow = chain[0]
  const paneLogin = chain[1]
  const server = chain[2]
  const client = chain[3]
  const shell = chain[4]
  const login = chain[5]
  const owner = chain[6]
  if (!collectorRow || !paneLogin || !server || !client || !shell || !login || !owner) {
    fail(where, "screen chain is missing a named role")
  }
  // A1: the kernel read is required on every row, and an unanswered one is named rather than skipped.
  for (const [index, row] of chain.entries()) {
    if (typeof row.kernelExecutable !== "string" || !row.kernelExecutable.startsWith("/")) {
      fail(
        `${where} chain[${index}]`,
        `pid ${row.pid} has no kernel executable path (reader ${row.kernelExecutableReader ?? "did not answer"}: ${row.kernelExecutableError ?? "no reason recorded"})`,
      )
    }
  }
  if (!SCREEN_VERSION.test(proof.executable.version)) {
    fail(
      where,
      `screen executable version is not the admitted 4.00.03 line: ${JSON.stringify(proof.executable.version)}`,
    )
  }
  // R1: the pane login sits under the server, on the collector's own PTY, and is the login program.
  if (paneLogin.uid !== 0) fail(`${where} chain[1]`, `pane login pid ${paneLogin.pid} is uid ${paneLogin.uid}, not 0`)
  if (paneLogin.ppid !== server.pid) {
    fail(
      `${where} chain[1]`,
      `pane login pid ${paneLogin.pid} has parent ${paneLogin.ppid}, not the server ${server.pid}`,
    )
  }
  if (paneLogin.ttyRdev === null || paneLogin.ttyRdev !== collectorRow.ttyRdev) {
    fail(`${where} chain[1]`, `pane login pid ${paneLogin.pid} is not on the collector's TTY`)
  }
  if (paneLogin.kernelExecutable !== SCREEN_PANE_LOGIN) {
    fail(
      `${where} chain[1]`,
      `pane login pid ${paneLogin.pid} kernel path is ${String(paneLogin.kernelExecutable)}, not ${SCREEN_PANE_LOGIN}`,
    )
  }
  // R2: exactly two uid-0 rows, both in a named role and both the login program; everything else
  // carries the collector's uid, so a root-owned mux cannot ride an unnamed exception.
  const rootRows = chain.filter((row) => row.uid === 0)
  if (rootRows.length !== 2 || !rootRows.includes(paneLogin) || !rootRows.includes(login)) {
    fail(
      where,
      `screen chain has uid-0 rows ${JSON.stringify(rootRows.map((row) => row.pid))}; exactly the pane login and the root login are allowed`,
    )
  }
  if (login.kernelExecutable !== SCREEN_PANE_LOGIN) {
    fail(
      `${where} chain[5]`,
      `root login pid ${login.pid} kernel path is ${String(login.kernelExecutable)}, not ${SCREEN_PANE_LOGIN}`,
    )
  }
  for (const [index, row] of chain.entries()) {
    if (index === 1 || index === 5) continue
    if (row.uid !== collectorRow.uid) {
      fail(`${where} chain[${index}]`, `uid ${row.uid} is not the collector's uid ${collectorRow.uid}`)
    }
  }
  // R3: the backend (server) owns no PTY, its parent is the frontend (client), the client owns the
  // owner TTY, and both are the kernel's own mux binary - SCREEN's argv0 is not evidence.
  if (server.ttyRdev !== null) fail(`${where} chain[2]`, `server pid ${server.pid} carries TTY ${server.ttyRdev}`)
  if (server.ppid !== client.pid) {
    fail(`${where} chain[2]`, `server pid ${server.pid} has parent ${server.ppid}, not the client ${client.pid}`)
  }
  if (client.ttyRdev === null || client.ttyRdev !== shell.ttyRdev) {
    fail(`${where} chain[3]`, `client pid ${client.pid} is not on the outer shell's TTY`)
  }
  for (const [index, row] of [
    [2, server],
    [3, client],
  ] as const) {
    if (row.kernelExecutable !== proof.executable.path) {
      fail(
        `${where} chain[${index}]`,
        `mux pid ${row.pid} kernel path is ${String(row.kernelExecutable)}, not ${proof.executable.path}`,
      )
    }
  }
  // R4: the client is the server's parent and the outer shell's child; the attachment comes from
  // these rows, never from a screen query.
  if (client.ppid !== shell.pid) {
    fail(`${where} chain[3]`, `client pid ${client.pid} has parent ${client.ppid}, not the outer shell ${shell.pid}`)
  }
  if (!sameProcess(collectorRow, proof.collector) || collectorRow.ttyRdev !== proof.collector.ttyRdev) {
    fail(where, "chain collector identity or TTY differs from collector")
  }
  if (collectorRow.ttyRdev === proof.outerShell.ttyRdev) {
    fail(where, "collector and outer shell must name distinct PTYs")
  }
  if (!sameProcess(shell, proof.outerShell)) fail(where, "chain outer shell is not the declared outer shell")
  if (shell.ttyRdev !== proof.outerShell.ttyRdev) {
    fail(where, "chain outer shell TTY differs from the declared outer shell")
  }
  if (!sameProcess(owner, proof.outerTerminal)) fail(where, "chain does not end at the declared outer terminal")
  if (!sameProcess(client, proof.attachedClient) || client.ttyRdev !== proof.attachedClient.ttyRdev) {
    fail(where, "the attached client is not the row the chain measured as the server's parent")
  }
}

/** The Linux half the collector can actually read: /out/host-measured.json, authored by the host
 * launcher and mounted read-only before the container starts. The composed container receipt is
 * written on the host after the container is removed, so it is deliberately not what this accepts. */
function assertLinuxXvfbContainer(value: Record<string, unknown>): {
  declaredTarget: ReceiptTarget
  identity: ContainerIdentity
} {
  const where = "linux-xvfb-container"
  const runtime = object(value, "runtime", where)
  const imageId = measured(runtime, "imageId", `${where} runtime`, { digest: true, scheme: true })
  const imageTarSha256 = measured(runtime, "imageTarSha256", `${where} runtime`, { digest: true })
  const arch = oneOf(runtime, "arch", CONTAINER_ARCHES, `${where} runtime`)
  const nixLockRevision = measured(runtime, "nixLockRevision", `${where} runtime`)
  text(runtime, "sourceRevision", `${where} runtime`)
  text(runtime, "sourceTreeStatus", `${where} runtime`)
  text(runtime, "rootRevision", `${where} runtime`)
  text(runtime, "suiteHash", `${where} runtime`)
  const runner = object(value, "runnerArtifact", where)
  const frozenRunnerSha256 = measured(runner, "frozenRunnerSha256", `${where} runnerArtifact`, { digest: true })
  const buildReceiptSha256 = measured(runner, "buildReceiptSha256", `${where} runnerArtifact`, { digest: true })
  const target = object(value, "declaredTarget", where)
  const declaredTarget = {
    kind: text(target, "kind", `${where} declaredTarget`),
    id: text(target, "id", `${where} declaredTarget`),
    os: text(target, "os", `${where} declaredTarget`),
  }
  text(value, "preset", where)
  oneOf(value, "clipboardProfile", CLIPBOARD_PROFILES, where)
  return {
    declaredTarget,
    identity: { imageId, imageTarSha256, arch, nixLockRevision, frozenRunnerSha256, buildReceiptSha256 },
  }
}

/** A GitHub-hosted runner is disposable only when GitHub says so AND the VM identity never recurs.
 * This accepts the two checks a receipt can carry (hosted environment; one machine for the whole
 * job). Non-reuse across job identities is checked where all receipts are seen, not here. */
function assertGithubHostedRunner(value: Record<string, unknown>): {
  declaredTarget?: ReceiptTarget
  identity?: ContainerIdentity
  appLaunch?: AppLaunchReceipt
} {
  const where = "github-hosted-runner"
  const job = object(value, "job", where)
  for (const key of ["repository", "workflow", "workflowRef", "githubRunId", "githubRunAttempt", "job", "jobId"]) {
    text(job, key, `${where} job`)
  }
  for (const key of ["githubRunId", "githubRunAttempt", "jobId"]) {
    const value = text(job, key, `${where} job`)
    if (/[^0-9]/.test(value)) {
      fail(
        `${where} job`,
        `${key} must be decimal digits` +
          (key === "jobId" ? "; GITHUB_JOB is a YAML key, not the numeric jobs-API id" : ""),
      )
    }
  }
  const runner = object(value, "runner", where)
  const environment = text(runner, "environment", `${where} runner`)
  if (environment !== "github-hosted") {
    fail(
      `${where} runner`,
      `environment must be "github-hosted", never assumed; received ${JSON.stringify(environment)}`,
    )
  }
  for (const key of ["name", "os", "arch", "imageOS", "imageVersion", "trackingId"]) {
    text(runner, key, `${where} runner`)
  }
  const vm = object(value, "vm", where)
  const samples = ["identityAtJobStart", "identityAtCollection"].map((key) => object(vm, key, `${where} vm`))
  for (const [index, sample] of samples.entries()) {
    digest(sample, "machineIdSha256", `${where} vm ${["identityAtJobStart", "identityAtCollection"][index]}`)
    digest(sample, "productUuidSha256", `${where} vm ${["identityAtJobStart", "identityAtCollection"][index]}`)
    digest(sample, "bootIdSha256", `${where} vm ${["identityAtJobStart", "identityAtCollection"][index]}`)
  }
  if (JSON.stringify(samples[0]) !== JSON.stringify(samples[1])) {
    fail(`${where} vm`, "identityAtJobStart and identityAtCollection disagree; one machine must serve the whole job")
  }
  // A hosted macOS collection is an app collection the apparatus launched, so the launch receipt it
  // measured is validated here, by the ONE parser, and returned for the collector to copy verbatim
  // into origin.appLaunch (28216). A malformed block is refused by the parser, by name.
  const appLaunch =
    value.appLaunch === undefined ? undefined : parseAppLaunchReceipt(value.appLaunch, "collector", "app", where)
  return { ...(appLaunch && { appLaunch }) }
}

const KINDS: Record<
  DisposableKind,
  (value: Record<string, unknown>) => {
    declaredTarget?: ReceiptTarget
    identity?: ContainerIdentity
    appLaunch?: AppLaunchReceipt
  }
> = {
  "linux-xvfb-container": assertLinuxXvfbContainer,
  "github-hosted-runner": assertGithubHostedRunner,
}

/** Strict, loud parse: a receipt is authority only if every field it must carry is present and sane. */
export function parseDisposableReceipt(bytes: string): DisposableReceipt {
  let value: unknown
  try {
    value = JSON.parse(bytes) as unknown
  } catch (cause) {
    throw new Error("Disposable ownership receipt is not JSON", { cause })
  }
  if (!isRecord(value)) fail("envelope", "must be a JSON object")
  if (value.schemaVersion !== 1) fail("envelope", "schemaVersion must be 1")
  const kind = text(value, "kind", "envelope")
  if (kind === TRANSPORT_RECEIPT_KIND) {
    fail(
      "envelope",
      "kind owned-app-transport records where a run started and grants nothing; it never authorizes mutate+readback",
    )
  }
  if (kind !== "linux-xvfb-container" && kind !== "github-hosted-runner") {
    fail("envelope", `unknown kind ${JSON.stringify(kind)}; only a named disposable kind may authorize a write`)
  }
  const runId = text(value, "runId", "envelope")
  if (!RUN_ID.test(runId)) fail("envelope", "runId must be 32 lowercase hex")
  const collectedAt = text(value, "collectedAt", "envelope")
  if (!UTC_INSTANT.test(collectedAt)) fail("envelope", "collectedAt must be an RFC3339 UTC instant")
  const parsed = KINDS[kind](value)
  return {
    kind,
    runId,
    collectedAt,
    ...(parsed.declaredTarget ? { declaredTarget: parsed.declaredTarget } : {}),
    ...(parsed.identity ? { identity: parsed.identity } : {}),
    ...(parsed.appLaunch ? { appLaunch: parsed.appLaunch } : {}),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

/**
 * Refuse a receipt that is not about the run it is authorizing (27874 part 2). The caller supplies
 * the run's OWN target — the target detected or launched on the measured side, never a value read
 * back out of the receipt — so a receipt naming kitty cannot authorize a wezterm run. Loud by name.
 *
 * A kind that declares no target (github-hosted-runner today) carries no target claim to bind, and
 * this returns without complaint; the caller's summary records that absence rather than faking one.
 */
export function bindReceiptToRun(receipt: DisposableReceipt, target: ReceiptTarget | undefined, where: string): void {
  const declared = receipt.declaredTarget
  if (!declared) return
  if (!target) {
    fail(where, `receipt names target ${JSON.stringify(declared)} but no run target was supplied to bind it to`)
  }
  const disagree = (["kind", "id", "os"] as const).filter((key) => declared[key] !== target[key])
  if (disagree.length > 0) {
    fail(
      where,
      `receipt declares target ${JSON.stringify(declared)} but this run is ${JSON.stringify(target)}: ` +
        `${disagree.join(", ")} disagree, and a receipt for one target cannot authorize another`,
    )
  }
}

/** Read and parse the receipt at `path`; a missing file or a bad read is loud, never a silent default. */
export function readDisposableReceipt(path: string): DisposableReceipt {
  let bytes: string
  try {
    bytes = readFileSync(path, "utf8")
  } catch (cause) {
    throw new Error(`Disposable ownership receipt unreadable at ${path}`, { cause })
  }
  return parseDisposableReceipt(bytes)
}
