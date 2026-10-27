/**
 * @source-grep copies headless-identity.ts into a temp repo so file: installs resolve; assertions are on the loader, not the source text
 * @failure Local file:/workspace: vt100.js/vt220.js/vterm.js resolve into bun's .bun store, so identity
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
  writeFileSync(join(root, "flake.lock"), "{}\n")
  const kittyAdapter = join(termless, "packages", "kitty")
  mkdirSync(join(kittyAdapter, "src"), { recursive: true })
  writeFileSync(
    join(kittyAdapter, "package.json"),
    JSON.stringify({ name: "@termless/kitty", version: "0.1.0", main: "src/index.ts" }),
  )
  writeFileSync(join(kittyAdapter, "src", "index.ts"), "export {}\n")
  symlinkSync(kittyAdapter, join(root, "node_modules", "@termless", "kitty"), "dir")
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
  return { root, vterm, termless, identityHref: pathToFileURL(source).href }
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
       process.stdout.write(JSON.stringify({ ok: true, integrityKind: id.integrity.kind, engineVersion: id.engineVersion, revision: id.termlessRevision, resolvedPath: id.resolvedPath }))`,
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

// Source-proof tests start after derivation selection; exercise the public identity entry here.
// These Nix command responses project the retained Kitty 0.49.2 format-4 derivation from 30211.
const kittyStore = "/nix/store/afvnxnvk3lchq4b0ihmhw93xc7x9q4py-kitty-0.49.2"
const kittyDeriver = "/nix/store/7z13wj90r3kxc8pdxcdjqm81xqsj2444-kitty-0.49.2.drv"
const kittySource = "/nix/store/nzf4mjj8bdhdn0mygayh03bigayxyly0-source"
function runKittyIdentity(attrs: Record<string, unknown>, sourcePresent = true, unrelatedFirst = false) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `
    Object.defineProperty(process, "platform", { value: "linux" });
    Object.defineProperty(process, "arch", { value: "x64" });
    const fs = require("node:fs");
    const child = require("node:child_process");
    const realpath = fs.realpathSync, readFile = fs.readFileSync, stat = fs.statSync, exec = child.execFileSync;
    const store = ${JSON.stringify(kittyStore)}, deriver = ${JSON.stringify(kittyDeriver)}, source = ${JSON.stringify(kittySource)};
    fs.realpathSync = (path, ...args) => path === "/fixture/kitty" ? store + "/bin/kitty" : realpath(path, ...args);
    fs.readFileSync = (path, ...args) => path === store + "/bin/kitty" ? Buffer.from("fixture kitty binary") : readFile(path, ...args);
    fs.statSync = (path, ...args) => path === source ? stat(${JSON.stringify(fixture.root)} + (${sourcePresent} ? "" : "/absent-source")) : stat(path, ...args);
    child.execFileSync = (command, args, options) => {
      if (command === store + "/bin/kitty") return "kitty 0.49.2";
      if (command !== "nix") return exec(command, args, options);
      if (args[0] === "path-info") return JSON.stringify({ [store]: { narHash: "sha256-" + "A".repeat(43) + "=", deriver } });
      if (args[0] === "derivation") return JSON.stringify({ version: 4, derivations: {
        ...(${unrelatedFirst} ? { "unrelated.drv": { env: { src: "/nix/store/unrelated-source" } } } : {}),
        [deriver.split("/").at(-1)]: ${JSON.stringify(attrs)}
      } });
      if (args[0] === "hash" && args[1] === "path" && args[2] === source) return "sha256-" + "B".repeat(43) + "=";
      throw new Error("Unexpected Nix operation: " + args.join(" "));
    };
    const { headlessRuntimeIdentity } = await import(${JSON.stringify(fixture.identityHref)});
    const identity = await headlessRuntimeIdentity("kitty", "@termless/kitty", "native");
    process.stdout.write(JSON.stringify(identity));
  `,
    ],
    { encoding: "utf8", env: { ...process.env, KITTY_BINARY: "/fixture/kitty" } },
  )
}

test.each([
  { name: "legacy source", attrs: { env: { src: kittySource } }, succeeds: true },
  { name: "structured source", attrs: { structuredAttrs: { src: kittySource } }, succeeds: true },
  {
    name: "matching declarations",
    attrs: { env: { src: kittySource }, structuredAttrs: { src: kittySource } },
    succeeds: true,
  },
  {
    name: "conflicting declarations",
    attrs: { env: { src: kittySource }, structuredAttrs: { src: "/nix/store/other-source" } },
    succeeds: false,
  },
  {
    name: "malformed structured source",
    attrs: { env: { src: kittySource }, structuredAttrs: { src: 42 } },
    succeeds: false,
  },
  { name: "missing declarations", attrs: {}, succeeds: false },
])("Kitty identity binds $name to the declared source", ({ attrs, succeeds }) => {
  const result = runKittyIdentity(attrs)
  if (succeeds) {
    expect(result.status, result.stderr).toBe(0)
    const identity = JSON.parse(result.stdout)
    expect(identity).toMatchObject({
      engineVersion: "0.49.2",
      loadedBinary: { path: `${kittyStore}/bin/kitty` },
      provenance: { toolchain: expect.stringContaining(`source directory ${kittySource} narHash sha256-`) },
    })
  } else {
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/source.*(?:derivation|declaration)|(?:derivation|declaration).*source/i)
  }
})

test("Kitty identity reports the absent declared source without realizing or substituting it", () => {
  const result = runKittyIdentity({ structuredAttrs: { src: kittySource } }, false)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain(`Kitty source path is neither an archive file nor a source directory: ${kittySource}`)
  expect(result.stderr).not.toContain("Unexpected Nix operation")
})

test("Kitty identity selects the output's recorded deriver when another derivation is first", () => {
  const result = runKittyIdentity({ env: { src: kittySource } }, true, true)
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    provenance: { toolchain: expect.stringContaining(`source directory ${kittySource} narHash `) },
  })
})

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
  test.each(["file:", "workspace:*"])(`a locally linked ${name}.js engine via %s binds source bytes`, (protocol) => {
    if (protocol === "workspace:*") {
      // Real workspace lock shape from 30871; the installed copy still has independent bytes.
      const lockPath = join(fixture.root, "bun.lock")
      writeFileSync(
        lockPath,
        JSON.stringify({
          overrides: { [`${name}.js`]: protocol },
          packages: { [`${name}.js`]: [`${name}.js@workspace:vendor/vterm/packages/${name}`] },
        }),
      )
    }
    const result = runIdentity(name, pkg)
    expect(result.stderr, result.stderr).not.toMatch(/no matching registry integrity/)
    expect(result.status, result.stderr).toBe(0)
    const body = JSON.parse(result.stdout) as { ok: boolean; integrityKind: string; resolvedPath: string }
    expect(body.ok).toBe(true)
    expect(body.integrityKind).toBe("source")
    if (protocol === "workspace:*") {
      // Recognizing workspace provenance must not certify the stale install that exposed this bug.
      const installed = join(fixture.root, body.resolvedPath)
      writeFileSync(installed, `${readFileSync(installed, "utf8")}\n// stale workspace copy\n`)
      const stale = runIdentity(name, pkg)
      expect(stale.status, stale.stderr).not.toBe(0)
      expect(stale.stderr).toMatch(/disagrees with file: workspace source/)
    }
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
/**
 * @failure resolvedPath and loadedBinary.path recorded the collecting checkout's absolute path, so
 *   committed headless run files published the build host's folder layout (30568).
 * @level l2
 * @consumer packages/probes/headless-identity.ts recordedPath
 * @reach fs-walk <fixture-only: temporary lockfile, owned Git roots and installed package bytes>
 * @testonly none
 */
test("a run records the engine path inside the workspace, never the collecting host's folders", () => {
  const result = runIdentity("vt100", "@termless/vt100")
  expect(result.status, result.stderr).toBe(0)
  const body = JSON.parse(result.stdout) as { resolvedPath: string }
  expect(body.resolvedPath).toBe("node_modules/.bun/vt100.js@file/node_modules/vt100.js/src/index.ts")
  expect(result.stdout).not.toContain(fixture.root)
})

/**
 * @failure A loaded file outside the workspace's vendor/ and node_modules/ trees and the Nix store
 *   had no publishable name, so it would have recorded the host path (30568). The refusal itself
 *   reaches the run draft through the collector's failure record, so it names the file only.
 * @level l2
 * @consumer packages/probes/headless-identity.ts recordedPath
 * @reach fs-walk <fixture-only: imports the copied identity module>
 * @testonly recordedPath: the fixture's js engines never load a Nix store binary or a file outside
 *   the workspace, so both arms are pinned through the exported helper
 */
test("a Nix store path is recorded as is; a path outside the workspace is refused without its folder", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import { recordedPath } from ${JSON.stringify(fixture.identityHref)};
       const store = recordedPath("/nix/store/0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kitty-0.49.2/bin/kitty");
       let refused = "";
       try { recordedPath("/opt/elsewhere/lib/engine.wasm") } catch (error) { refused = String(error) }
       process.stdout.write(JSON.stringify({ store, refused }))`,
    ],
    { encoding: "utf8" },
  )
  expect(result.status, result.stderr).toBe(0)
  const body = JSON.parse(result.stdout) as { store: string; refused: string }
  expect(body.store).toBe("/nix/store/0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-kitty-0.49.2/bin/kitty")
  expect(body.refused).toMatch(/outside the workspace's vendor\/ and node_modules\/ trees and the Nix store/)
  expect(body.refused).toContain("Cannot record engine.wasm ")
  expect(body.refused).not.toContain("/opt/elsewhere")
})

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

// #30576 source binding: the old sentinel suite changed versions only. This uses its
// existing owned Git/package fixture and the production identity producer/comparer.
function runReplyDecision(mode: string) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `
      import { execFileSync } from "node:child_process";
      import { createHash } from "node:crypto";
      import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
      import { join, relative } from "node:path";
      const { headlessRuntimeIdentity, replyDeliveryDecision } = await import(${JSON.stringify(fixture.identityHref)});
      const root = ${JSON.stringify(fixture.root)}, adapterRoot = ${JSON.stringify(fixture.termless)};
      const engineRoot = ${JSON.stringify(fixture.vterm)}, mode = ${JSON.stringify(mode)};
      const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], {encoding:"utf8"}).trim();
      const entry = join(adapterRoot, "packages/vt100/src/index.ts");
      const declaration = {
        boundary: "feed-and-getCursor",
        adapterSources: [{path:relative(adapterRoot, entry), blobOid:git(adapterRoot, "hash-object", entry)}],
        engine: {kind:"source",repository:git(engineRoot,"remote","get-url","origin"),treeOid:git(engineRoot,"rev-parse","HEAD:packages/vt100")}
      };
      if (mode === "engine" || mode === "dirty") {
        const text = 'export const engine = "changed source, same version";\\n';
        writeFileSync(join(engineRoot,"packages/vt100/src/index.ts"),text);
        writeFileSync(join(root,"node_modules/.bun/vt100.js@file/node_modules/vt100.js/src/index.ts"),text);
        if (mode === "engine") {
          git(engineRoot,"add","packages/vt100/src/index.ts");
          git(engineRoot,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","engine source change without version bump");
        }
      }
      const identity = await headlessRuntimeIdentity("vt100","@termless/vt100","js");
      const runtime = {identity,adapterPath:entry,adapterPackage:"@termless/vt100"};
      if (mode === "adapter") writeFileSync(entry,readFileSync(entry,"utf8")+"\\n// changed imported adapter, same versions\\n");
      if (mode === "registry-match" || mode === "registry-drift") {
        const expected = "sha512-"+Buffer.alloc(64,1).toString("base64");
        declaration.engine = {kind:"registry",lockIntegrity:expected};
        identity.integrity = {kind:"registry",lockIntegrity:mode === "registry-match" ? expected : "sha512-"+Buffer.alloc(64,2).toString("base64")};
      }
      if (mode === "wasm-match" || mode === "wasm-drift") {
        const path = join(root,"engine.wasm");
        writeFileSync(path,"fixture engine bytes");
        const digest = () => createHash("sha256").update(readFileSync(path)).digest("hex");
        declaration.engine = {kind:"wasm",sha256:digest()};
        if (mode === "wasm-drift") writeFileSync(path,"different engine bytes, same version");
        identity.runtimeFormat = "wasm";
        identity.loadedBinary = {path:"vendor/termless/engine.wasm",sha256:digest()};
      }
      if (mode === "entry") declaration.adapterSources = [];
      if (mode === "outside") declaration.adapterSources.push({path:"../vterm/packages/vt100/src/index.ts",blobOid:git(engineRoot,"hash-object","packages/vt100/src/index.ts")});
      if (mode === "dist") {
        const pkg = join(root,"dist-only");
        mkdirSync(pkg);
        writeFileSync(join(pkg,"package.json"),JSON.stringify({name:"@termless/vt100"}));
        writeFileSync(join(pkg,"index.js"),"export {}\\n");
        runtime.adapterPath = join(pkg,"index.js");
      }
      const warnings = [];
      const result = replyDeliveryDecision("unit-adapter",mode === "absent" ? undefined : declaration,mode === "identity" ? undefined : runtime,line => warnings.push(line));
      process.stdout.write(JSON.stringify({result,warnings,engineVersion:identity.engineVersion}));
      `,
    ],
    { encoding: "utf8" },
  )
}

test.each([
  ["match", true, "bound to its loaded source"],
  ["adapter", false, "adapterSources"],
  ["engine", false, "treeOid"],
  ["dirty", false, "cleanTree"],
  ["registry-match", true, "bound to its loaded source"],
  ["registry-drift", false, "lockIntegrity"],
  ["wasm-match", true, "bound to its loaded source"],
  ["wasm-drift", false, "sha256"],
  ["entry", false, "source binding"],
  ["outside", false, "outside its imported checkout"],
  ["dist", false, "dist-only loses coverage"],
  ["absent", false, "declares no reply delivery"],
  ["identity", false, "no measured runtime identity"],
] as const)("reply eligibility %s uses source/engine facts, not unchanged versions", (mode, member, reason) => {
  const run = runReplyDecision(mode)
  expect(run.status, run.stderr).toBe(0)
  const body = JSON.parse(run.stdout) as {
    engineVersion: string
    result: { member: boolean; reason: string }
    warnings: string[]
  }
  expect(body.engineVersion).toBe("0.7.1")
  expect(body.result.member).toBe(member)
  expect(body.result.reason).toContain(reason)
  expect(body.warnings).toHaveLength(member ? 0 : 1)
  if (!member) expect(body.warnings[0]).toContain(body.result.reason)
})
