#!/usr/bin/env node

// Run the compiled CLI that carries its validated suite receipt.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const entry = join(__dirname, "..", "dist", "terminfo.bundle.mjs")
if (!existsSync(entry)) {
  console.error(`CLI bundle missing: ${entry}; build the package before running it`)
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
