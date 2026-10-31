/** Strict JSON syntax shared by the versioned run and interpretation readers. */
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

/** JSON.parse drops duplicate keys. Reject them before any evidence is selected. */
function rejectDuplicateKeys(source: string, path: string, arrayEntry?: (index: number, source: string) => void): void {
  let i = 0
  const ws = () => {
    // JSON.parse has already checked syntax; JSON whitespace is exactly these four bytes.
    while (i < source.length) {
      const code = source.charCodeAt(i)
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break
      i++
    }
  }
  const quoted = (): void => {
    i++
    while (i < source.length) {
      if (source[i] === "\\") {
        i += 2
        continue
      }
      if (source[i++] === '"') break
    }
  }
  const value = (depth = 0): void => {
    ws()
    if (source[i] === "{") {
      i++
      const keys = new Set<string>()
      ws()
      while (source[i] !== "}") {
        const start = i
        quoted()
        const key = JSON.parse(source.slice(start, i)) as string
        if (keys.has(key)) fail(path, `duplicate key ${key}`)
        keys.add(key)
        ws()
        i++ // colon, already syntax-checked by JSON.parse
        value(depth + 1)
        ws()
        if (source[i] === ",") {
          i++
          ws()
        } else break
      }
      i++
    } else if (source[i] === "[") {
      i++
      ws()
      let index = 0
      while (source[i] !== "]") {
        const start = i
        value(depth + 1)
        if (depth === 0) arrayEntry?.(index++, source.slice(start, i))
        ws()
        if (source[i] === ",") {
          i++
          ws()
        } else break
      }
      i++
    } else if (source[i] === '"') {
      quoted()
    } else {
      while (i < source.length && !/[\s,}\]]/.test(source.charAt(i))) i++
    }
  }
  value()
}

export function parseJsonStrict(
  path: string,
  source: string,
  arrayEntry?: (index: number, source: string) => void,
): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    fail(path, `invalid JSON: ${String(error)}`)
  }
  rejectDuplicateKeys(source, path, arrayEntry)
  return parsed
}

/** Hashable JSON: object key order is incidental; array order and string bytes are evidence. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, current: unknown): unknown =>
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? Object.fromEntries(
          Object.entries(current).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        )
      : current,
  )
}

/**
 * Human-facing prose keys on a `content/features.json` catalogue entry that do not define the
 * criterion or probe contract, and are excluded from the bound entry digest (#32037, @cto d45ebed6).
 * Unknown keys stay bound by default.
 */
export const FEATURE_ENTRY_PROSE_DENYLIST = ["body", "description", "notes", "references", "links", "see-also"] as const

const FEATURE_ENTRY_PROSE_DENYSET = new Set<string>(FEATURE_ENTRY_PROSE_DENYLIST)

/** The canonical catalogue entry minus its denylisted human-facing prose keys; unknown keys still bind. */
export function boundFeatureEntry(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const bound: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!FEATURE_ENTRY_PROSE_DENYSET.has(key)) bound[key] = value
  }
  return bound
}
