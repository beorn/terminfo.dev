/**
 * @failure Locally linked vt100.js/vt220.js/vterm.js resolve into bun's .bun store, so identity
 *   falls through to registryIntegrity and every vterm-family collect dies before a run exists.
 * @level l2
 * @consumer packages/probes/headless-identity.ts (28548)
 * @reach fs-walk bun.lock vendor/vterm/packages/vt100 vendor/vterm/packages/vt220 vendor/vterm/packages/vterm
 * @testonly none
 */
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const identityHref = new URL("./headless-identity.ts", import.meta.url).href

function runIdentity(name: string, pkg: string) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `import { headlessRuntimeIdentity } from ${JSON.stringify(identityHref)};
       const id = await headlessRuntimeIdentity(${JSON.stringify(name)}, ${JSON.stringify(pkg)}, "js");
       process.stdout.write(JSON.stringify({ ok: true, integrityKind: id.integrity.kind, engineVersion: id.engineVersion }))`,
    ],
    { encoding: "utf8" },
  )
}

function runRegistryIntegrity(name: string, version: string) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `import { registryIntegrity } from ${JSON.stringify(identityHref)};
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
 * @reach fs-walk bun.lock vendor/vterm/packages/vt100 vendor/vterm/packages/vt220 vendor/vterm/packages/vterm
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
 * @reach fs-walk bun.lock
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
 * @reach fs-walk vendor/vterm/packages/vt100
 * @testonly fileLinkIntegrity: mismatch case imports the binder because swapping the live .bun
 *   install would poison sibling identity tests
 */
test("same name and version with different installed bytes is refused", () => {
  const workspace = fileURLToPath(new URL("../../../vterm/packages/vt100", import.meta.url))
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
        `import { fileLinkIntegrity } from ${JSON.stringify(identityHref)};
         fileLinkIntegrity(
           { path: ${JSON.stringify(target)}, directory: ${JSON.stringify(installed)}, version: "0.7.1" },
           ${JSON.stringify(workspace)},
           "vt100.js",
         )`,
      ],
      { encoding: "utf8" },
    )
    expect(result.status, result.stderr).not.toBe(0)
    expect(result.stderr).toMatch(/disagrees with file: workspace/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
