#!/usr/bin/env bun
/** Bundle the publishable CLI with the one trusted suite declaration. */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { probeSuiteSnapshot } from "../packages/admin/versions.ts"
import { derivedSuiteManifest, suiteDeclarationState } from "./suite-manifest.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

async function main(): Promise<void> {
  const snapshot = probeSuiteSnapshot()
  const sourcePaths = [
    ...snapshot.sourcePaths,
    "packages/terminfo.dev/src",
    "packages/terminfo.dev/bin/terminfo.mjs",
    "packages/admin/versions.ts",
    "packages/run-parser/src",
    "packages/run-parser/package.json",
    "scripts/build-cli.ts",
    "scripts/suite-manifest.ts",
    "bun.lock",
    `content/suites/${snapshot.probeHash}.json`,
  ]
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...sourcePaths], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim()
  if (dirty) throw new Error(`Cannot bundle an uncommitted CLI collector:\n${dirty}`)
  // A build is a first use of the suite, but on a checkout whose HEAD is on origin/main it can only
  // verify what a commit already carries. A non-fast-forward compose that lands a suite nobody
  // declared is therefore a STATE, not a throw: the bundle is produced and the receipt names it,
  // and the launcher refuses that receipt by name before any container starts (27864 A/B/C).
  const declaration = suiteDeclarationState()
  const manifest = declaration.kind === "declared" ? declaration.manifest : derivedSuiteManifest(snapshot)
  const collectorRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
  const result = await Bun.build({
    entrypoints: [join(ROOT, "packages", "terminfo.dev", "src", "index.tsx")],
    target: "bun",
    format: "esm",
    external: ["@silvery/ansi", "@silvery/commander", "silvery", "react"],
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
  const receipt =
    declaration.kind === "declared"
      ? {
          schemaVersion: 1,
          probeHash: manifest.probeHash,
          collectorRevision,
          manifestSha256: sha256(readFileSync(join(ROOT, "content", "suites", `${manifest.probeHash}.json`))),
          bundleSha256: sha256(bundle),
        }
      : {
          schemaVersion: 1,
          probeHash: declaration.probeHash,
          collectorRevision,
          manifestSha256: null,
          suiteState: "undeclared",
          bundleSha256: sha256(bundle),
        }
  const receiptPath = join(dist, "terminfo.bundle.receipt.json")
  const receiptTemporary = `${receiptPath}.tmp-${process.pid}`
  writeFileSync(receiptTemporary, `${JSON.stringify(receipt, null, 2)}\n`)
  renameSync(receiptTemporary, receiptPath)
  console.log(
    `CLI bundle ready: ${destination} (${manifest.probeHash}, ${collectorRevision})` +
      (declaration.kind === "undeclared" ? " — suite undeclared on this checkout" : ""),
  )
}

if (import.meta.main) await main()
