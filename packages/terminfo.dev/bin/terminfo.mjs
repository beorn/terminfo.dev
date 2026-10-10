#!/usr/bin/env node

// Run the compiled CLI that carries its validated suite receipt.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const entry = join(__dirname, "..", "dist", "terminfo.bundle.mjs")
if (!existsSync(entry)) {
  console.error(`CLI bundle missing: ${entry}; build the package before running it`)
  process.exit(1)
}

const receiptPath = join(__dirname, "..", "dist", "terminfo.bundle.receipt.json")
if (!existsSync(receiptPath)) {
  console.error(`CLI bundle receipt missing: ${receiptPath}`)
  process.exit(1)
}
let receipt
try {
  receipt = JSON.parse(readFileSync(receiptPath, "utf8"))
} catch (error) {
  console.error(`CLI bundle receipt invalid: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
const hex = (value, length) => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
const declared =
  receipt?.schemaVersion === 1 &&
  hex(receipt.probeHash, 12) &&
  hex(receipt.collectorRevision, 40) &&
  hex(receipt.manifestSha256, 64) &&
  hex(receipt.bundleSha256, 64)
const undeclared =
  receipt?.schemaVersion === 1 &&
  receipt.suiteState === "undeclared" &&
  receipt.manifestSha256 === null &&
  hex(receipt.probeHash, 12) &&
  hex(receipt.collectorRevision, 40) &&
  hex(receipt.bundleSha256, 64)
if (!declared && !undeclared) {
  console.error(`CLI bundle receipt has invalid fields: ${receiptPath}`)
  process.exit(1)
}
// This checks packed artifact consistency; it is not a signature or a trust root.
const actualBundleSha256 = createHash("sha256").update(readFileSync(entry)).digest("hex")
if (actualBundleSha256 !== receipt.bundleSha256) {
  console.error(`CLI bundle SHA256 digest mismatch: ${entry}`)
  process.exit(1)
}
if (undeclared) {
  console.error(`Suite ${receipt.probeHash} is undeclared on this checkout`)
  process.exit(1)
}

// Bun is preferred; Node can run the JavaScript bundle when Bun is absent.
const bun = spawnSync("bun", [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
})

if (bun.error?.code === "ENOENT") {
  const node = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit", env: process.env })
  process.exit(node.status ?? 1)
} else {
  if (bun.error) throw bun.error
  process.exit(bun.status ?? 1)
}
