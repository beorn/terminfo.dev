import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

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
/** One repeated character at any length. The apparatus derives these values from real bytes, so an
 * all-zero or all-'a' value is a placeholder: what a hand writes when nothing was measured. */
const PLACEHOLDER = /^(.)\1*$/

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
  return {}
}

const KINDS: Record<
  DisposableKind,
  (value: Record<string, unknown>) => { declaredTarget?: ReceiptTarget; identity?: ContainerIdentity }
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
