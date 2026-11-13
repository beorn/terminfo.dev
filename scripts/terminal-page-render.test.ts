/**
 * @failure A cell two joined contexts decided differently reads decided on the real terminal page (a differs
 *   segment, or Supported/Unsupported) instead of the open PROBE CONFLICT the join gives it (33587), so a
 *   reader cannot tell a measured disagreement from a decided grade.
 * @level l2
 * @consumer terminfo.dev /terminals/<app> (docs/terminals/[id].md)
 * @source-grep the bar, its title and the coverage sentence are written in the page's VitePress
 *   <script setup> and template, which no unit runner imports. This test therefore renders the REAL page
 *   file through VitePress's own markdown renderer and the Vue plugin VitePress itself builds with,
 *   stubbing only `useData` (the route's page params) and the data module (one joined row), and asserts
 *   the server-rendered text.
 * @testonly none
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { renderToString } from "@vue/server-renderer"
import { createSSRApp } from "vue"
import { createMarkdownRenderer } from "vitepress"
import { afterAll, describe, expect, it } from "vitest"
import { joinContextCells, type ContextFacts } from "../docs/data/app-cells.ts"

const root = join(import.meta.dirname, "..")
const PAGE = join(root, "docs", "terminals", "[id].md")
const PRIMARY = 'term:ghostty@["term","ghostty","macos","25.4.0",null,null,null,null]'
const OTHER = 'term:ghostty@["term","ghostty","macos","26.0.0",null,null,null,null]'
const CATALOG = ["sgr.bold", "sgr.italic"]
const PARAMS = {
  backendId: "ghostty",
  id: "ghostty",
  terminalName: "Ghostty",
  backendName: "Ghostty",
  terminalType: "term",
  historical: "false",
  categories: "",
  otherRuns: "[]",
  historySubjects: "[]",
}

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) {
    // raw-delete-allow: standalone component repository has no removely dependency; every path is this test's own mkdtemp scratch root
    rmSync(dir, { recursive: true, force: true })
  }
})

const cell = (status: "supported" | "unsupported", runId: string) => ({
  status,
  version: "1.2.3",
  suite: "suite-a",
  entryHash: "entry-a",
  sourceRevision: "a".repeat(40),
  runId,
})

/** The production join decides this row; the page is only ever fed what `joinContextCells` returned. */
function joinedRow(): Record<string, unknown> {
  const primary: ContextFacts = {
    key: PRIMARY,
    cells: { "sgr.bold": cell("supported", "run-primary"), "sgr.italic": cell("supported", "run-primary") },
  }
  const other: ContextFacts = {
    key: OTHER,
    cells: { "sgr.bold": cell("unsupported", "run-other"), "sgr.italic": cell("supported", "run-other") },
  }
  const joined = joinContextCells(primary, [other], CATALOG, () => null, CATALOG)
  const featureResults = Object.fromEntries(
    Object.entries(joined.cells).map(([featureId, entry]) => [
      featureId,
      {
        featureId,
        status: entry.status,
        reason: entry.from.map((from) => `${from.context} graded ${from.status}`).join("; "),
        ...(entry.from.length > 1 ? { joined: { status: entry.status, from: entry.from } } : {}),
      },
    ]),
  )
  return { featureResults }
}

function selectionOf(featureResults: Record<string, unknown>): Record<string, unknown> {
  return {
    backendId: "ghostty",
    catalogIds: CATALOG,
    featureResults,
    runId: "run-primary",
    measuredAt: "2026-11-11T20:34:05.000Z",
    suiteId: "suite-a",
    suiteFreshness: "live tree",
    suiteRelation: "tree",
    sha256: "a".repeat(64),
    subject: { kind: "term", id: "ghostty", version: "1.2.3", os: "macos", osVersion: "25.4.0" },
  }
}

/**
 * VitePress builds .md with its own Vite and `@vitejs/plugin-vue`, which are not this package's
 * dependencies: load the ones installed beside VitePress, so the page compiles with exactly the build
 * VitePress itself runs, and refuse loudly if that install no longer holds them.
 */
const installedWithVitepress = dirname(dirname(fileURLToPath(import.meta.resolve("vitepress/package.json"))))
function vitepressDependency(relative: string): string {
  const path = join(installedWithVitepress, relative)
  if (!existsSync(path)) {
    throw new Error(
      `${path}: VitePress's install no longer holds ${relative}; this harness must resolve its build again`,
    )
  }
  return pathToFileURL(path).href
}
const VITE = vitepressDependency("vite/dist/node/index.js")
const VUE_PLUGIN = vitepressDependency("@vitejs/plugin-vue/dist/index.mjs")

type SsrServer = { ssrLoadModule(id: string): Promise<{ default: unknown }>; close(): Promise<void> }

let markdown: Awaited<ReturnType<typeof createMarkdownRenderer>> | undefined

/**
 * Renders `docs/terminals/[id].md` as VitePress renders it: its own markdown renderer, its own SFC
 * construction (`<script>` blocks + `<template><div>html</div></template>`), its own Vue plugin, server-side.
 * The scratch root symlinks the page's real imports, so no source is copied.
 */
async function renderTerminalPage(selected: Record<string, unknown>): Promise<string> {
  markdown ??= await createMarkdownRenderer(join(root, "docs"), {}, "/")
  const out = mkdtempSync(join(tmpdir(), "terminfo-terminal-page-"))
  scratch.push(out)
  mkdirSync(join(out, "docs", "terminals"), { recursive: true })
  for (const name of ["data", ".vitepress"] as const) symlinkSync(join(root, "docs", name), join(out, "docs", name))
  symlinkSync(join(root, "packages"), join(out, "packages"))
  symlinkSync(join(root, "node_modules"), join(out, "node_modules"))

  const source = readFileSync(PAGE, "utf8")
  const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1]
  if (script === undefined) {
    throw new Error(`${PAGE}: expected one <script setup> block; this harness no longer matches the page`)
  }
  writeFileSync(
    join(out, "docs", "terminals", "page.vue"),
    `<script setup>${script}</script>\n<template><div>${markdown.render(source)}</div></template>\n`,
  )
  const paramsStub = join(out, "vitepress-stub.ts")
  writeFileSync(paramsStub, `export const useData = () => ({ params: { value: ${JSON.stringify(PARAMS)} } })\n`)
  const dataStub = join(out, "probes-stub.ts")
  writeFileSync(
    dataStub,
    `export const data = { selectedByBackend: { ghostty: { selected: ${JSON.stringify(selected)} } }, featureDescriptions: {}, features: [] }\n`,
  )

  const { createServer } = (await import(VITE)) as { createServer(options: unknown): Promise<SsrServer> }
  const vuePlugin = ((await import(VUE_PLUGIN)) as { default(options: unknown): unknown }).default
  // The panels below the bar (evidence cells, run history) are their own page-level components and are
  // not what this proof is about; they stand here as inert elements.
  const isCustomElement = (tag: string) => /^[A-Z]/.test(tag)
  const server = await createServer({
    root: out,
    configFile: false,
    logLevel: "error",
    server: { middlewareMode: true },
    plugins: [vuePlugin({ include: [/\.vue$/], template: { compilerOptions: { isCustomElement } } })],
    resolve: {
      alias: [
        { find: /^vitepress$/, replacement: paramsStub },
        { find: /^\.\.\/data\/probes\.data$/, replacement: dataStub },
      ],
    },
    ssr: { external: ["vue", "@vue/server-renderer"] },
  })
  try {
    const page = await server.ssrLoadModule("/docs/terminals/page.vue")
    return await renderToString(createSSRApp(page.default as never))
  } finally {
    await server.close()
  }
}

describe("the real terminal page renders one joined disagreement", () => {
  it("reads the disagreement as one open PROBE CONFLICT, draws no differs segment, and keeps it out of the numerator", async () => {
    const rendered = await renderTerminalPage(selectionOf(joinedRow().featureResults as Record<string, unknown>))
    expect(rendered).not.toContain('class="result-share-differs"')
    expect(rendered).not.toContain("Differs by context")
    expect(rendered).toContain(
      "1 Supported · 0 Unsupported · 0 Untestable · 0 PROBE TODO · 0 PROBE INVALID · 1 PROBE CONFLICT",
    )
    expect(rendered).toContain("1/2 supported (50%)")
  }, 60_000)

  it("prints nothing about a disagreement when no cell disagrees", async () => {
    const supported = (featureId: string) => ({ featureId, status: "supported", reason: "measured supported" })
    const rendered = await renderTerminalPage(
      selectionOf({ "sgr.bold": supported("sgr.bold"), "sgr.italic": supported("sgr.italic") }),
    )
    expect(rendered).not.toContain("result-share-differs")
    expect(rendered).not.toContain("Differs by context")
    expect(rendered).toContain(
      "2 Supported · 0 Unsupported · 0 Untestable · 0 PROBE TODO · 0 PROBE INVALID · 0 PROBE CONFLICT",
    )
    expect(rendered).toContain("2/2 supported (100%)")
  }, 60_000)
})
