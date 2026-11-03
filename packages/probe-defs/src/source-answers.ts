import type { ProbeSubject } from "./types.ts"

/**
 * The stored key shape of a retired source answer. No result is answered from source (operator 2026-11-03,
 * #32246); the answer table is deleted and stays readable in git history. A stored run still carries these keys,
 * so the reader recognises one by its shape and reads that cell as TEST TODO.
 */
export type SourceAnswerSubject = Pick<ProbeSubject, "kind" | "id" | "version" | "os">

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

