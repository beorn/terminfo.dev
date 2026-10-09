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
import type { AppLaunchReceipt, DerivedSourceTreeArtifact } from "@terminfo/probe-defs"

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

/** A digest the apparatus derived from bytes: a sha256 AND carrying real entropy. */
function measuredDigest(value: unknown, path: string, field: string): string {
  const digest = String(value)
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
  const sha256 = asString(value.sha256, path, `${field}.sha256`)
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail(path, `invalid ${field}.sha256`)
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
  let sourceArtifact: AppLaunchReceipt["sourceArtifact"]
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
