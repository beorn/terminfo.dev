/** Identify the engine loaded by a Termless adapter, never its manifest's desired version. */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { HeadlessRuntimeIdentity } from "@terminfo/probe-defs"
import type { ReplyDeliveryExtension } from "@termless/core"
import { owningCheckout } from "./termless-root.ts"

/** The already measured module/engine used by this worker's backend factory. */
export interface HeadlessProbeRuntime {
  readonly identity: HeadlessRuntimeIdentity
  readonly adapterPath: string
  readonly adapterPackage: string
  readonly adapterType: string
}

type ReplyDelivery = ReplyDeliveryExtension["replyDelivery"]

export interface ReplyPathDecision {
  readonly member: boolean
  readonly backend: string
  readonly reason: string
  readonly declaration?: ReplyDelivery
  readonly runtimeIdentity?: HeadlessRuntimeIdentity
}

/** One eligibility comparison; neither an adapter declaration nor versions authenticate source. */
export function replyDeliveryDecision(
  backend: string,
  declaration: ReplyDelivery | undefined,
  runtime: HeadlessProbeRuntime | undefined,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): ReplyPathDecision {
  const decide = (member: boolean, reason: string): ReplyPathDecision => {
    if (!member) warn(`headless ${reason}`)
    return {
      member,
      backend,
      reason,
      ...(declaration && { declaration }),
      ...(runtime && { runtimeIdentity: runtime.identity }),
    }
  }
  if (!declaration) return decide(false, `${backend} declares no reply delivery`)
  if (!runtime) return decide(false, `${backend} has no measured runtime identity for reply delivery`)
  if (
    declaration.boundary !== "feed-and-getCursor" ||
    !Array.isArray(declaration.adapterSources) ||
    !declaration.adapterSources.length
  ) {
    return decide(false, `${backend} reply delivery has no audited feed-and-getCursor source binding`)
  }

  const identity = runtime.identity
  const expected = declaration.engine
  if (!record(expected)) return decide(false, `${backend} reply delivery has no audited engine binding`)
  if (expected.kind === "registry") {
    if (
      identity.kind !== "js" ||
      identity.runtimeFormat !== "js" ||
      identity.integrity.kind !== "registry" ||
      identity.integrity.lockIntegrity !== expected.lockIntegrity
    ) {
      return decide(false, `${backend} reply delivery engine.lockIntegrity differs from the audited registry integrity`)
    }
  } else if (expected.kind === "source") {
    if (
      identity.kind !== "js" ||
      identity.runtimeFormat !== "js" ||
      identity.integrity.kind !== "source" ||
      identity.integrity.repository !== expected.repository ||
      identity.integrity.treeOid !== expected.treeOid ||
      identity.integrity.cleanTree !== true
    ) {
      return decide(
        false,
        `${backend} reply delivery engine repository/treeOid/cleanTree differs from the audited source`,
      )
    }
  } else if (expected.kind === "wasm") {
    if (
      identity.kind !== "js" ||
      identity.runtimeFormat !== "wasm" ||
      identity.loadedBinary.sha256 !== expected.sha256
    ) {
      return decide(false, `${backend} reply delivery engine.sha256 differs from the loaded WASM`)
    }
  } else if (expected.kind === "native") {
    if (
      identity.kind !== "native" ||
      typeof expected.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      !record(identity.loadedBinary) ||
      identity.loadedBinary.sha256 !== expected.sha256
    ) {
      return decide(false, `${backend} reply delivery engine.sha256 differs from the loaded native binary`)
    }
  } else {
    return decide(false, `${backend} reply delivery has no recognized audited engine binding`)
  }

  try {
    // Resolve from the exact URL imported for resolve(), never a neighboring vendor checkout.
    const entry = realpathSync(runtime.adapterPath)
    const checkout = owningCheckout(entry, runtime.adapterPackage)
    if (git(checkout, "rev-parse", "HEAD") !== identity.termlessRevision) {
      return decide(false, `${backend} reply delivery adapter revision differs from the measured runtime`)
    }
    const entryPath = relative(checkout, entry)
    if (!declaration.adapterSources.some((source) => source.path === entryPath)) {
      return decide(false, `${backend} reply delivery adapterSources does not bind the imported entry ${entryPath}`)
    }
    for (const source of declaration.adapterSources) {
      if (!record(source) || typeof source.path !== "string" || typeof source.blobOid !== "string") {
        return decide(false, `${backend} reply delivery adapterSources has no path/blobOid binding`)
      }
      const path = realpathSync(resolve(checkout, source.path))
      if (!inside(path, checkout) || relative(checkout, path) !== source.path) {
        return decide(
          false,
          `${backend} reply delivery adapterSources path is outside its imported checkout: ${source.path}`,
        )
      }
      git(checkout, "ls-files", "--error-unmatch", source.path)
      // hash-object reads the bytes actually imported, including an edit before its commit.
      const actual = git(checkout, "hash-object", path)
      if (actual !== source.blobOid) {
        return decide(
          false,
          `${backend} reply delivery adapterSources.${source.path} differs: expected ${source.blobOid}, actual ${actual}`,
        )
      }
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return decide(false, `${backend} source-backed reply delivery unavailable (dist-only loses coverage): ${detail}`)
  }
  return decide(true, `${backend} declares complete reply delivery bound to its loaded source and engine`)
}

const MODULE_PATH = fileURLToPath(import.meta.url)
const TERMINFO_ROOT = realpathSync(resolve(dirname(MODULE_PATH), "../.."))
const VENDOR_ROOT = resolve(TERMINFO_ROOT, "..")

function ownedCheckout(path: string, name: string): string {
  try {
    return realpathSync(path)
  } catch (cause) {
    throw new Error(`Local headless v2 collection requires the owned ${name} checkout at ${path}`, { cause })
  }
}

const VTERM_ROOT = join(VENDOR_ROOT, "vterm")
const CODE_ROOT = resolve(VENDOR_ROOT, "..")
const UPSTREAM_PACKAGES: Record<string, string> = {
  xtermjs: "@xterm/headless",
  ghostty: "ghostty-web",
  vt100: "vt100.js",
  vt220: "vt220.js",
  vterm: "vterm.js",
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function inside(path: string, directory: string): boolean {
  const rel = relative(directory, path)
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/")
}

/**
 * The path a run file records for a loaded file. Run files are published, so it names the file
 * from the workspace's vendor/ or node_modules/ tree, or by its content-addressed Nix store path;
 * any other absolute path would publish the collecting host's folders.
 */
export function recordedPath(path: string): string {
  if (path.startsWith("/nix/store/")) return path
  const anchor = /\/(?:vendor|node_modules)\//.exec(path)
  if (!anchor) {
    throw new Error(
      `Cannot record ${basename(path)} in a run file: it is outside the workspace's vendor/ and node_modules/ trees and the Nix store`,
    )
  }
  return path.slice(anchor.index + 1)
}

function resolvedPackage(specifier: string, importer: string): { path: string; directory: string; version: string } {
  const path = realpathSync(Bun.resolveSync(specifier, importer))
  let directory = dirname(path)
  while (true) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
      if (record(manifest) && manifest.name === specifier && typeof manifest.version === "string") {
        return { path, directory, version: manifest.version }
      }
    } catch (error) {
      if (!record(error) || error.code !== "ENOENT") throw error
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Resolved ${specifier} at ${path} without its package manifest`)
    directory = parent
  }
}

function readLock(): Record<string, unknown> {
  const lock: unknown = Bun.JSONC.parse(readFileSync(join(CODE_ROOT, "bun.lock"), "utf8"))
  if (!record(lock) || !record(lock.packages)) throw new Error("Root bun.lock has no packages map")
  return lock
}

function lockPackages(): Record<string, unknown> {
  const packages = readLock().packages
  if (!record(packages)) throw new Error("Root bun.lock has no packages map")
  return packages
}

export function registryIntegrity(name: string, version: string): { kind: "registry"; lockIntegrity: string } {
  const entry = lockPackages()[name]
  if (
    !Array.isArray(entry) ||
    entry[0] !== `${name}@${version}` ||
    typeof entry[3] !== "string" ||
    !/^sha(256|512)-/.test(entry[3])
  ) {
    throw new Error(`Installed ${name}@${version} has no matching registry integrity in root bun.lock`)
  }
  return { kind: "registry", lockIntegrity: entry[3] }
}

/** Map copied local installs back to their owned file: override or workspace: lock entry. */
function fileLinkWorkspace(name: string, termlessRoot: string): string | undefined {
  const lock = readLock()
  const override = record(lock.overrides) ? lock.overrides[name] : undefined
  const entry = record(lock.packages) ? lock.packages[name] : undefined
  const prefix = `${name}@workspace:`
  const sourcePath =
    typeof override === "string" && override.startsWith("file:")
      ? override.slice("file:".length)
      : Array.isArray(entry) && typeof entry[0] === "string" && entry[0].startsWith(prefix)
        ? entry[0].slice(prefix.length)
        : undefined
  if (sourcePath === undefined) return undefined
  const workspace = realpathSync(resolve(CODE_ROOT, sourcePath))
  if (!inside(workspace, VTERM_ROOT) && !inside(workspace, termlessRoot)) {
    throw new Error(`file: ${name} at ${workspace} is outside owned Termless/vterm checkouts`)
  }
  return workspace
}

function listPackageFiles(directory: string): string[] {
  const out: string[] = []
  const walk = (relativeDir: string) => {
    const entries = readdirSync(join(directory, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(rel)
      else if (entry.isFile()) out.push(rel)
    }
  }
  walk("")
  return out.sort()
}

function installedBytesMustMatchWorkspace(installedDir: string, workspace: string, specifier: string): void {
  const files = listPackageFiles(installedDir)
  if (files.length === 0) throw new Error(`Installed ${specifier} at ${installedDir} has no files to bind`)
  for (const rel of files) {
    const installedPath = join(installedDir, rel)
    const workspacePath = join(workspace, rel)
    let workspaceBytes: Buffer
    try {
      workspaceBytes = readFileSync(workspacePath)
    } catch (cause) {
      throw new Error(`Installed ${specifier} file ${rel} is not in file: workspace ${workspace}`, { cause })
    }
    if (sha256(readFileSync(installedPath)) !== sha256(workspaceBytes)) {
      throw new Error(
        `Installed ${specifier} at ${installedPath} disagrees with file: workspace source at ${workspacePath}`,
      )
    }
  }
}

/** Bind a bun file: install to the owned workspace. Name/version agreement is not enough. */
export function fileLinkIntegrity(
  upstream: { path: string; directory: string; version: string },
  workspace: string,
  specifier: string,
  termlessRoot: string,
): ReturnType<typeof sourceIntegrity> {
  const manifest: unknown = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"))
  if (!record(manifest) || manifest.name !== specifier || typeof manifest.version !== "string") {
    throw new Error(`file: workspace ${workspace} is not package ${specifier}`)
  }
  if (manifest.version !== upstream.version) {
    throw new Error(
      `Installed ${specifier}@${upstream.version} disagrees with file: workspace version ${manifest.version} at ${workspace}`,
    )
  }
  installedBytesMustMatchWorkspace(upstream.directory, workspace, specifier)
  const resolvedRel = relative(upstream.directory, upstream.path)
  if (resolvedRel.startsWith("..") || resolvedRel.startsWith("/")) {
    throw new Error(`Resolved ${specifier} at ${upstream.path} is outside its installed package ${upstream.directory}`)
  }
  return sourceIntegrity(join(workspace, "package.json"), workspace, termlessRoot)
}

function sourceIntegrity(
  path: string,
  directory: string,
  termlessRoot: string,
): {
  kind: "source"
  repository: string
  revision: string
  treeOid: string
  cleanTree: boolean
} {
  const repo = inside(path, VTERM_ROOT) ? VTERM_ROOT : termlessRoot
  if (!inside(path, repo) || !inside(directory, repo)) {
    throw new Error(`Loaded source ${path} is outside the expected Termless/vterm checkouts`)
  }
  const packagePath = relative(repo, directory)
  const revision = git(repo, "rev-parse", "HEAD")
  const treeOid = git(repo, "rev-parse", `HEAD:${packagePath}`)
  const cleanTree = !git(repo, "status", "--porcelain", "--", packagePath)
  return {
    kind: "source",
    repository: git(repo, "remote", "get-url", "origin"),
    revision,
    treeOid,
    cleanTree,
  }
}

function loadedAddon(adapterDirectory: string): { path: string; sha256: string } {
  // Termless's Bun adapters already load these addons through require(); inspect
  // that existing cache without loading a second CommonJS module instance.
  const paths = Object.keys(require.cache).filter((path) => path.endsWith(".node") && inside(path, adapterDirectory))
  if (paths.length !== 1) {
    throw new Error(
      `Expected one loaded native addon in ${adapterDirectory}; found ${paths.length}: ${paths.join(", ")}`,
    )
  }
  const [loadedPath] = paths
  if (!loadedPath) throw new Error(`Native addon cache lost the loaded path in ${adapterDirectory}`)
  const path = realpathSync(loadedPath)
  return { path, sha256: sha256(readFileSync(path)) }
}

/**
 * The `nativeTreeOid` recorded in the loaded native addon's `.receipt.json` (#31774).
 * Kitty is typed `"native"` in `backends.json` but is a `kitty +runpy` subprocess bridge that loads no `.node` addon (#31810).
 */
export function readNativeArtifactTreeOid(adapterSpecifier: string, name?: string): string | undefined {
  if (name === "kitty" || adapterSpecifier === "@termless/kitty" || adapterSpecifier.endsWith("/kitty")) {
    return undefined
  }
  const adapter = resolvedPackage(adapterSpecifier, MODULE_PATH)
  const loadedBinary = loadedAddon(adapter.directory)
  const receipt: unknown = JSON.parse(readFileSync(`${loadedBinary.path}.receipt.json`, "utf8"))
  return record(receipt) && typeof receipt.nativeTreeOid === "string" ? receipt.nativeTreeOid : undefined
}

function sidecarIdentity(
  adapterDirectory: string,
  adapterVersion: string,
  termlessRevision: string,
  termlessRoot: string,
): HeadlessRuntimeIdentity {
  const loadedBinary = loadedAddon(adapterDirectory)
  const receiptPath = `${loadedBinary.path}.receipt.json`
  const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"))
  if (
    !record(receipt) ||
    receipt.sha256 !== loadedBinary.sha256 ||
    typeof receipt.engineVersion !== "string" ||
    typeof receipt.sourceCommit !== "string" ||
    typeof receipt.buildHash !== "string" ||
    typeof receipt.toolchain !== "string" ||
    typeof receipt.lockSha256 !== "string" ||
    typeof receipt.nativeTreeOid !== "string"
  ) {
    throw new Error(`Native addon receipt missing or does not match loaded binary: ${receiptPath}`)
  }
  const packagePath = relative(termlessRoot, adapterDirectory)
  const currentTreeOid = git(termlessRoot, "rev-parse", `HEAD:${packagePath}/native`)
  if (receipt.nativeTreeOid !== currentTreeOid) {
    throw new Error(`Native addon receipt source tree differs from current adapter: ${receiptPath}`)
  }
  const lockPath = join(
    adapterDirectory,
    "native",
    packagePath.endsWith("ghostty-native") ? ".ghostty-src/flake.lock" : "Cargo.lock",
  )
  if (receipt.lockSha256 !== sha256(readFileSync(lockPath))) {
    throw new Error(`Native addon receipt lock differs from current build inputs: ${receiptPath}`)
  }
  return {
    kind: "native",
    engineVersion: receipt.engineVersion,
    adapterVersion,
    termlessRevision,
    loadedBinary: { path: recordedPath(loadedBinary.path), sha256: loadedBinary.sha256 },
    provenance: {
      sha256: receipt.sha256,
      sourceCommit: receipt.sourceCommit,
      buildHash: receipt.buildHash,
      toolchain: receipt.toolchain,
      lockSha256: receipt.lockSha256,
    },
  }
}

/**
 * Source proof for a Kitty derivation's declared source. A file is a source archive and keeps its
 * flat sha256; a directory is an unpacked source tree (nixpkgs kitty) and is proven by the
 * NAR hash of that exact store path. Anything else fails loud, never a guessed digest.
 */
export function kittySourceProof(
  sourcePath: string,
): { kind: "archive"; sha256: string } | { kind: "directory"; narHash: string } {
  let stat
  try {
    stat = statSync(sourcePath)
  } catch {
    throw new Error(`Kitty source path is neither an archive file nor a source directory: ${sourcePath}`)
  }
  if (stat.isFile()) return { kind: "archive", sha256: sha256(readFileSync(sourcePath)) }
  if (stat.isDirectory()) {
    const narHash = execFileSync("nix", ["hash", "path", sourcePath], { encoding: "utf8" }).trim()
    if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(narHash)) {
      throw new Error(`No NAR hash for Kitty source directory ${sourcePath}: ${narHash}`)
    }
    return { kind: "directory", narHash }
  }
  throw new Error(`Kitty source path is neither an archive file nor a source directory: ${sourcePath}`)
}

function kittyIdentity(adapterVersion: string, termlessRevision: string): HeadlessRuntimeIdentity {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Pinned Kitty headless identity is available only on x86_64 Linux")
  }
  const explicit = process.env.KITTY_BINARY
  if (!explicit || !explicit.startsWith("/")) throw new Error("Kitty headless run requires an explicit KITTY_BINARY")
  const path = realpathSync(explicit)
  const storePath = path.match(/^\/nix\/store\/[^/]+/)?.[0]
  if (!storePath) throw new Error(`Kitty binary is not from the declared Nix store: ${path}`)
  const versionOutput = execFileSync(path, ["--version"], { encoding: "utf8" }).trim()
  const version = /^kitty (\d+\.\d+\.\d+)\b/.exec(versionOutput)?.[1]
  if (!version) throw new Error(`Cannot read Kitty engine version from ${versionOutput}`)
  const info: unknown = JSON.parse(
    execFileSync("nix", ["path-info", "--json", "--json-format", "1", storePath], { encoding: "utf8" }),
  )
  const storeInfo = record(info) ? info[storePath] : undefined
  if (
    !record(storeInfo) ||
    typeof storeInfo.narHash !== "string" ||
    !storeInfo.narHash.startsWith("sha256-") ||
    typeof storeInfo.deriver !== "string"
  ) {
    throw new Error(`No Nix closure hash for loaded Kitty ${storePath}`)
  }
  const derivation: unknown = JSON.parse(
    execFileSync("nix", ["derivation", "show", storeInfo.deriver], { encoding: "utf8" }),
  )
  const derivations = record(derivation) && record(derivation.derivations) ? derivation.derivations : undefined
  const drv = derivations?.[storeInfo.deriver] ?? derivations?.[basename(storeInfo.deriver)]
  const legacySource = record(drv) && record(drv.env) ? drv.env.src : undefined
  const structuredSource = record(drv) && record(drv.structuredAttrs) ? drv.structuredAttrs.src : undefined
  if (
    (legacySource !== undefined && typeof legacySource !== "string") ||
    (structuredSource !== undefined && typeof structuredSource !== "string")
  ) {
    throw new Error(`Malformed source declaration in Kitty Nix derivation ${storeInfo.deriver}`)
  }
  if (legacySource !== undefined && structuredSource !== undefined && legacySource !== structuredSource) {
    throw new Error(`Conflicting source declarations in Kitty Nix derivation ${storeInfo.deriver}`)
  }
  const sourcePath = legacySource ?? structuredSource
  if (typeof sourcePath !== "string" || !sourcePath.startsWith("/nix/store/")) {
    throw new Error(`No source archive in Kitty Nix derivation ${storeInfo.deriver}`)
  }
  const sourceProof = kittySourceProof(sourcePath)
  const sourceTag =
    sourceProof.kind === "archive"
      ? `source archive ${sourcePath} sha256 ${sourceProof.sha256}`
      : `source directory ${sourcePath} narHash ${sourceProof.narHash}`
  const binarySha256 = sha256(readFileSync(path))
  const lockSha256 = sha256(readFileSync(join(CODE_ROOT, "flake.lock")))
  const buildHash = sha256(
    JSON.stringify({ storePath, narHash: storeInfo.narHash, sourceProof, binarySha256, lockSha256 }),
  )
  return {
    kind: "native",
    engineVersion: version,
    adapterVersion,
    termlessRevision,
    loadedBinary: { path: recordedPath(path), sha256: binarySha256 },
    provenance: {
      sha256: binarySha256,
      sourceCommit: termlessRevision,
      buildHash,
      toolchain: `Nix ${storePath}; narHash ${storeInfo.narHash}; ${sourceTag}; kitty +runpy`,
      lockSha256,
    },
  }
}

function libvtermVersion(wasmPath: string, wasmSha256: string, adapterDirectory: string, termlessRoot: string): string {
  const receiptPath = `${wasmPath}.receipt.json`
  const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"))
  const jsPath = join(adapterDirectory, "wasm", "libvterm.js")
  if (
    !record(receipt) ||
    receipt.sha256 !== wasmSha256 ||
    receipt.jsSha256 !== sha256(readFileSync(jsPath)) ||
    typeof receipt.engineVersion !== "string" ||
    typeof receipt.sourceCommit !== "string" ||
    typeof receipt.buildHash !== "string" ||
    typeof receipt.wrapperTreeOid !== "string" ||
    receipt.wrapperTreeOid !== git(termlessRoot, "rev-parse", "HEAD:packages/libvterm/build")
  ) {
    throw new Error(`libvterm build receipt is missing or does not match loaded WASM/JS: ${receiptPath}`)
  }
  return receipt.engineVersion
}

export async function headlessRuntimeIdentity(
  name: string,
  adapterSpecifier: string,
  adapterType: string,
): Promise<HeadlessRuntimeIdentity> {
  // Identity measurement needs the owned resources; importing the comparer does not.
  ownedCheckout(VTERM_ROOT, "vterm")
  ownedCheckout(CODE_ROOT, "CODE workspace")
  const adapter = resolvedPackage(adapterSpecifier, MODULE_PATH)
  const termlessRoot = owningCheckout(adapter.path, adapterSpecifier)
  const adapterRelative = relative(termlessRoot, adapter.directory)
  const dirtyAdapter = git(termlessRoot, "status", "--porcelain", "--", adapterRelative)
  if (dirtyAdapter) throw new Error(`${adapterSpecifier} has uncommitted adapter source:\n${dirtyAdapter}`)
  const termlessRevision = git(termlessRoot, "rev-parse", "HEAD")
  if (name === "kitty") return kittyIdentity(adapter.version, termlessRevision)
  if (adapterType === "native") {
    return sidecarIdentity(adapter.directory, adapter.version, termlessRevision, termlessRoot)
  }

  const upstreamSpecifier = name === "libvterm" ? adapterSpecifier : UPSTREAM_PACKAGES[name]
  if (!upstreamSpecifier) throw new Error(`No upstream package identity for ${name}`)
  const upstream = name === "libvterm" ? adapter : resolvedPackage(upstreamSpecifier, adapter.path)
  const integrity = (() => {
    if (inside(upstream.path, termlessRoot) || inside(upstream.path, VTERM_ROOT)) {
      return sourceIntegrity(upstream.path, upstream.directory, termlessRoot)
    }
    const workspace = fileLinkWorkspace(upstreamSpecifier, termlessRoot)
    if (!workspace) return registryIntegrity(upstreamSpecifier, upstream.version)
    return fileLinkIntegrity(upstream, workspace, upstreamSpecifier, termlessRoot)
  })()
  const base = {
    kind: "js" as const,
    adapterVersion: adapter.version,
    termlessRevision,
    resolvedPath: recordedPath(upstream.path),
    integrity,
  }
  if (adapterType === "wasm") {
    const source =
      name === "ghostty"
        ? join(adapter.directory, "src", "backend.ts")
        : join(adapter.directory, "src", "wasm-bindings.ts")
    const getter: unknown = await import(pathToFileURL(source).href)
    const getterName = name === "ghostty" ? "loadedGhosttyWasm" : "loadedLibvtermWasm"
    if (!record(getter) || typeof getter[getterName] !== "function") {
      throw new Error(`${name} loader does not expose ${getterName}()`)
    }
    const loadedWasm = getter[getterName] as () => unknown
    const binary = loadedWasm()
    if (!record(binary) || typeof binary.path !== "string" || typeof binary.sha256 !== "string") {
      throw new Error(`${name} loader did not expose the loaded WASM bytes`)
    }
    const path = realpathSync(binary.path)
    const sha = sha256(readFileSync(path))
    if (binary.sha256 !== sha) throw new Error(`${name} WASM changed after loading: ${basename(path)}`)
    const engineVersion =
      name === "libvterm" ? libvtermVersion(path, sha, adapter.directory, termlessRoot) : upstream.version
    return { ...base, runtimeFormat: "wasm", engineVersion, loadedBinary: { path: recordedPath(path), sha256: sha } }
  }
  return { ...base, runtimeFormat: "js", engineVersion: upstream.version }
}
