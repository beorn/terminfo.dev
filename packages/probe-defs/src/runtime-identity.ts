import type { HeadlessRuntimeIdentity } from "./types.ts"

export function evidenceRuntimeIdentity(identity: HeadlessRuntimeIdentity | undefined) {
  if (identity === undefined) return null
  const common = {
    engineVersion: identity.engineVersion,
    adapterVersion: identity.adapterVersion,
    adapterSources: identity.adapterSources?.length ? identity.adapterSources : null,
  }
  if (identity.kind === "native") {
    return {
      ...common,
      kind: "native" as const,
      loadedBinary: { sha256: identity.loadedBinary.sha256 },
      provenance: {
        sha256: identity.provenance.sha256,
        sourceCommit: identity.provenance.sourceCommit,
        buildHash: identity.provenance.buildHash,
        toolchain: identity.provenance.toolchain,
        lockSha256: identity.provenance.lockSha256,
      },
    }
  }
  if (identity.runtimeFormat === "wasm") {
    return {
      ...common,
      kind: "js" as const,
      runtimeFormat: "wasm" as const,
      loadedBinary: { sha256: identity.loadedBinary.sha256 },
    }
  }
  return {
    ...common,
    kind: "js" as const,
    runtimeFormat: "js" as const,
    integrity:
      identity.integrity.kind === "source"
        ? {
            kind: "source" as const,
            repository: identity.integrity.repository,
            treeOid: identity.integrity.treeOid,
            cleanTree: identity.integrity.cleanTree,
          }
        : { kind: "registry" as const, lockIntegrity: identity.integrity.lockIntegrity },
  }
}
