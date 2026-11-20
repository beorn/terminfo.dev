// 34753: resolution hook for the Node proof child (see node-ts-resolve.mjs).
import { existsSync, statSync } from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"]

const isFile = (candidate) => {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    const retryable = error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ERR_UNSUPPORTED_DIR_IMPORT"
    if (!retryable || context.parentURL === undefined) throw error
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) throw error
    const base = specifier.startsWith("/")
      ? specifier
      : resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)
    if (existsSync(base) && isFile(base)) return { url: pathToFileURL(base).href, shortCircuit: true }
    for (const suffix of SUFFIXES) {
      if (suffix === "") continue
      const candidate = base + suffix
      if (isFile(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
    }
    throw error
  }
}
