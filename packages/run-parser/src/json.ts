/** Strict JSON syntax shared by the versioned run and interpretation readers. */
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}

/** JSON.parse drops duplicate keys. Reject them before any evidence is selected. */
function rejectDuplicateKeys(source: string, path: string): void {
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
  const value = (): void => {
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
        value()
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
      while (source[i] !== "]") {
        value()
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

export function parseJsonStrict(path: string, source: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    fail(path, `invalid JSON: ${String(error)}`)
  }
  rejectDuplicateKeys(source, path)
  return parsed
}
