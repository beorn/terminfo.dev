#!/usr/bin/env bun
/** Bundle the publishable CLI with the one trusted suite declaration. */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { derivedSuiteManifest, probeSuiteSnapshot, uncommittedCollectorDirt } from "../packages/admin/versions.ts"
import { verifySuiteManifest } from "./suite-manifest.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

async function main(): Promise<void> {
  const snapshot = probeSuiteSnapshot(ROOT)
  const dirty = uncommittedCollectorDirt(ROOT, snapshot)
  if (dirty) throw new Error(`Cannot bundle an uncommitted CLI collector:\n${dirty}`)
  const manifestPath = join(ROOT, "content", "suites", `${snapshot.probeHash}.json`)
  const manifest = existsSync(manifestPath)
    ? verifySuiteManifest(manifestPath, snapshot)
    : derivedSuiteManifest(snapshot)
  const collectorRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
  const result = await Bun.build({
    entrypoints: [join(ROOT, "packages", "terminfo.dev", "src", "index.tsx")],
    target: "bun",
    format: "esm",
    external: ["@silvery/ansi", "@silvery/commander", "silvery", "react"],
    // The published bundle is a production artifact: it must emit `react/jsx-runtime`, never
    // `jsxDEV` from `react/jsx-dev-runtime`. terminfo.dev carries no tsconfig, so
    // Bun.build falls back to its development JSX transform unless the runtime is named here — the
    // estate-wide `jsx: "react-jsx"` pin lives in the root tsconfig, which this build never reads.
    jsx: { runtime: "automatic", development: false },
    define: { __TERMINFO_BUNDLED_SUITE__: JSON.stringify({ manifest, collectorRevision }) },
  })
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(
      `CLI bundle failed: ${result.logs.map((entry) => entry.message).join("; ") || `${result.outputs.length} outputs`}`,
    )
  }
  const dist = join(ROOT, "packages", "terminfo.dev", "dist")
  mkdirSync(dist, { recursive: true })
  const destination = join(dist, "terminfo.bundle.mjs")
  const temporary = `${destination}.tmp-${process.pid}`
  const [output] = result.outputs
  if (!output) throw new Error("CLI bundle succeeded without an output")
  const bundle = Buffer.from(await output.arrayBuffer())
  writeFileSync(temporary, bundle)
  renameSync(temporary, destination)
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
  const receipt = {
    schemaVersion: 1,
    probeHash: manifest.probeHash,
    collectorRevision,
    bundleSha256: sha256(bundle),
  }
  const receiptPath = join(dist, "terminfo.bundle.receipt.json")
  const receiptTemporary = `${receiptPath}.tmp-${process.pid}`
  writeFileSync(receiptTemporary, `${JSON.stringify(receipt, null, 2)}\n`)
  renameSync(receiptTemporary, receiptPath)
  console.log(`CLI bundle ready: ${destination} (${manifest.probeHash}, ${collectorRevision})`)
}

if (import.meta.main) await main()
