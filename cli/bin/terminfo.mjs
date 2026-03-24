#!/usr/bin/env node

// Bootstrap: spawn bun if available, fall back to node with type stripping
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const entry = join(__dirname, "..", "src", "index.ts")

// Try bun first (handles .ts natively)
const bun = spawnSync("bun", [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
})

if (bun.error?.code === "ENOENT") {
  // No bun — try node with experimental flags
  const node = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", entry, ...process.argv.slice(2)],
    { stdio: "inherit", env: process.env },
  )
  process.exit(node.status ?? 1)
} else {
  process.exit(bun.status ?? 1)
}
