/** Identify the engine loaded by a Termless adapter, never its manifest's desired version. */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { HeadlessRuntimeIdentity } from "@terminfo/probe-defs"

const TERMINFO_ROOT = realpathSync(resolve(import.meta.dir, "../.."))
const CODE_ROOT = realpathSync(resolve(TERMINFO_ROOT, "../.."))
const TERMLESS_ROOT = realpathSync(join(CODE_ROOT, "vendor", "termless"))
const VTERM_ROOT = realpathSync(join(CODE_ROOT, "vendor", "vterm"))

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
  const cache = createRequire(import.meta.url).cache
  const paths = Object.keys(cache).filter((path) => path.endsWith(".node") && inside(path, adapterDirectory))
  if (paths.length !== 1) {
    throw new Error(
      `Expected one loaded native addon in ${adapterDirectory}; found ${paths.length}: ${paths.join(", ")}`,
    )
  }
  const path = realpathSync(paths[0]!)
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
    typeof receipt.lockSha256 !== "string"
  ) {
    throw new Error(`Native addon receipt missing or does not match loaded binary: ${receiptPath}`)
  }
  if (typeof receipt.nativeTreeOid === "string") {
    const packagePath = relative(TERMLESS_ROOT, adapterDirectory)
    const currentTreeOid = git(TERMLESS_ROOT, "rev-parse", `HEAD:${packagePath}/native`)
    if (receipt.nativeTreeOid !== currentTreeOid) {
      throw new Error(`Native addon receipt source tree differs from current adapter: ${receiptPath}`)
    }
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
  if (!record(storeInfo) || typeof storeInfo.narHash !== "string" || !storeInfo.narHash.startsWith("sha256-")) {
    throw new Error(`No Nix closure hash for loaded Kitty ${storePath}`)
  }
  const binarySha256 = sha256(readFileSync(path))
  const lockSha256 = sha256(readFileSync(join(CODE_ROOT, "flake.lock")))
  const buildHash = sha256(JSON.stringify({ storePath, narHash: storeInfo.narHash, binarySha256, lockSha256 }))
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
      toolchain: `Nix ${storePath}; narHash ${storeInfo.narHash}; kitty +runpy`,
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
  const termlessRevision = git(TERMLESS_ROOT, "rev-parse", "HEAD")
  if (name === "kitty") return kittyIdentity(adapter.version, termlessRevision)
  if (adapterType === "native") return sidecarIdentity(adapter.directory, adapter.version, termlessRevision)

  const upstream =
    name === "libvterm"
      ? adapter
      : resolvedPackage(
          (
            {
              xtermjs: "@xterm/headless",
              ghostty: "ghostty-web",
              vt100: "vt100.js",
              vt220: "vt220.js",
              vterm: "vterm.js",
            } as Record<string, string>
          )[name] ??
            (() => {
              throw new Error(`No upstream package identity for ${name}`)
            })(),
          adapter.path,
        )
  const integrity =
    inside(upstream.path, TERMLESS_ROOT) || inside(upstream.path, VTERM_ROOT)
      ? sourceIntegrity(upstream.path, upstream.directory)
      : registryIntegrity(
          name === "libvterm"
            ? adapterSpecifier
            : ({ xtermjs: "@xterm/headless", ghostty: "ghostty-web" } as Record<string, string>)[name]!,
          upstream.version,
        )
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
    const getter = await import(pathToFileURL(source).href)
    const binary = name === "ghostty" ? getter.loadedGhosttyWasm() : getter.loadedLibvtermWasm()
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
