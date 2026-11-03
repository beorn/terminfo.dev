import type { HeadlessRuntimeIdentity, ProbeSubject } from "./types.ts"
import retainedAnswers from "./source-answers.json"

export type SourceAnswerSubject = Pick<ProbeSubject, "kind" | "id" | "version" | "os">
export interface SourceAnswer {
  subject: SourceAnswerSubject
  featureId: string
  answers: Array<{
    status: "supported" | "unsupported" | "untestable"
    citedBlobs: Array<{ repository: string; commit: string; path: string; oid: string }>
    originals: Array<{ reviewRef: string; reviewer: string; reason: string; sources: string[] }>
  }>
}
export interface SourceAnswerInput {
  subject: SourceAnswerSubject
  featureId: string
  /** Facts resolved from this measured identity, never another build's declaration. */
  blobs?: readonly { repository: string; path: string; oid: string }[]
  runtimeIdentity?: HeadlessRuntimeIdentity
  sourceRevision?: string | null
  /** The I/O boundary resolves only this repository's immutable commit/path, or reports object absence. */
  readBlob?: (repository: string, commit: string, path: string) => string | undefined
  /**
   * The engine build receipt the I/O owner read at the pinned Termless revision. It names the engine source the
   * loaded binary was built from and the wasm that build produced (@cto de41833e condition 2).
   */
  engineReceipt?: EngineReceipt
}

export interface EngineReceipt {
  readonly outputs: Readonly<Record<string, string>>
  readonly core: { readonly repository: string; readonly commit: string }
}

/** Owner/repo identity, so a citation may spell the same repository as a remote or a URL. */
export function repositoryIdentity(repository: string): string {
  return repository
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

const ENGINE_CORE_REPOSITORY = "https://github.com/ghostty-org/ghostty"
const ENGINE_OUTPUT = "ghostty-vt.wasm"
const VT100_RUST_PREFIX = "packages/vt100-rust/"

/** Static kept answers; the one-time converter checks the source/provenance and emitted shape. */
export const SOURCE_ANSWERS = retainedAnswers as readonly SourceAnswer[]

export function sourceAnswerForRef(ref: string): SourceAnswer | undefined {
  const key = parseSourceAnswerKey(ref)
  if (!key) return undefined
  const row = SOURCE_ANSWERS.find((row) => sourceAnswerKey(row.subject, row.featureId) === ref)
  if (!row) throw new Error(`Missing source-answer row ${ref}`)
  return row
}
export type SourceAnswerResolution =
  | { kind: "none" }
  | {
      kind: "pending"
      reason:
        | "cited source changed"
        | "kept answers disagree"
        | "cited source not resolvable"
        | `cited source not resolvable at ${string}`
      rowKeys: string[]
      /** Every kept answer that disagreed, so a pending cell can name each original rather than only its key. */
      answers?: readonly SourceAnswer["answers"][number][]
    }
  | {
      kind: "answer"
      status: SourceAnswer["answers"][number]["status"]
      rowKeys: string[]
      rows: readonly SourceAnswer[]
      answers: readonly SourceAnswer["answers"][number][]
      label?: string
    }

export function sourceAnswerKey(subject: SourceAnswerSubject, featureId: string): string {
  return JSON.stringify([subject.kind, subject.id, subject.version, subject.os, featureId])
}

export function parseSourceAnswerKey(ref: string): { subject: SourceAnswerSubject; featureId: string } | undefined {
  if (!ref.startsWith("[")) return undefined
  let value: unknown
  try {
    value = JSON.parse(ref)
  } catch (cause) {
    throw new Error(`Invalid source-answer key ${ref}`, { cause })
  }
  if (!Array.isArray(value) || value.length !== 5) throw new Error(`Invalid source-answer key ${ref}`)
  const [kind, id, version, os, featureId] = value
  if (
    (kind !== "term" && kind !== "lib" && kind !== "mux") ||
    typeof id !== "string" ||
    !id ||
    typeof version !== "string" ||
    !version ||
    typeof featureId !== "string" ||
    !featureId ||
    !(os === null || (typeof os === "string" && os.length > 0))
  ) {
    throw new Error(`Invalid source-answer key ${ref}`)
  }
  const subject: SourceAnswerSubject = { kind, id, version, os }
  if (sourceAnswerKey(subject, featureId) !== ref) {
    throw new Error(`Invalid source-answer key ${ref}: noncanonical tuple`)
  }
  return { subject, featureId }
}

/** Resolve only existing kept answers. This function does not perform I/O or establish source identity. */
export function resolveSourceAnswer(rows: readonly SourceAnswer[], input: SourceAnswerInput): SourceAnswerResolution {
  const candidates = rows
    .filter(
      (row) =>
        row.featureId === input.featureId &&
        row.subject.kind === input.subject.kind &&
        row.subject.id === input.subject.id &&
        row.subject.os === input.subject.os,
    )
    .flatMap((row) =>
      row.answers.map((answer) => {
        const states = answer.citedBlobs.map(
          (
            blob,
          ):
            | { kind: "same" | "changed" | "unknown" }
            | { kind: "unavailable"; reason?: `cited source not resolvable at ${string}` } => {
            const runtime = input.runtimeIdentity
            const source =
              runtime?.kind === "js" &&
              runtime.integrity.kind === "source" &&
              runtime.integrity.repository === blob.repository
                ? runtime.integrity
                : undefined
            const core = repositoryIdentity(blob.repository) === repositoryIdentity(ENGINE_CORE_REPOSITORY)
            const loaded = runtime !== undefined && "loadedBinary" in runtime ? runtime.loadedBinary.sha256 : undefined
            const receipt = input.engineReceipt
            // The receipt speaks only for the binary it built; another artifact never borrows it.
            const receiptApplies =
              receipt !== undefined && loaded !== undefined && receipt.outputs[ENGINE_OUTPUT] === loaded
            if (core && receiptApplies && blob.commit !== receipt.core.commit) {
              throw new Error(
                `Engine citation ${blob.repository}@${blob.commit}:${blob.path} differs from the build receipt's ${receipt.core.commit}`,
              )
            }
            // The addon is built at its own source commit, not at the pinned Termless revision; a path the
            // measured identity cannot place is covered by neither and stays unresolvable (@cto de41833e c3).
            const addon =
              blob.repository === "git@github.com:beorn/termless.git" && blob.path.startsWith(VT100_RUST_PREFIX)
            const revision =
              source?.revision ??
              (core
                ? receiptApplies
                  ? receipt.core.commit
                  : undefined
                : blob.repository === "git@github.com:beorn/termless.git"
                  ? addon
                    ? runtime?.kind === "native"
                      ? runtime.provenance.sourceCommit
                      : undefined
                    : runtime?.termlessRevision
                  : blob.repository === "git@github.com:beorn/terminfo.dev.git"
                    ? input.sourceRevision
                    : undefined)
            const unavailable = (at = revision) => ({
              kind: "unavailable" as const,
              ...(at && { reason: `cited source not resolvable at ${blob.repository}@${at.slice(0, 12)}` as const }),
            })
            const facts = [
              ...(input.blobs ?? []),
              ...(blob.repository === "git@github.com:beorn/termless.git"
                ? (runtime?.adapterSources ?? []).map((source) => ({
                    repository: blob.repository,
                    path: source.path,
                    oid: source.blobOid,
                  }))
                : []),
            ].filter(
              (fact) =>
                fact.repository === blob.repository && fact.path === blob.path && /^[a-f0-9]{40}$/.test(fact.oid),
            )
            const oids = new Set(facts.map((fact) => fact.oid))
            // An exact immutable commit addresses the converted blob. A different commit
            // alone does not establish whether this path changed. Explicit path OIDs win.
            if (oids.size === 1) return { kind: oids.has(blob.oid) ? "same" : "changed" }
            if (oids.size > 1 || source?.cleanTree === false) return unavailable()
            // An engine citation this binary's receipt does not describe is unresolvable, never borrowed.
            if (core && !receiptApplies) return unavailable()
            if (addon && !revision) return unavailable()
            if (!revision) return { kind: "unknown" }
            // The receipt names the commit but no engine checkout is declared, so the blob stays unread: covered,
            // not verified. A declared checkout (readBlob) is the only cure, never a fallback (@cto de41833e c4).
            if (core && revision === blob.commit) return { kind: "unknown" }
            if (revision === blob.commit) return { kind: "same" }
            const current = input.readBlob?.(blob.repository, revision, blob.path)
            if (!current) return unavailable()
            const cited = input.readBlob?.(blob.repository, blob.commit, blob.path)
            if (!cited) return unavailable(blob.commit)
            if (cited !== blob.oid) {
              throw new Error(`Source-answer citation OID differs at ${blob.repository}@${blob.commit}:${blob.path}`)
            }
            return { kind: current === cited ? "same" : "changed" }
          },
        )
        const own = row.subject.version === input.subject.version
        const changed = states.some((state) => state.kind === "changed")
        const verified = states.length > 0 && states.every((state) => state.kind === "same")
        const unavailable = states.find((state) => state.kind === "unavailable")
        return { row, answer, key: sourceAnswerKey(row.subject, row.featureId), own, changed, verified, unavailable }
      }),
    )
  const pending = (
    reason: Extract<SourceAnswerResolution, { kind: "pending" }>["reason"],
    matches: typeof candidates,
  ): SourceAnswerResolution => ({
    kind: "pending",
    reason,
    rowKeys: [...new Set(matches.map((match) => match.key))],
    // Only a disagreement needs each original named; other pending reasons point at one candidate set.
    ...(reason === "kept answers disagree" && { answers: [...new Set(matches.map((match) => match.answer))] }),
  })
  const applicable = candidates.filter((match) => !match.changed && !match.unavailable && (match.own || match.verified))
  if (new Set(applicable.map((match) => match.answer.status)).size > 1) {
    return pending("kept answers disagree", applicable)
  }
  const first = applicable[0]
  if (first) {
    // A changed older answer is not qualifying evidence against a separately valid row.
    const unverified = applicable.find((match) => !match.verified)
    return {
      kind: "answer",
      status: first.answer.status,
      rows: [...new Set(applicable.map((match) => match.row))],
      answers: applicable.map((match) => match.answer),
      rowKeys: [...new Set(applicable.map((match) => match.key))],
      ...(unverified && { label: `reviewed at ${unverified.row.subject.version}, not re-verified` }),
    }
  }
  const changed = candidates.filter((match) => match.changed)
  if (changed.length) return pending("cited source changed", changed)
  const missing = candidates.find((match) => match.unavailable?.reason)
  if (missing?.unavailable?.reason) return pending(missing.unavailable.reason, candidates)
  return candidates.length ? pending("cited source not resolvable", candidates) : { kind: "none" }
}
