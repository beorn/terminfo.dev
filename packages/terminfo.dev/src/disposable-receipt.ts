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
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(subject, "has no TTY")
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
    const chain = source.chain.map((input, index) => {
      const subject = `${where} chain[${index}]`
      const row = fields(input, ["pid", "ppid", "uid", "startedAtEpochSeconds", "executablePath", "ttyRdev"], subject)
      return {
        pid: pidOf(row, subject),
        ppid: integer(row.ppid, 0, subject),
        uid: integer(row.uid, 0, subject),
        startedAtEpochSeconds: birth(row, subject),
        executablePath: path(row, "executablePath", subject),
        ttyRdev: ttyRdev(row, subject, index !== lastIndex),
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
    assertMuxChain<{ pid: number; startedAtEpochSeconds: number }>(
      where,
      proof,
      (a, b) => a.pid === b.pid && a.startedAtEpochSeconds === b.startedAtEpochSeconds,
      3,
    )
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
    chain: readonly (Identity & { executablePath: string; ttyRdev: number | null })[]
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
    // D4.3: the measured root allowance, in exactly this form and no wider.
    const login = chain.at(-2)
    if (!login) fail(where, "chain has no hop below the outer shell")
    const rootHop = login as unknown as { pid: number; ppid: number; uid: number; executablePath: string }
    if (rootHop.executablePath !== "/usr/bin/login") fail(where, "chain root hop is not /usr/bin/login")
    if (rootHop.uid !== 0) fail(where, "chain root hop is not uid 0")
    // Its parent is checked by the arm's ppid walk (D4.4), which refuses a break anywhere in the chain.
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
