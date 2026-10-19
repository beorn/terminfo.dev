/**
 * @failure Locally linked vt100.js/vt220.js/vterm.js resolve into bun's .bun store, so identity
 *   falls through to registryIntegrity and every vterm-family collect dies before a run exists.
 * @level l2
 * @consumer packages/probes/headless-identity.ts (28548)
 * @reach fs-walk <fixture-only: temporary lockfile, owned Git roots and installed package bytes>
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, beforeEach, expect, test } from "vitest"

let fixture: ReturnType<typeof identityFixture>

// Standalone CI has no sibling checkouts. Exercise the unchanged loader against real local
// Git/package resolution and independent file-install bytes, never a fabricated identity receipt.
function identityFixture({ termlessSubdir = join("vendor", "termless") }: { termlessSubdir?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "headless-identity-"))
  const termless = join(root, termlessSubdir)
  const vterm = join(root, "vendor", "vterm")
  const source = join(root, "vendor", "terminfo.dev", "packages", "probes", "headless-identity.ts")
  mkdirSync(join(root, "vendor", "terminfo.dev", "packages", "probes"), { recursive: true })
  cpSync(fileURLToPath(new URL("./headless-identity.ts", import.meta.url)), source)
  cpSync(
    fileURLToPath(new URL("./termless-root.ts", import.meta.url)),
    join(root, "vendor", "terminfo.dev", "packages", "probes", "termless-root.ts"),
  )
  const overrides: Record<string, string> = {}
  for (const name of ["vt100", "vt220", "vterm"]) {
    const workspace = join(vterm, "packages", name)
    const adapter = join(termless, "packages", name)
    const installed = join(root, "node_modules", ".bun", `${name}.js@file`, "node_modules", `${name}.js`)
    for (const directory of [workspace, adapter]) mkdirSync(join(directory, "src"), { recursive: true })
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: `${name}.js`, version: "0.7.1", main: "src/index.ts" }),
    )
    writeFileSync(join(workspace, "src", "index.ts"), `export const engine = ${JSON.stringify(name)}\n`)
    writeFileSync(
      join(adapter, "package.json"),
      JSON.stringify({ name: `@termless/${name}`, version: "0.1.0", main: "src/index.ts" }),
    )
    writeFileSync(join(adapter, "src", "index.ts"), "export {}\n")
    cpSync(workspace, installed, { recursive: true })
    mkdirSync(join(adapter, "node_modules"), { recursive: true })
    symlinkSync(installed, join(adapter, "node_modules", `${name}.js`), "dir")
    mkdirSync(join(root, "node_modules", "@termless"), { recursive: true })
    symlinkSync(adapter, join(root, "node_modules", "@termless", name), "dir")
    overrides[`${name}.js`] = `file:vendor/vterm/packages/${name}`
  }
  writeFileSync(join(root, "bun.lock"), JSON.stringify({ packages: overrides, overrides }))
  for (const repository of [termless, vterm]) {
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" })
      if (result.status !== 0) throw new Error(`identity fixture git ${args.join(" ")}: ${result.stderr}`)
    }
    git("init", "-q")
    git("add", "packages")
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "identity source")
    git("remote", "add", "origin", `https://example.invalid/${repository === termless ? "termless" : "vterm"}.git`)
  }
  return { root, vterm, identityHref: pathToFileURL(source).href }
}

beforeEach(() => {
  fixture = identityFixture()
})

afterEach(() => {
  // raw-delete-allow: standalone CI has no removely; root is this test's own mkdtemp fixture
  rmSync(fixture.root, { recursive: true, force: true })
})

function runIdentity(name: string, pkg: string) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `import { headlessRuntimeIdentity } from ${JSON.stringify(fixture.identityHref)};
       const id = await headlessRuntimeIdentity(${JSON.stringify(name)}, ${JSON.stringify(pkg)}, "js");
       process.stdout.write(JSON.stringify({ ok: true, integrityKind: id.integrity.kind, engineVersion: id.engineVersion, revision: id.termlessRevision }))`,
    ],
    { encoding: "utf8" },
  )
}

function runRegistryIntegrity(name: string, version: string) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `import { registryIntegrity } from ${JSON.stringify(fixture.identityHref)};
       registryIntegrity(${JSON.stringify(name)}, ${JSON.stringify(version)})`,
    ],
    { encoding: "utf8" },
  )
}

/**
 * @failure bun's file: install of vt100.js/vt220.js/vterm.js lands under node_modules/.bun, so
 *   identity used to throw "no matching registry integrity" and every vterm-family collect died
 *   before a run existed.
 * @level l2
 * @consumer packages/probes/headless-identity.ts file: override arm (28548)
 * @reach fs-walk <fixture-only: lockfile and installed source packages>
 * @testonly none
 */
for (const [name, pkg] of [
  ["vt100", "@termless/vt100"],
  ["vt220", "@termless/vt220"],
  ["vterm", "@termless/vterm"],
] as const) {
  test(`a locally linked ${name}.js engine is source provenance, not a registry tuple`, () => {
    const result = runIdentity(name, pkg)
    expect(result.stderr, result.stderr).not.toMatch(/no matching registry integrity/)
    expect(result.status, result.stderr).toBe(0)
    const body = JSON.parse(result.stdout) as { ok: boolean; integrityKind: string }
    expect(body.ok).toBe(true)
    expect(body.integrityKind).toBe("source")
  })
}

/**
 * @failure A name whose bun.lock entry is not a registry tuple must still be refused loudly; the
 *   file: arm must not weaken that check.
 * @level l2
 * @consumer packages/probes/headless-identity.ts registryIntegrity (28548)
 * @reach fs-walk <fixture-only: non-tuple lockfile entry>
 * @testonly registryIntegrity: refuse case imports the helper because identity no longer takes that path for the file: linked engines
 */
test("a package whose bun.lock entry is not a matching registry tuple is still refused", () => {
  const result = runRegistryIntegrity("vt100.js", "0.7.1")
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/Installed vt100\.js@0\.7\.1 has no matching registry integrity in root bun\.lock/)
})

/**
 * @failure file: identity accepted same name/version with different installed bytes, so a stale
 *   .bun copy could carry workspace provenance (chief ee266575 / review2 821d3bef).
 * @level l2
 * @consumer packages/probes/headless-identity.ts fileLinkIntegrity (28548)
 * @reach fs-walk <fixture-only: independent vt100 install and workspace>
 * @testonly fileLinkIntegrity: mismatch case imports the binder because swapping the live .bun
 *   install would poison sibling identity tests
 */
/**
 * @failure A Nix derivation whose env.src is an unpacked source directory (nixpkgs kitty)
 *   died with EISDIR in kittyIdentity, which read it as a flat archive file; no nixpkgs-built
 *   kitty could ever be identified.
 * @level l2
 * @consumer packages/probes/headless-identity.ts kittySourceProof (lane 5, lead ruling bb23d916)
 * @reach fs-walk <fixture-only: temporary archive file and source directory>
 * @testonly kittySourceProof: the helper is imported because driving the full kittyIdentity
 *   needs a real pinned Nix kitty in the store, which the fixture cannot fabricate
 */
test("kitty source proof: archive file keeps flat sha256, directory yields its NAR hash", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kitty-source-proof-"))
  try {
    const archive = join(tmp, "kitty.tar.xz")
    writeFileSync(archive, "fake archive bytes")
    const tree = join(tmp, "source")
    mkdirSync(join(tree, "src"), { recursive: true })
    writeFileSync(join(tree, "src", "main.c"), "int main(void);\n")
    // nix hash writes its sentry cache under $HOME/.cache/nix; give the children their own
    // home so the run's guard home stays clean (@i/17-test-system/25231).
    const childHome = join(tmp, "home")
    mkdirSync(childHome, { recursive: true })
    const childEnv = { ...process.env, HOME: childHome, XDG_CACHE_HOME: join(childHome, ".cache") }
    const run = (path: string) =>
      spawnSync(
        process.execPath,
        [
          "-e",
          `import { kittySourceProof } from ${JSON.stringify(fixture.identityHref)};
           process.stdout.write(JSON.stringify(kittySourceProof(${JSON.stringify(path)})))`,
        ],
        { encoding: "utf8", env: childEnv },
      )
    const archiveResult = run(archive)
    expect(archiveResult.status, archiveResult.stderr).toBe(0)
    expect(JSON.parse(archiveResult.stdout)).toEqual({
      kind: "archive",
      sha256: createHash("sha256").update("fake archive bytes").digest("hex"),
    })
    const treeResult = run(tree)
    expect(treeResult.status, treeResult.stderr).toBe(0)
    const nar = spawnSync("nix", ["hash", "path", tree], { encoding: "utf8", env: childEnv })
    expect(nar.status, nar.stderr).toBe(0)
    expect(JSON.parse(treeResult.stdout)).toEqual({ kind: "directory", narHash: nar.stdout.trim() })
    const missing = run(join(tmp, "absent"))
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toMatch(/Kitty source path is neither/)
    const fakeBin = join(tmp, "bin")
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(join(fakeBin, "nix"), "#!/bin/sh\necho sha256-not-a-real-hash\n", { mode: 0o755 })
    const malformed = spawnSync(
      process.execPath,
      [
        "-e",
        `import { kittySourceProof } from ${JSON.stringify(fixture.identityHref)};
         kittySourceProof(${JSON.stringify(tree)})`,
      ],
        { encoding: "utf8", env: { ...childEnv, PATH: `${fakeBin}:${process.env.PATH ?? ""}` } },
    )
    expect(malformed.status).not.toBe(0)
    expect(malformed.stderr).toMatch(/No NAR hash for Kitty source directory/)
  } finally {
    // raw-delete-allow: this test's own mkdtemp scratch root
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("same name and version with different installed bytes is refused", () => {
  const workspace = join(fixture.vterm, "packages", "vt100")
  const tmp = mkdtempSync(join(tmpdir(), "28548-mismatch-"))
  const installed = join(tmp, "installed")
  try {
    cpSync(workspace, installed, { recursive: true })
    const target = join(installed, "src", "index.ts")
    writeFileSync(target, `${readFileSync(target, "utf8")}\n// mismatched-install-bytes\n`)
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `import { fileLinkIntegrity } from ${JSON.stringify(fixture.identityHref)};
         fileLinkIntegrity(
           { path: ${JSON.stringify(target)}, directory: ${JSON.stringify(installed)}, version: "0.7.1" },
           ${JSON.stringify(workspace)},
           "vt100.js",
           ${JSON.stringify(fixture.root)},
         )`,
      ],
      { encoding: "utf8" },
    )
    expect(result.status, result.stderr).not.toBe(0)
    expect(result.stderr).toMatch(/disagrees with file: workspace/)
  } finally {
    // raw-delete-allow: standalone component repository whose CI installs without hh's workspace, so removely is unavailable; tmp is this test's own mkdtemp scratch root
    rmSync(tmp, { recursive: true, force: true })
  }
})

/**
 * @failure Identity reads the checkout beside the source tree instead of the one that loaded the
 *   adapter, so a Termless checkout elsewhere is refused or its revision is recorded wrongly.
 * @level l1
 * @consumer packages/probes/headless-identity.ts owning checkout derivation
 * @reach fs-walk <fixture-only: temporary Git checkouts>
 * @testonly none
 */
test("a Termless checkout outside the sibling path is used, and its own revision is recorded", () => {
  const elsewhere = join("elsewhere", "termless")
  fixture = identityFixture({ termlessSubdir: elsewhere })
  const result = runIdentity("vt100", "@termless/vt100")
  expect(result.status, result.stderr).toBe(0)
  const body = JSON.parse(result.stdout) as { ok: boolean; revision: string }
  const revision = spawnSync("git", ["-C", join(fixture.root, elsewhere), "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim()
  expect(body.ok).toBe(true)
  expect(body.revision).toBe(revision)
})
