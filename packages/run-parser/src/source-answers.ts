/** Node I/O boundary shared by the canonical reader, collection writer and site loader. */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { SOURCE_ANSWERS, resolveSourceAnswer, type SourceAnswerInput } from "@terminfo/probe-defs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const blobs = new Map<string, string>()

const identity = (url: string) => url.replace(/^git@github.com:/, "https://github.com/").replace(/\.git$/, "")

function readBlob(repository: string, commit: string, path: string): string | undefined {
  if (!/^[a-f0-9]{40}$/.test(commit) || !path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`Invalid cited source ${repository}@${commit}:${path}`)
  }
  const key = JSON.stringify([repository, commit, path])
  if (blobs.has(key)) return blobs.get(key)
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
  blobs.set(key, oid)
  return oid
}

/** Production callers always supply real object reads to the dependency-free resolver. */
export function resolveMeasuredSourceAnswer(input: Omit<SourceAnswerInput, "readBlob">) {
  return resolveSourceAnswer(SOURCE_ANSWERS, { ...input, readBlob })
}
