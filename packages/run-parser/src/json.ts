/** Strict JSON syntax shared by the versioned run and interpretation readers. */
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

/** JSON.parse drops duplicate keys. Reject them before any evidence is selected. */
function rejectDuplicateKeys(source: string, path: string, arrayEntry?: (index: number, source: string) => void): void {
  // JSON.parse has already checked syntax, so this walk reads char codes only: a stored run is megabytes, and
  // a one-character string or a regex test per character cost the site build 16 s of a 40 s corpus load (34904).
  const SPACE = 0x20
  const TAB = 0x09
  const LF = 0x0a
  const CR = 0x0d
  const QUOTE = 0x22
  const BACKSLASH = 0x5c
  const COMMA = 0x2c
  const OPEN_OBJECT = 0x7b
  const CLOSE_OBJECT = 0x7d
  const OPEN_ARRAY = 0x5b
  const CLOSE_ARRAY = 0x5d
  const length = source.length
  let i = 0
  const ws = () => {
    // JSON whitespace is exactly these four bytes.
    while (i < length) {
      const code = source.charCodeAt(i)
      if (code !== SPACE && code !== TAB && code !== LF && code !== CR) break
      i++
    }
  }
  /** Skips one string from its opening quote: native search to each quote, kept only after an even backslash run. */
  const quoted = (): void => {
    let from = i + 1
    for (;;) {
      const close = source.indexOf('"', from)
      if (close === -1) {
        i = length
        return
      }
      let backslashes = 0
      while (source.charCodeAt(close - 1 - backslashes) === BACKSLASH) backslashes++
      from = close + 1
      if (backslashes % 2 === 0) break
    }
    i = from
  }
  const value = (depth = 0): void => {
    ws()
    const code = source.charCodeAt(i)
    if (code === OPEN_OBJECT) {
      i++
      const keys = new Set<string>()
      ws()
      while (source.charCodeAt(i) !== CLOSE_OBJECT) {
        const start = i
        quoted()
        // Only an escaped key needs decoding; any other key's bytes between the quotes are the key.
        const raw = source.slice(start + 1, i - 1)
        const key = raw.includes("\\") ? (JSON.parse(source.slice(start, i)) as string) : raw
        if (keys.has(key)) fail(path, `duplicate key ${key}`)
        keys.add(key)
        ws()
        i++ // colon, already syntax-checked by JSON.parse
        value(depth + 1)
        ws()
        if (source.charCodeAt(i) === COMMA) {
          i++
          ws()
        } else break
      }
      i++
    } else if (code === OPEN_ARRAY) {
      i++
      ws()
      let index = 0
      while (source.charCodeAt(i) !== CLOSE_ARRAY) {
        const start = i
        value(depth + 1)
        if (depth === 0) arrayEntry?.(index++, source.slice(start, i))
        ws()
        if (source.charCodeAt(i) === COMMA) {
          i++
          ws()
        } else break
      }
      i++
    } else if (code === QUOTE) {
      quoted()
    } else {
      // A number, true, false or null ends at whitespace, a comma or a closing bracket.
      while (i < length) {
        const next = source.charCodeAt(i)
        if (next === SPACE || next === TAB || next === LF || next === CR || next === COMMA) break
        if (next === CLOSE_OBJECT || next === CLOSE_ARRAY) break
        i++
      }
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
 * Human-facing prose keys that `FeatureRecord` in `content/features.json` carries at the pin and
 * that are excluded from the bound entry digest (#32037, @cto d45ebed6 / 138596ae).
 * Unknown keys stay bound by default.
 */
export const FEATURE_ENTRY_PROSE_DENYLIST = ["body"] as const

const FEATURE_ENTRY_PROSE_DENYSET = new Set<string>(FEATURE_ENTRY_PROSE_DENYLIST)

/** The canonical catalogue entry minus its denylisted human-facing prose keys; unknown keys still bind. */
export function boundFeatureEntry(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const bound: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!FEATURE_ENTRY_PROSE_DENYSET.has(key)) bound[key] = value
  }
  return bound
}
