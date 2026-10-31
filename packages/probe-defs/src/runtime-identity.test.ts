/**
 * @failure Runtime projection silently adds provenance fields or omits reviewed identity fields.
 * @level l0
 * @consumer Capture evidence keys and source-negative probe qualifiers.
 * @testonly none
 */
import { expect, test } from "vitest"
import type { HeadlessRuntimeIdentity } from "./types.ts"
import { evidenceRuntimeIdentity } from "./runtime-identity.ts"

test("WASM keys bind loaded bytes, not wrapper provenance or unreviewed fields", () => {
  const identity: HeadlessRuntimeIdentity = {
    kind: "js",
    runtimeFormat: "wasm",
    engineVersion: "0.3.3",
    adapterVersion: "0.10.2",
    termlessRevision: "a".repeat(40),
    resolvedPath: "/original/index.ts",
    integrity: {
      kind: "source",
      repository: "wrapper",
      revision: "b".repeat(40),
      treeOid: "c".repeat(40),
      cleanTree: true,
    },
    loadedBinary: { path: "/original/engine.wasm", sha256: "d".repeat(64) },
    adapterSources: [{ path: "src/backend.ts", blobOid: "e".repeat(40) }],
  }
  const expected = evidenceRuntimeIdentity(identity)
  const relocated = structuredClone(identity)
  relocated.termlessRevision = "f".repeat(40)
  relocated.resolvedPath = "/another/index.ts"
  relocated.loadedBinary.path = "/another/engine.wasm"
  relocated.integrity = {
    kind: "source",
    repository: "different-wrapper",
    revision: "1".repeat(40),
    treeOid: "2".repeat(40),
    cleanTree: false,
  }
  expect(evidenceRuntimeIdentity(relocated)).toEqual(expected)
  relocated.loadedBinary.sha256 = "3".repeat(64)
  expect(evidenceRuntimeIdentity(relocated)).not.toEqual(expected)
  expect(expected).not.toHaveProperty("integrity")
})

test("accounts explicitly for every runtime identity and native provenance field", () => {
  type JS = Extract<HeadlessRuntimeIdentity, { kind: "js"; runtimeFormat: "js" }>
  type WASM = Extract<HeadlessRuntimeIdentity, { runtimeFormat: "wasm" }>
  type Native = Extract<HeadlessRuntimeIdentity, { kind: "native" }>
  const js = {
    kind: true,
    engineVersion: true,
    adapterVersion: true,
    termlessRevision: false,
    adapterSources: true,
    resolvedPath: false,
    runtimeFormat: true,
    integrity: true,
  } satisfies Record<keyof JS, boolean>
  const wasm = { ...js, integrity: false, loadedBinary: true } satisfies Record<keyof WASM, boolean>
  const native = {
    kind: true,
    engineVersion: true,
    adapterVersion: true,
    termlessRevision: false,
    adapterSources: true,
    loadedBinary: true,
    provenance: true,
  } satisfies Record<keyof Native, boolean>
  const source = { kind: true, repository: true, revision: false, treeOid: true, cleanTree: true } satisfies Record<
    keyof Extract<JS["integrity"], { kind: "source" }>,
    boolean
  >
  const binary = { path: false, sha256: true } satisfies Record<keyof Native["loadedBinary"], boolean>
  const registry = { kind: true, lockIntegrity: true } satisfies Record<
    keyof Extract<JS["integrity"], { kind: "registry" }>,
    boolean
  >
  const provenance = {
    sha256: true,
    sourceCommit: true,
    buildHash: true,
    toolchain: true,
    lockSha256: true,
  } satisfies Record<keyof Native["provenance"], boolean>
  const common = { engineVersion: "1", adapterVersion: "2", termlessRevision: "3".repeat(40) }
  const identities: HeadlessRuntimeIdentity[] = [
    {
      ...common,
      kind: "js",
      runtimeFormat: "js",
      resolvedPath: "/fixture.ts",
      integrity: {
        kind: "source",
        repository: "fixture",
        revision: "e".repeat(40),
        treeOid: "f".repeat(40),
        cleanTree: true,
      },
    },
    {
      ...common,
      kind: "js",
      runtimeFormat: "wasm",
      resolvedPath: "/fixture.wasm",
      integrity: { kind: "registry", lockIntegrity: "sha512-fixture" },
      loadedBinary: { path: "/fixture.wasm", sha256: "a".repeat(64) },
    },
    {
      ...common,
      kind: "native",
      loadedBinary: { path: "/fixture.node", sha256: "a".repeat(64) },
      provenance: {
        sha256: "a".repeat(64),
        sourceCommit: "b".repeat(40),
        buildHash: "c".repeat(64),
        toolchain: "clang-20",
        lockSha256: "d".repeat(64),
      },
    },
  ]
  for (const identity of identities) {
    const projection: Record<string, unknown> = evidenceRuntimeIdentity(identity)!
    const policy = identity.kind === "native" ? native : identity.runtimeFormat === "wasm" ? wasm : js
    expect(Object.keys(projection).sort()).toEqual(
      Object.entries(policy)
        .filter(([, keep]) => keep)
        .map(([key]) => key)
        .sort(),
    )
    if (identity.kind === "js" && identity.runtimeFormat === "js" && identity.integrity.kind === "source") {
      expect(Object.keys(projection.integrity as object).sort()).toEqual(
        Object.entries(source)
          .filter(([, keep]) => keep)
          .map(([key]) => key)
          .sort(),
      )
    }
    if (identity.kind === "native") {
      expect(Object.keys(projection.provenance as object).sort()).toEqual(Object.keys(provenance).sort())
    }
    if (identity.kind === "js" && identity.runtimeFormat === "js" && identity.integrity.kind === "registry") {
      expect(Object.keys(projection.integrity as object).sort()).toEqual(Object.keys(registry).sort())
    }
    if ("loadedBinary" in identity) {
      expect(Object.keys(projection.loadedBinary as object)).toEqual(
        Object.entries(binary)
          .filter(([, keep]) => keep)
          .map(([key]) => key),
      )
    }
  }
})
