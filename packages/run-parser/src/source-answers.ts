/** Node I/O boundary shared by the canonical reader, collection writer and site loader. */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { SOURCE_ANSWERS, resolveSourceAnswer, type EngineReceipt, type SourceAnswerInput } from "@terminfo/probe-defs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const blobs = new Map<string, string>()
const texts = new Map<string, string>()

const identity = (url: string) => url.replace(/^git@github.com:/, "https://github.com/").replace(/\.git$/, "")

/** One repository read: the object id by default, or the blob content when `want` is "blob". */
function readSource(
  repository: string,
  commit: string,
  path: string,
  want: "oid" | "blob",
  cache = blobs,
): string | undefined {
  if (!/^[a-f0-9]{40}$/.test(commit) || !path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Invalid cited source ${repository}@${commit}:${path}`)
  }
  const key = JSON.stringify([repository, commit, path])
  if (cache.has(key)) return cache.get(key)
  // Source siblings use their repository basename; the remote check proves ownership.
  const name = /(?:[:/])([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(repository)?.[1]
  if (!name || name === "." || name === "..") throw new Error(`Cannot locate cited repository ${repository}@${commit}`)
  let repo = name === "terminfo.dev" ? root : resolve(root, "..", name)
  if (name !== "terminfo.dev" && !existsSync(repo)) {
    const manifestPath = resolve(root, "source-siblings.json")
    if (!existsSync(manifestPath)) {
      throw new Error(`Missing source repository ${repository}@${commit}: checked ${repo} and ${manifestPath}`)
    }
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (!manifest || typeof manifest !== "object" || !("siblings" in manifest) || !Array.isArray(manifest.siblings)) {
      throw new Error(`Invalid source sibling declarations at ${manifestPath}, needed ${repository}@${commit}`)
    }
    const index = manifest.siblings.findIndex(
      (entry: unknown) =>
        entry &&
        typeof entry === "object" &&
        "repository" in entry &&
        typeof entry.repository === "string" &&
        identity(`https://github.com/${entry.repository}.git`) === identity(repository),
    )
    if (index < 0) {
      throw new Error(
        `Missing source repository ${repository}@${commit}: no declaration in ${manifestPath}; checked ${repo}`,
      )
    }
    repo = resolve(root, ".ci-siblings", String(index))
  }
  const context = `${repository}@${commit} (checkout ${repo})`
  if (!existsSync(repo)) throw new Error(`Missing source repository ${context}; provide its complete source checkout`)
  const git = (args: string[], input?: string) => {
    const result = spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      input,
      timeout: 30000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    if (result.error) {
      throw new Error(`Cannot read source ${context}:${path}: ${result.error.message}`, { cause: result.error })
    }
    return result
  }
  {
    const remote = git(["remote", "get-url", "origin"])
    if (remote.status !== 0 || identity(remote.stdout.trim()) !== identity(repository)) {
      throw new Error(`Source repository identity mismatch for ${context}`)
    }
    const shallow = git(["rev-parse", "--is-shallow-repository"])
    if (shallow.status !== 0 || shallow.stdout.trim() !== "false") {
      throw new Error(
        `Complete source history required for ${context}: ${shallow.stderr.trim() || shallow.stdout.trim()}`,
      )
    }
  }
  const expression = `${commit}:${path}`
  const object = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${expression}\n`)
  if (object.status !== 0) throw new Error(`Cannot read cited source ${context}:${path}: ${object.stderr.trim()}`)
  if (object.stdout.trim() === `${expression} missing`) {
    const promisor = git(["config", "--get-regexp", "remote\\..*\\.promisor"])
    if (promisor.status !== 1) {
      throw new Error(`Incomplete source objects for ${context}:${path}; provide complete repository history`)
    }
    // Absence is not immutable and is deliberately not cached.
    return undefined
  }
  const match = /^([a-f0-9]{40}) blob$/.exec(object.stdout.trim())
  const oid = match?.[1]
  if (!oid) throw new Error(`Cited source is not a blob at ${context}:${path}: ${object.stdout.trim()}`)
  if (want === "oid") {
    cache.set(key, oid)
    return oid
  }
  const content = git(["cat-file", "blob", oid])
  if (content.status !== 0) {
    throw new Error(`Cannot read cited source content ${context}:${path}: ${content.stderr.trim()}`)
  }
  cache.set(key, content.stdout)
  return content.stdout
}

function readBlob(repository: string, commit: string, path: string): string | undefined {
  return readSource(repository, commit, path, "oid")
}

interface EngineReceipt {
  outputs: Record<string, string>
  core: { repository: string; commit: string }
}

const receipts = new Map<string, EngineReceipt | undefined>()

/**
 * The engine build receipt the pinned Termless revision ships, read through this same I/O boundary. A malformed
 * receipt is loud; an absent one grants no attribution.
 */
function engineReceipt(revision: string | undefined): EngineReceipt | undefined {
  if (!revision) return undefined
  if (receipts.has(revision)) return receipts.get(revision)
  const source = readSource(
    "git@github.com:beorn/termless.git",
    revision,
    "vendor/ghostty-web/RECEIPT.json",
    "blob",
    texts,
  )
  if (source === undefined) {
    receipts.set(revision, undefined)
    return undefined
  }
  const raw: unknown = JSON.parse(source)
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
  const outputs = object(raw) ? raw.outputs : undefined
  const core = object(raw) ? raw.core : undefined
  if (
    !object(outputs) ||
    !Object.values(outputs).every((value) => typeof value === "string") ||
    !object(core) ||
    typeof core.repository !== "string" ||
    !/^[a-f0-9]{40}$/.test(String(core.commit))
  ) {
    throw new Error(
      `Invalid engine build receipt at termless@${revision.slice(0, 12)}: require outputs and core.commit`,
    )
  }
  const receipt: EngineReceipt = {
    outputs: outputs as Record<string, string>,
    core: { repository: core.repository, commit: String(core.commit) },
  }
  receipts.set(revision, receipt)
  return receipt
}

/**
 * Production callers always supply real object reads to the dependency-free resolver, plus the build receipt for
 * the loaded binary so an engine citation is attributed to the commit that actually built it.
 */
export function resolveMeasuredSourceAnswer(input: Omit<SourceAnswerInput, "readBlob" | "engineReceipt">) {
  const receipt = readEngineReceipt(input.runtimeIdentity)
  return resolveSourceAnswer(SOURCE_ANSWERS, { ...input, readBlob, ...(receipt && { engineReceipt: receipt }) })
}

/** The receipt speaks only for an identity that names the binary it built. */
export function readEngineReceipt(runtime: SourceAnswerInput["runtimeIdentity"]): EngineReceipt | undefined {
  return runtime !== undefined && "loadedBinary" in runtime ? engineReceipt(runtime.termlessRevision) : undefined
}
