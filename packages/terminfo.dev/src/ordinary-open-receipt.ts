/**
 * Evidence that an OSC 52 row was measured inside an app a person opened normally (@cto 2026-11-13).
 *
 * A disposable receipt says "this run owned the thing it wrote to". An ordinary-open run owns nothing: the app
 * belongs to the person who opened it, so the only thing that can make the reading about THAT app is ancestry
 * from the probe up to the app's own pid, recorded by the run and parsed here. It is deliberately a separate
 * type with its own collector key, never a third `DisposableKind`: a kind whose ownership is "none" inside a
 * union every consumer reads as "disposable and owned" is a trap, and this must never authorize a generic
 * mutate+readback. Only the three OSC 52 rows are admitted, by {@link ordinaryOpenAdmission}.
 *
 * A receipt proves nothing by assertion: the nonce carries the receipt's own runId and the recorded sha256 is
 * recomputed from it here, so a copied payload from another run is refused by name. No host path is recorded
 * except the one field that is a bundle-internal path, and every executable is a basename.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { basename } from "node:path"

/** The receipt's own identity. It shares no kind value with {@link DisposableKind}. */
export const ORDINARY_OPEN_RECEIPT_KIND = "ordinary-open-app"

/** Where a run records it, beside `collector.disposableOwnership` and never instead of it. */
export const ORDINARY_OPEN_COLLECTOR_KEY = "collector.ordinaryOpen"

/** The only rows an ordinary-open receipt can admit (@cto 2026-11-13: the gate names them explicitly). */
export const ORDINARY_OPEN_PROBE_IDS = [
  "extensions.osc52-write",
  "extensions.osc52-read",
  "extensions.osc52-clipboard",
] as const

export type OrdinaryOpenProbeId = (typeof ORDINARY_OPEN_PROBE_IDS)[number]

export interface OrdinaryOpenAncestryLink {
  readonly pid: number
  /** The process's executable as a basename. A path here is refused: ancestry is not a filesystem claim. */
  readonly executable: string
}

export interface OrdinaryOpenReceipt {
  readonly kind: typeof ORDINARY_OPEN_RECEIPT_KIND
  readonly runId: string
  readonly collectedAt: string
  /** What this run measured. `id` is the terminfo subject id, `bundleId` what the running bundle declares. */
  readonly subject: {
    readonly id: string
    readonly bundleId: string
    /** The running bundle's own version, compared with the row's measured version at admission. */
    readonly version: string
    /** The app's executable inside its bundle — the one field allowed to carry separators. */
    readonly executableInBundle: string
  }
  /**
   * The probe's process chain up to the app's pid, as the run recorded it: first link is the probe, and the LAST
   * link must be the app itself (its pid is `appPid`). Order is checked because a chain that merely contains the
   * app proves less than one that ends at it.
   */
  readonly ancestry: {
    readonly appPid: number
    readonly chain: readonly OrdinaryOpenAncestryLink[]
  }
  /** A random payload made for this receipt; it carries the runId, and the hash is recomputed here. */
  readonly nonce: {
    readonly value: string
    readonly sha256: string
  }
  /** The OS pasteboard read: the command, its exit, and whether the payload came back. */
  readonly witness: {
    readonly command: string
    readonly exit: number
    readonly matched: boolean
  }
  /** The pasteboard the run found. Length and hash only — the content is never recorded. */
  readonly baselineRestore: {
    readonly length: number
    readonly sha256: string
    readonly restored: boolean
  }
  /** Code-signing facts, recorded rather than binding: unsigned and nightly builds exist. */
  readonly signature: {
    readonly teamId?: string
    readonly signingIdentifier?: string
  }
  /** sha256 of the exact receipt bytes, so a run names the receipt it trusted. */
  readonly sha256: string
}

const RUN_ID = /^[0-9a-f]{32}$/
const DIGEST = /^[0-9a-f]{64}$/
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
/** An app executable is inside `<Bundle>.app/Contents/MacOS/`; nothing else may carry a separator. */
const APP_BUNDLE_EXECUTABLE = /^[^/]+\.app\/Contents\/MacOS\/[^/]+$/

function fail(where: string, detail: string): never {
  throw new Error(`Ordinary-open receipt (${where}): ${detail}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== "string") fail(where, `${key} must be a string`)
  if (value.trim() === "") fail(where, `${key} must not be empty`)
  return value
}

function record(source: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const value = source[key]
  if (!isRecord(value)) fail(where, `${key} must be an object`)
  return value
}

function integer(source: Record<string, unknown>, key: string, where: string, minimum: number): number {
  const value = source[key]
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    fail(where, `${key} must be an integer >= ${minimum}`)
  return value as number
}

function basenameOnly(value: string, where: string, field: string): string {
  if (value.includes("/")) fail(where, `${field} must be a basename, not a path: ${JSON.stringify(value)}`)
  return value
}

function optionalText(source: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") fail(where, `${key} must be a string when present`)
  if (value.trim() === "") fail(where, `${key} must not be empty when present`)
  return value
}

/** Parse a receipt's bytes. Every field a caller could rely on is checked; nothing is defaulted. */
export function parseOrdinaryOpenReceipt(bytes: string): OrdinaryOpenReceipt {
  let value: unknown
  try {
    value = JSON.parse(bytes) as unknown
  } catch (cause) {
    throw new Error("Ordinary-open receipt is not JSON", { cause })
  }
  if (!isRecord(value)) fail("envelope", "must be a JSON object")
  if (value.schemaVersion !== 1) fail("envelope", "schemaVersion must be 1")
  const kind = text(value, "kind", "envelope")
  if (kind !== ORDINARY_OPEN_RECEIPT_KIND) {
    fail(
      "envelope",
      `kind ${JSON.stringify(kind)} is not ${JSON.stringify(ORDINARY_OPEN_RECEIPT_KIND)}; ` +
        "an ordinary-open receipt grants no mutation authority and is not a disposable kind",
    )
  }
  const runId = text(value, "runId", "envelope")
  if (!RUN_ID.test(runId)) fail("envelope", "runId must be 32 lowercase hex")
  const collectedAt = text(value, "collectedAt", "envelope")
  if (!UTC_INSTANT.test(collectedAt)) fail("envelope", "collectedAt must be an RFC3339 UTC instant")

  const subject = record(value, "subject", "envelope")
  const subjectId = basenameOnly(text(subject, "id", "subject"), "subject", "id")
  const bundleId = text(subject, "bundleId", "subject")
  const version = text(subject, "version", "subject")
  const executableInBundle = text(subject, "executableInBundle", "subject")
  if (!APP_BUNDLE_EXECUTABLE.test(executableInBundle)) {
    fail(
      "subject",
      `executableInBundle must be a path inside a .app bundle (…​.app/Contents/MacOS/<file>), got ` +
        JSON.stringify(executableInBundle),
    )
  }

  const ancestry = record(value, "ancestry", "envelope")
  const appPid = integer(ancestry, "appPid", "ancestry", 1)
  const rawChain = ancestry.chain
  if (!Array.isArray(rawChain) || rawChain.length === 0) fail("ancestry", "chain must be a non-empty array")
  const chain = (rawChain as unknown[]).map((raw, index) => {
    if (!isRecord(raw)) fail("ancestry", `chain[${index}] must be an object`)
    return {
      pid: integer(raw, "pid", `ancestry.chain[${index}]`, 1),
      executable: basenameOnly(
        text(raw, "executable", `ancestry.chain[${index}]`),
        `ancestry.chain[${index}]`,
        "executable",
      ),
    }
  })
  const last = chain[chain.length - 1] as OrdinaryOpenAncestryLink
  if (last.pid !== appPid) {
    fail(
      "ancestry",
      `chain ends at pid ${String(last.pid)} but the app's pid is ${String(appPid)}; ` +
        "ancestry that does not reach the app proves nothing about which app holds the run",
    )
  }

  const nonce = record(value, "nonce", "envelope")
  const nonceValue = text(nonce, "value", "nonce")
  const nonceSha256 = text(nonce, "sha256", "nonce")
  if (!DIGEST.test(nonceSha256)) fail("nonce", "sha256 must be 64 lowercase hex")
  if (!nonceValue.includes(runId)) {
    fail(
      "nonce",
      `nonce does not carry this receipt's runId ${runId}; a payload from another run cannot authorize this one`,
    )
  }
  const recomputed = createHash("sha256").update(nonceValue).digest("hex")
  if (recomputed !== nonceSha256) {
    fail("nonce", `sha256 ${nonceSha256} does not match the nonce it names (recomputed ${recomputed})`)
  }

  const witness = record(value, "witness", "envelope")
  const witnessCommand = basenameOnly(text(witness, "command", "witness"), "witness", "command")
  const witnessExit = integer(witness, "exit", "witness", 0)
  const witnessMatched = witness.matched
  if (typeof witnessMatched !== "boolean") fail("witness", "matched must be a boolean")

  const baseline = record(value, "baselineRestore", "envelope")
  const baselineLength = integer(baseline, "length", "baselineRestore", 0)
  const baselineSha256 = text(baseline, "sha256", "baselineRestore")
  if (!DIGEST.test(baselineSha256)) fail("baselineRestore", "sha256 must be 64 lowercase hex")
  const baselineRestored = baseline.restored
  if (typeof baselineRestored !== "boolean") fail("baselineRestore", "restored must be a boolean")

  const signature = record(value, "signature", "envelope")
  const teamId = optionalText(signature, "teamId", "signature")
  const signingIdentifier = optionalText(signature, "signingIdentifier", "signature")
  if (signingIdentifier !== undefined && signingIdentifier !== bundleId) {
    fail(
      "signature",
      `signing identifier ${JSON.stringify(signingIdentifier)} differs from the bundle id ` +
        `${JSON.stringify(bundleId)}; a receipt is only about the app it names`,
    )
  }

  return {
    kind: ORDINARY_OPEN_RECEIPT_KIND,
    runId,
    collectedAt,
    subject: { id: subjectId, bundleId, version, executableInBundle },
    ancestry: { appPid, chain },
    nonce: { value: nonceValue, sha256: nonceSha256 },
    witness: { command: witnessCommand, exit: witnessExit, matched: witnessMatched },
    baselineRestore: { length: baselineLength, sha256: baselineSha256, restored: baselineRestored },
    signature: {
      ...(teamId !== undefined ? { teamId } : {}),
      ...(signingIdentifier !== undefined ? { signingIdentifier } : {}),
    },
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

/** Read and parse the receipt at `path`; a missing file or a bad read is loud, never a silent default. */
export function readOrdinaryOpenReceipt(path: string): OrdinaryOpenReceipt {
  let bytes: string
  try {
    bytes = readFileSync(path, "utf8")
  } catch (cause) {
    throw new Error(`Ordinary-open receipt unreadable at ${path}`, { cause })
  }
  return parseOrdinaryOpenReceipt(bytes)
}

export type OrdinaryOpenAdmission =
  | { readonly admit: true }
  | {
      readonly admit: false
      /** Why the row cannot be graded on this receipt, named so the refusal explains itself. */
      readonly refusal: string
      /** True only for an unprovable ancestry: that is a missing method, not a measured negative. */
      readonly unprovable: boolean
    }

/**
 * May this receipt carry this row? (@cto 2026-11-13: bundle id binds AND the running bundle's version must equal
 * the row's measured version; a witness that did not carry the payload, or a pasteboard left unrestored, refuses
 * rather than grades.)
 */
export function ordinaryOpenAdmission(input: {
  readonly receipt: OrdinaryOpenReceipt
  readonly probeId: string
  readonly subject: { readonly id: string; readonly os: string; readonly kind: string }
  readonly measuredVersion: string | undefined
  /**
   * The bundle id the Mac app registry names for this subject. Supplied by the caller so there is exactly ONE
   * registry (packages/admin/src/app.ts); this module never keeps a second copy to drift from it.
   */
  readonly expectedBundleId: string | undefined
}): OrdinaryOpenAdmission {
  const { receipt, probeId, subject, measuredVersion, expectedBundleId } = input
  if (!(ORDINARY_OPEN_PROBE_IDS as readonly string[]).includes(probeId)) {
    return {
      admit: false,
      unprovable: false,
      refusal: `an ordinary-open receipt admits only the OSC 52 rows, not ${probeId}`,
    }
  }
  if (subject.kind !== "term" || subject.os !== "macos") {
    return {
      admit: false,
      unprovable: false,
      refusal: `an ordinary-open receipt admits a macOS terminal app, not ${subject.kind}/${subject.os}`,
    }
  }
  if (receipt.subject.id !== subject.id) {
    return {
      admit: false,
      unprovable: false,
      refusal: `ancestry names ${receipt.subject.id}, not ${subject.id}`,
    }
  }
  // @cto 2026-11-13: the BUNDLE ID binds, not the id string alone — two builds can share an id, and a receipt can
  // claim any id it likes. Without the registry's bundle id this row proves nothing about which app it measured.
  if (expectedBundleId === undefined) {
    return {
      admit: false,
      unprovable: true,
      refusal: `no bundle id is named for ${subject.id} in the app registry, so the ancestry cannot bind to an app`,
    }
  }
  if (receipt.subject.bundleId !== expectedBundleId) {
    return {
      admit: false,
      unprovable: false,
      refusal: `ancestry bundle id ${receipt.subject.bundleId} is not the bundle ${subject.id} names (${expectedBundleId})`,
    }
  }
  // @cto 2026-11-13: a row with no measured version cannot bind the ancestry app's version, so it is refused
  // as unprovable rather than skipped — "no measured version" is not agreement.
  if (measuredVersion === undefined) {
    return {
      admit: false,
      unprovable: true,
      refusal: `row has no measured version, so the ancestry app version ${receipt.subject.version} cannot be bound`,
    }
  }
  if (receipt.subject.version !== measuredVersion) {
    return {
      admit: false,
      unprovable: false,
      refusal: `ancestry app is version ${receipt.subject.version}, row measures ${measuredVersion}`,
    }
  }
  if (receipt.witness.exit !== 0 || !receipt.witness.matched) {
    return {
      admit: false,
      unprovable: false,
      refusal:
        `the pasteboard witness did not carry the payload (${receipt.witness.command} exit ` +
        `${String(receipt.witness.exit)}, matched ${String(receipt.witness.matched)})`,
    }
  }
  if (!receipt.baselineRestore.restored) {
    return {
      admit: false,
      unprovable: false,
      refusal: "the pasteboard baseline was not restored, so the run left the person's clipboard changed",
    }
  }
  return { admit: true }
}

/** One link of a LIVE walk, read from the operating system rather than from a receipt. */
export interface LiveAncestryReader {
  /** The parent of `pid`, or undefined when it has none (pid 1, or the process is gone). */
  parent(pid: number): OrdinaryOpenAncestryLink | undefined
}

/**
 * The POSIX reader: `ps -o ppid= -p <pid>` for the parent and `ps -o comm=` for its basename. No host path is
 * recorded — `comm` is the executable's own name, the same vocabulary the receipt's chain uses. A `ps` that fails
 * THROWS: `walkProcessAncestry` lets it through and `checkOrdinaryOpenLiveAncestry` catches it into a named
 * probe-todo, never a grade.
 */
export const posixAncestryReader: LiveAncestryReader = {
  parent(pid) {
    const ppidText = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()
    const ppid = Number(ppidText)
    if (!Number.isSafeInteger(ppid) || ppid < 1) return undefined
    const comm = execFileSync("ps", ["-o", "comm=", "-p", String(ppid)], { encoding: "utf8" }).trim()
    if (comm === "") return undefined
    return { pid: ppid, executable: basename(comm) }
  },
}

/** Walk from `fromPid` to pid 1 or the last readable parent. A cycle is refused rather than looping. */
export function walkProcessAncestry(
  fromPid: number,
  reader: LiveAncestryReader = posixAncestryReader,
): OrdinaryOpenAncestryLink[] {
  const links: OrdinaryOpenAncestryLink[] = []
  const seen = new Set<number>()
  let current = fromPid
  while (true) {
    if (seen.has(current)) {
      throw new Error(
        `Ordinary-open live ancestry (pid ${String(fromPid)}): the parent chain loops at pid ${String(current)}`,
      )
    }
    seen.add(current)
    const parent = reader.parent(current)
    if (parent === undefined) return links
    links.push(parent)
    if (parent.pid === 1) return links
    current = parent.pid
  }
}

export type OrdinaryOpenLiveVerdict =
  | { readonly ok: true; readonly reason: string }
  /** Missing method, never a negative about the terminal: the row keeps its probe-todo wording. */
  | { readonly ok: false; readonly probeTodo: string }

/**
 * At each probe, re-walk the live ancestry and compare it with what the receipt recorded (@cto 2026-11-13). A
 * re-parse of the stored bytes would check nothing that could have moved; this checks that the process holding the
 * clipboard right now is the one the receipt named, still reaching the same app pid.
 */
export function checkOrdinaryOpenLiveAncestry(input: {
  readonly receipt: OrdinaryOpenReceipt
  /**
   * The registry's bundle id for this subject. Required: without it the walk would compare pids and basenames
   * only, and a dead app's pid reused by another process would pass. Missing = probe-todo, never a pass
   * (@cto 2026-11-13).
   */
  readonly expectedBundleId: string | undefined
  readonly probePid: number
  readonly reader?: LiveAncestryReader
}): OrdinaryOpenLiveVerdict {
  const { receipt, expectedBundleId, probePid } = input
  if (expectedBundleId === undefined) {
    return {
      ok: false,
      probeTodo:
        "read method unavailable here: no bundle id is named for this app in the registry, so the live ancestry " +
        "cannot be bound to a bundle",
    }
  }
  let live: OrdinaryOpenAncestryLink[]
  try {
    live = walkProcessAncestry(probePid, input.reader ?? posixAncestryReader)
  } catch (error) {
    return { ok: false, probeTodo: `read method unavailable here: ${(error as Error).message}` }
  }
  const appPid = receipt.ancestry.appPid
  const at = live.findIndex((link) => link.pid === appPid)
  if (at === -1) {
    return {
      ok: false,
      probeTodo:
        `read method unavailable here: the live ancestry from pid ${String(probePid)} does not reach the app pid ` +
        `${String(appPid)} the receipt names`,
    }
  }
  const liveToApp = live.slice(0, at + 1)
  // The receipt's first link IS the probe; a live walk yields ancestors, so the comparable tail starts at 1.
  const recordedAncestors = receipt.ancestry.chain.slice(1)
  if (liveToApp.length !== recordedAncestors.length) {
    return {
      ok: false,
      probeTodo:
        `read method unavailable here: the live ancestry reaches the app in ${String(liveToApp.length)} links, ` +
        `the receipt recorded ${String(recordedAncestors.length)}`,
    }
  }
  for (let index = 0; index < liveToApp.length; index += 1) {
    const now = liveToApp[index] as OrdinaryOpenAncestryLink
    const then = recordedAncestors[index] as OrdinaryOpenAncestryLink
    if (now.pid !== then.pid || now.executable !== then.executable) {
      return {
        ok: false,
        probeTodo:
          `read method unavailable here: live ancestry link ${String(index)} is pid ${String(now.pid)} ` +
          `${now.executable}, the receipt recorded pid ${String(then.pid)} ${then.executable}`,
      }
    }
  }
  // The walk compares pids and basenames, not bundle ids; the receipt binds that pid to the bundle it recorded,
  // and admission already compared the recorded bundle id with the registry. That is why the success line below
  // may name the bundle id without reading it from `ps`.
  return {
    ok: true,
    reason: `ordinary-open re-check: live ancestry still reaches ${expectedBundleId} pid ${String(appPid)}`,
  }
}
