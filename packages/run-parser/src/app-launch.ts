/**
 * The ONE parser for an app-launch receipt, and for the derived-source-tree artifact inside it.
 *
 * It is a separate module because TWO callers must share exactly this shape: `run-parser`, which
 * validates a run document before any evidence is selected, and the hosted apparatus producer
 * (`scripts/hosted-runner-receipt.ts`), which is fetched into an empty directory and run under Node's
 * type stripping before any checkout exists (@cto 2026-10-08, 28216). The two-file bootstrap cannot
 * resolve a workspace package, and a second copy of this parser is exactly the drift this extraction
 * exists to prevent - so this module imports ONLY node built-ins and type-only names.
 *
 * It also owns the ONE placeholder predicate (`PLACEHOLDER`), because both callers must refuse a
 * digest nothing measured with the same rule (27874), and a second copy of that rule is the same
 * drift this module exists to prevent.
 */
import { win32 } from "node:path"
import type {
  AppLaunchReceipt,
  AppSourceArtifact,
  DerivedSourceTreeArtifact,
  ProbeTarget,
  RunOrigin,
} from "@terminfo/probe-defs"

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0
function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`)
}
const asString = (value: unknown, path: string, name: string): string =>
  nonempty(value) ? value : fail(path, `missing ${name}`)

/** One repeated character at any length - what a hand writes when nothing was measured. The apparatus
 * derives a digest from real bytes, so a placeholder is refused BY NAME: admitting one is admitting a
 * receipt nothing derived (27874). */
export const PLACEHOLDER = /^(.)\1*$/

/** A digest the apparatus derived from bytes: present, a sha256, and carrying real entropy. */
function measuredDigest(value: unknown, path: string, field: string): string {
  const digest = asString(value, path, field)
  if (!/^[a-f0-9]{64}$/.test(digest)) fail(path, `invalid ${field}`)
  if (PLACEHOLDER.test(digest)) {
    fail(path, `${field} is a placeholder: one repeated character, so no bytes were measured`)
  }
  return digest
}

/**
 * A DERIVED source artifact is honest only when the receipt names the proof: the upstream source at
 * `url`@`revision`, the tree hash nixpkgs pins for it (`narSri`, the trust root tying the tar to
 * upstream) and the derived tar's flat `sha256`, the one re-measured in the image (@cto 2026-10-06,
 * 27892). The key set is EXACT, so a missing revision and an unknown kind are both refused by name.
 */
export function parseDerivedSourceTree(
  value: Record<string, unknown>,
  path: string,
  field: string,
): DerivedSourceTreeArtifact {
  if (Object.keys(value).sort().join(",") !== "kind,narSri,revision,sha256,url") {
    fail(path, `invalid ${field} fields`)
  }
  const url = asString(value.url, path, `${field}.url`)
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    fail(path, `invalid ${field}.url`)
  }
  if (parsedUrl.protocol !== "https:") fail(path, `${field}.url must use HTTPS`)
  const revision = asString(value.revision, path, `${field}.revision`)
  const narSri = asString(value.narSri, path, `${field}.narSri`)
  if (!narSri.startsWith("sha256-")) fail(path, `invalid ${field}.narSri`)
  const sha256 = measuredDigest(value.sha256, path, `${field}.sha256`)
  return { kind: "derived-source-tree", url, revision, narSri, sha256 }
}

export function parseAppLaunchReceipt(
  value: unknown,
  originKind: RunOrigin["kind"],
  targetKind: ProbeTarget["kind"],
  path: string,
): AppLaunchReceipt | undefined {
  if (value === undefined) return undefined
  if (originKind !== "collector" || targetKind !== "app" || !object(value)) {
    fail(path, "appLaunch requires an app collector run")
  }
  if (Object.hasOwn(value, "platform") && value.platform !== "win32") {
    fail(path, "unknown appLaunch.platform")
  }
  if (value.platform === "win32") {
    const keys = Object.keys(value).sort().join(",")
    if (
      keys !== "executablePath,executableSha256,platform,productVersion,sourceArtifact" &&
      keys !== "executablePath,executableSha256,mesaRenderer,platform,productVersion,sourceArtifact"
    ) {
      fail(path, "invalid win32 appLaunch fields; Windows and bundle fields cannot be mixed")
    }
    const executablePath = asString(value.executablePath, path, "appLaunch.executablePath")
    if (!win32.isAbsolute(executablePath) || win32.parse(executablePath).root.length <= 1) {
      fail(path, "win32 appLaunch.executablePath must be absolute")
    }
    const productVersion = asString(value.productVersion, path, "appLaunch.productVersion")
    if (productVersion.trim().length === 0) fail(path, "missing appLaunch.productVersion")
    if (productVersion !== productVersion.trim() || /[\r\n]/.test(productVersion)) {
      fail(path, "appLaunch.productVersion has surrounding whitespace or a newline")
    }
    const executableSha256 = measuredDigest(value.executableSha256, path, "appLaunch.executableSha256")
    if (!object(value.sourceArtifact)) fail(path, "missing appLaunch.sourceArtifact")
    const sourceKind = value.sourceArtifact.kind
    if (sourceKind !== "portable-zip" && sourceKind !== "portable-exe") {
      fail(path, "win32 appLaunch.sourceArtifact must be portable-zip or portable-exe")
    }
    if (Object.keys(value.sourceArtifact).sort().join(",") !== "kind,path,sha256") {
      fail(path, "invalid win32 appLaunch.sourceArtifact fields")
    }
    const sourcePath = asString(value.sourceArtifact.path, path, "appLaunch.sourceArtifact.path")
    if (!win32.isAbsolute(sourcePath) || win32.parse(sourcePath).root.length <= 1) {
      fail(path, "win32 appLaunch.sourceArtifact.path must be absolute")
    }
    const sha256 = measuredDigest(value.sourceArtifact.sha256, path, "appLaunch.sourceArtifact.sha256")
    if (sourceKind === "portable-exe" && executableSha256 !== sha256) {
      fail(path, "win32 portable-exe appLaunch.executableSha256 must match sourceArtifact.sha256")
    }
    if (sourceKind === "portable-zip" && value.mesaRenderer !== undefined) {
      fail(path, "win32 portable-zip appLaunch cannot carry mesaRenderer")
    }
    let mesaRenderer:
      | {
          upstream: string
          version: string
          archivePath: string
          archiveSha256: string
          dlls: Array<{ name: string; path: string; sha256: string }>
        }
      | undefined
    if (value.mesaRenderer !== undefined) {
      if (!object(value.mesaRenderer)) fail(path, "invalid win32 appLaunch.mesaRenderer")
      if (Object.keys(value.mesaRenderer).sort().join(",") !== "archivePath,archiveSha256,dlls,upstream,version") {
        fail(path, "invalid win32 appLaunch.mesaRenderer fields")
      }
      const upstream = asString(value.mesaRenderer.upstream, path, "appLaunch.mesaRenderer.upstream")
      if (upstream !== upstream.trim() || /[\r\n]/.test(upstream)) {
        fail(path, "appLaunch.mesaRenderer.upstream has surrounding whitespace or a newline")
      }
      const version = asString(value.mesaRenderer.version, path, "appLaunch.mesaRenderer.version")
      if (version !== version.trim() || /[\r\n]/.test(version)) {
        fail(path, "appLaunch.mesaRenderer.version has surrounding whitespace or a newline")
      }
      const archivePath = asString(value.mesaRenderer.archivePath, path, "appLaunch.mesaRenderer.archivePath")
      if (!win32.isAbsolute(archivePath) || win32.parse(archivePath).root.length <= 1) {
        fail(path, "win32 appLaunch.mesaRenderer.archivePath must be absolute")
      }
      const archiveSha256 = measuredDigest(
        value.mesaRenderer.archiveSha256,
        path,
        "appLaunch.mesaRenderer.archiveSha256",
      )
      if (!Array.isArray(value.mesaRenderer.dlls) || value.mesaRenderer.dlls.length === 0) {
        fail(path, "win32 appLaunch.mesaRenderer.dlls must be a non-empty array")
      }
      const dlls = value.mesaRenderer.dlls.map((entry, index) => {
        const field = `appLaunch.mesaRenderer.dlls[${String(index)}]`
        if (!object(entry) || Object.keys(entry).sort().join(",") !== "name,path,sha256") {
          fail(path, `invalid win32 ${field} fields`)
        }
        const name = asString(entry.name, path, `${field}.name`)
        if (name !== name.trim() || /[\r\n/\\]/.test(name)) {
          fail(path, `invalid win32 ${field}.name`)
        }
        const dllPath = asString(entry.path, path, `${field}.path`)
        if (!win32.isAbsolute(dllPath) || win32.parse(dllPath).root.length <= 1) {
          fail(path, `win32 ${field}.path must be absolute`)
        }
        const dllSha256 = measuredDigest(entry.sha256, path, `${field}.sha256`)
        return { name, path: dllPath, sha256: dllSha256 }
      })
      if (!dlls.some((dll) => dll.name.toLowerCase() === "opengl32.dll")) {
        fail(path, "win32 appLaunch.mesaRenderer.dlls must include opengl32.dll")
      }
      mesaRenderer = { upstream, version, archivePath, archiveSha256, dlls }
    }
    return {
      platform: "win32",
      executablePath,
      productVersion,
      executableSha256,
      sourceArtifact: { kind: sourceKind, path: sourcePath, sha256 },
      ...(mesaRenderer && { mesaRenderer }),
    }
  }
  if (Object.hasOwn(value, "productVersion")) fail(path, "mixed Windows and bundle appLaunch fields")
  const bundlePath = asString(value.bundlePath, path, "appLaunch.bundlePath")
  const cfBundleShortVersionString = asString(
    value.cfBundleShortVersionString,
    path,
    "appLaunch.cfBundleShortVersionString",
  )
  const cfBundleVersion = asString(value.cfBundleVersion, path, "appLaunch.cfBundleVersion")
  const executablePath = asString(value.executablePath, path, "appLaunch.executablePath")
  if (!bundlePath.startsWith("/") || !executablePath.startsWith("/")) {
    fail(path, "appLaunch bundle and executable paths must be absolute")
  }
  const executableSha256 = measuredDigest(value.executableSha256, path, "appLaunch.executableSha256")
  if (!object(value.sourceArtifact)) fail(path, "missing appLaunch.sourceArtifact")
  let sourceArtifact: AppSourceArtifact
  if (value.sourceArtifact.kind === "sealed-macos-system-volume") {
    if (
      Object.keys(value.sourceArtifact).sort().join(",") !==
      "codeSignature,kind,macOSBuild,sealed,snapshotName,snapshotUUID"
    ) {
      fail(path, "invalid sealed appLaunch.sourceArtifact fields")
    }
    const macOSBuild = asString(value.sourceArtifact.macOSBuild, path, "appLaunch.sourceArtifact.macOSBuild")
    const snapshotUUID = asString(value.sourceArtifact.snapshotUUID, path, "appLaunch.sourceArtifact.snapshotUUID")
    const snapshotName = asString(value.sourceArtifact.snapshotName, path, "appLaunch.sourceArtifact.snapshotName")
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(snapshotUUID)) {
      fail(path, "invalid appLaunch.sourceArtifact.snapshotUUID")
    }
    if (value.sourceArtifact.sealed !== true) fail(path, "appLaunch.sourceArtifact.sealed must be true")
    if (!object(value.sourceArtifact.codeSignature)) fail(path, "missing appLaunch.sourceArtifact.codeSignature")
    const identifier = asString(
      value.sourceArtifact.codeSignature.identifier,
      path,
      "appLaunch.codeSignature.identifier",
    )
    const cdHash = asString(value.sourceArtifact.codeSignature.cdHash, path, "appLaunch.codeSignature.cdHash")
    if (!/^[a-f0-9]{40}$/.test(cdHash)) fail(path, "invalid appLaunch.sourceArtifact.codeSignature.cdHash")
    if (value.sourceArtifact.codeSignature.strictVerified !== true) {
      fail(path, "appLaunch.sourceArtifact.codeSignature.strictVerified must be true")
    }
    sourceArtifact = {
      kind: "sealed-macos-system-volume",
      macOSBuild,
      snapshotUUID,
      snapshotName,
      sealed: true,
      codeSignature: { identifier, cdHash, strictVerified: true },
    }
  } else if (value.sourceArtifact.kind === "derived-source-tree") {
    sourceArtifact = parseDerivedSourceTree(value.sourceArtifact, path, "appLaunch.sourceArtifact")
  } else if (value.sourceArtifact.kind === undefined) {
    const sourcePath = asString(value.sourceArtifact.path, path, "appLaunch.sourceArtifact.path")
    if (!sourcePath.startsWith("/")) fail(path, "invalid appLaunch.sourceArtifact")
    const sha256 = measuredDigest(value.sourceArtifact.sha256, path, "appLaunch.sourceArtifact.sha256")
    sourceArtifact = { path: sourcePath, sha256 }
  } else {
    fail(path, "unknown appLaunch.sourceArtifact kind")
  }
  return {
    bundlePath,
    cfBundleShortVersionString,
    cfBundleVersion,
    executablePath,
    executableSha256,
    sourceArtifact,
  }
}
