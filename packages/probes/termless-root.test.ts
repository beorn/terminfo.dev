/**
 * @failure The Termless checkout is assumed beside the source tree, a package the resolver found
 *   inside another repository is taken as the checkout, or a refusal does not name what it saw.
 * @level l1
 * @consumer packages/probes/collect-headless.ts, packages/probes/headless-identity.ts
 * @reach fs-walk <fixture-only: temporary Git checkouts>
 * @testonly none
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, test } from "vitest"
import { owningCheckout } from "./termless-root.ts"

let fixture: string

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "owning-checkout-"))
})

afterEach(() => {
  // raw-delete-allow: this test's own mkdtemp scratch root
  rmSync(fixture, { recursive: true, force: true })
})

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function commit(directory: string): void {
  git(directory, "init", "-q")
  git(directory, "add", ".")
  git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "adapter")
}

/** A checkout holding one adapter package at packages/<leaf>, plus the file the resolver returns. */
function checkout(name: string, track = true): { root: string; adapterPath: string; directory: string } {
  const root = join(fixture, name)
  const directory = join(root, "packages", "xtermjs")
  mkdirSync(join(directory, "dist"), { recursive: true })
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "@termless/xtermjs", version: "0.1.0", main: "dist/index.js" }),
  )
  writeFileSync(join(directory, "dist", "index.js"), "export {}\n")
  if (track) commit(root)
  return {
    root: realpathSync(root),
    directory: realpathSync(directory),
    adapterPath: join(directory, "dist", "index.js"),
  }
}

test("the checkout that tracks the adapter is used wherever it lives", () => {
  const termless = checkout(join("elsewhere", "termless"))
  expect(owningCheckout(termless.adapterPath, "@termless/xtermjs")).toBe(termless.root)
})

test("the monorepo sibling layout still resolves", () => {
  const workspace = checkout(join("repo", "vendor", "terminfo.dev"))
  const termless = checkout(join("repo", "vendor", "termless"))
  expect(owningCheckout(workspace.adapterPath, "@termless/xtermjs")).toBe(workspace.root)
  expect(owningCheckout(termless.adapterPath, "@termless/xtermjs")).toBe(termless.root)
})

test("a symlinked adapter resolves to the checkout it points at", () => {
  const termless = checkout("termless")
  const link = join(fixture, "linked-adapter")
  symlinkSync(termless.root, link, "dir")
  expect(owningCheckout(join(link, "packages", "xtermjs", "dist", "index.js"), "@termless/xtermjs")).toBe(termless.root)
})

test("an untracked package inside a parent repository refuses and names the path", () => {
  const parent = checkout("dev-repo")
  const untracked = join(parent.root, "node_modules", "@termless", "xtermjs")
  mkdirSync(untracked, { recursive: true })
  writeFileSync(
    join(untracked, "package.json"),
    JSON.stringify({ name: "@termless/xtermjs", version: "0.1.0", main: "index.js" }),
  )
  writeFileSync(join(untracked, "index.js"), "export {}\n")

  expect(() => owningCheckout(join(untracked, "index.js"), "@termless/xtermjs")).toThrow(/not tracked/)
  expect(() => owningCheckout(join(untracked, "index.js"), "@termless/xtermjs")).toThrow(
    /@termless\/xtermjs resolved to .*node_modules\/@termless\/xtermjs\/index\.js/,
  )
})

test("a package outside any Git checkout refuses and names the package", () => {
  const loose = checkout("loose", false)
  expect(() => owningCheckout(loose.adapterPath, "@termless/xtermjs")).toThrow(/@termless\/xtermjs resolved to/)
  expect(() => owningCheckout(loose.adapterPath, "@termless/xtermjs")).toThrow(/not inside a Git checkout/)
})

test("both collection entry points take the checkout from this resolver", () => {
  for (const name of ["collect-headless.ts", "headless-identity.ts"]) {
    const source = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8")
    expect(source, name).toMatch(/owningCheckout\(/)
    expect(source, name).not.toMatch(/["']\.\.\/termless["']/)
  }
})
