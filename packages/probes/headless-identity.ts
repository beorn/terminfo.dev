/** Identify the engine loaded by a Termless adapter, never its manifest's desired version. */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { HeadlessRuntimeIdentity } from "@terminfo/probe-defs"

const TERMINFO_ROOT = realpathSync(resolve(import.meta.dir, "../.."))
const VENDOR_ROOT = resolve(TERMINFO_ROOT, "..")

function ownedCheckout(path: string, name: string): string {
  try {
    return realpathSync(path)
  } catch (cause) {
    throw new Error(`Local headless v2 collection requires the owned ${name} checkout at ${path}`, { cause })
  }
}

const TERMLESS_ROOT = ownedCheckout(join(VENDOR_ROOT, "termless"), "Termless")
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

function registryIntegrity(name: string, version: string): { kind: "registry"; lockIntegrity: string } {
  const lock: unknown = Bun.JSONC.parse(readFileSync(join(CODE_ROOT, "bun.lock"), "utf8"))
  if (!record(lock) || !record(lock.packages)) throw new Error("Root bun.lock has no packages map")
  const entry = lock.packages[name]
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

function sourceIntegrity(
  path: string,
  directory: string,
): {
  kind: "source"
  repository: string
  revision: string
  treeOid: string
  cleanTree: boolean
} {
  const repo = inside(path, VTERM_ROOT) ? VTERM_ROOT : TERMLESS_ROOT
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
  const packagePath = relative(TERMLESS_ROOT, adapterDirectory)
  const currentTreeOid = git(TERMLESS_ROOT, "rev-parse", `HEAD:${packagePath}/native`)
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
  const sourceArchiveSha256 = sha256(readFileSync(sourcePath))
  const binarySha256 = sha256(readFileSync(path))
  const lockSha256 = sha256(readFileSync(join(CODE_ROOT, "flake.lock")))
  const buildHash = sha256(
    JSON.stringify({ storePath, narHash: storeInfo.narHash, sourceArchiveSha256, binarySha256, lockSha256 }),
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
      toolchain: `Nix ${storePath}; narHash ${storeInfo.narHash}; source ${sourcePath} sha256 ${sourceArchiveSha256}; kitty +runpy`,
      lockSha256,
    },
  }
}

function libvtermVersion(wasmPath: string, wasmSha256: string, adapterDirectory: string): string {
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
    receipt.wrapperTreeOid !== git(TERMLESS_ROOT, "rev-parse", "HEAD:packages/libvterm/build")
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
  if (!inside(adapter.path, TERMLESS_ROOT)) {
    throw new Error(`${adapterSpecifier} resolved outside owned Termless: ${adapter.path}`)
  }
  const adapterRelative = relative(TERMLESS_ROOT, adapter.directory)
  const dirtyAdapter = git(TERMLESS_ROOT, "status", "--porcelain", "--", adapterRelative)
  if (dirtyAdapter) throw new Error(`${adapterSpecifier} has uncommitted adapter source:\n${dirtyAdapter}`)
  const termlessRevision = git(TERMLESS_ROOT, "rev-parse", "HEAD")
  if (name === "kitty") return kittyIdentity(adapter.version, termlessRevision)
  if (adapterType === "native") return sidecarIdentity(adapter.directory, adapter.version, termlessRevision)

  const upstreamSpecifier = name === "libvterm" ? adapterSpecifier : UPSTREAM_PACKAGES[name]
  if (!upstreamSpecifier) throw new Error(`No upstream package identity for ${name}`)
  const upstream = name === "libvterm" ? adapter : resolvedPackage(upstreamSpecifier, adapter.path)
  const integrity =
    inside(upstream.path, TERMLESS_ROOT) || inside(upstream.path, VTERM_ROOT)
      ? sourceIntegrity(upstream.path, upstream.directory)
      : registryIntegrity(upstreamSpecifier, upstream.version)
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
    const engineVersion = name === "libvterm" ? libvtermVersion(path, sha, adapter.directory) : upstream.version
    return { ...base, runtimeFormat: "wasm", engineVersion, loadedBinary: { path, sha256: sha } }
  }
  return { ...base, runtimeFormat: "js", engineVersion: upstream.version }
}
