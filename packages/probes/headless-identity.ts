/** Identify the engine loaded by a Termless adapter, never its manifest's desired version. */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { HeadlessRuntimeIdentity } from "@terminfo/probe-defs"
import { owningCheckout } from "./termless-root.ts"

const TERMINFO_ROOT = realpathSync(resolve(import.meta.dir, "../.."))
const VENDOR_ROOT = resolve(TERMINFO_ROOT, "..")

function ownedCheckout(path: string, name: string): string {
  try {
    return realpathSync(path)
  } catch (cause) {
    throw new Error(`Local headless v2 collection requires the owned ${name} checkout at ${path}`, { cause })
  }
}

const VTERM_ROOT = ownedCheckout(join(VENDOR_ROOT, "vterm"), "vterm")
const CODE_ROOT = ownedCheckout(resolve(VENDOR_ROOT, ".."), "CODE workspace")
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

/** bun's file: install materializes the package under node_modules/.bun; map that back via overrides. */
function fileLinkWorkspace(name: string, termlessRoot: string): string | undefined {
  const override = readLock().overrides
  const entry = record(override) ? override[name] : undefined
  if (typeof entry !== "string" || !entry.startsWith("file:")) return undefined
  const workspace = realpathSync(resolve(CODE_ROOT, entry.slice("file:".length)))
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
    loadedBinary,
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
 * Source proof for a Kitty derivation's env.src. A file is a source archive and keeps its
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
  const drv = derivations ? Object.values(derivations)[0] : undefined
  const sourcePath = record(drv) && record(drv.env) ? drv.env.src : undefined
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
    loadedBinary: { path, sha256: binarySha256 },
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
  const adapter = resolvedPackage(adapterSpecifier, import.meta.path)
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
    resolvedPath: upstream.path,
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
    if (binary.sha256 !== sha) throw new Error(`${name} WASM changed after loading: ${path}`)
    const engineVersion =
      name === "libvterm" ? libvtermVersion(path, sha, adapter.directory, termlessRoot) : upstream.version
    return { ...base, runtimeFormat: "wasm", engineVersion, loadedBinary: { path, sha256: sha } }
  }
  return { ...base, runtimeFormat: "js", engineVersion: upstream.version }
}
