import type { ProbeSubject } from "./types.ts"

export type SourceAnswerSubject = Pick<ProbeSubject, "kind" | "id" | "version" | "os">
export interface SourceAnswer {
  subject: SourceAnswerSubject
  featureId: string
  status: "supported" | "unsupported" | "untestable"
  answers: Array<{ reviewRef: string; reviewer: string; reason: string; sources: string[] }>
  citedBlobs: Array<{ repository: string; commit: string; path: string; oid: string }>
}
export interface SourceAnswerInput {
  subject: SourceAnswerSubject
  featureId: string
  /** Facts resolved from this measured identity, never another build's declaration. */
  blobs?: readonly { repository: string; path: string; oid: string }[]
}
export type SourceAnswerResolution =
  | { kind: "none" }
  | {
      kind: "pending"
      reason: "cited source changed" | "kept answers disagree" | "cited source not resolvable"
      rowKeys: string[]
    }
  | { kind: "answer"; status: SourceAnswer["status"]; rowKeys: string[]; rows: readonly SourceAnswer[]; label?: string }

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
    .map((row) => {
      const states = row.citedBlobs.map((blob) => {
        const facts = (input.blobs ?? []).filter(
          (fact) => fact.repository === blob.repository && fact.path === blob.path && /^[a-f0-9]{40}$/.test(fact.oid),
        )
        const oids = new Set(facts.map((fact) => fact.oid))
        if (oids.size !== 1) return "unavailable"
        return oids.has(blob.oid) ? "same" : "changed"
      })
      const own = row.subject.version === input.subject.version
      const changed = states.includes("changed")
      const verified = states.length > 0 && states.every((state) => state === "same")
      return { row, key: sourceAnswerKey(row.subject, row.featureId), own, changed, verified }
    })
  const pending = (
    reason: "cited source changed" | "kept answers disagree" | "cited source not resolvable",
    matches: typeof candidates,
  ): SourceAnswerResolution => ({ kind: "pending", reason, rowKeys: matches.map((match) => match.key) })
  const ownChanged = candidates.filter((match) => match.own && match.changed)
  if (ownChanged.length) return pending("cited source changed", ownChanged)
  const applicable = candidates.filter((match) => !match.changed && (match.own || match.verified))
  if (new Set(applicable.map((match) => match.row.status)).size > 1) {
    return pending("kept answers disagree", applicable)
  }
  const first = applicable[0]
  if (first) {
    // A changed older answer is not qualifying evidence against a separately valid row.
    const unverified = applicable.find((match) => !match.verified)
    return {
      kind: "answer",
      status: first.row.status,
      rows: applicable.map((match) => match.row),
      rowKeys: applicable.map((match) => match.key),
      ...(unverified && { label: `reviewed at ${unverified.row.subject.version}, not re-verified` }),
    }
  }
  const changed = candidates.filter((match) => match.changed)
  if (changed.length) return pending("cited source changed", changed)
  const unavailable = candidates.filter((match) => match.row.citedBlobs.length > 0 && !match.verified)
  return unavailable.length ? pending("cited source not resolvable", unavailable) : { kind: "none" }
}
