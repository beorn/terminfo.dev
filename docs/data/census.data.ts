/**
 * VitePress build-time data loader for census results.
 *
 * Reads the unified census.json (copied from Termless during build/deploy)
 * and reshapes it for the matrix page.
 *
 * Consumed via: import { data } from './data/census.data'
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { manifest } from "@termless/core"

const __dirname = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(__dirname, "results")

export interface BackendInfo {
  name: string
  version: string
  engine: string
  type?: "app" | "headless"
  platforms?: string[]
}

export interface FeatureResult {
  id: string
  name: string
  category: string
  spec?: string
}

export interface TerminalMeta {
  name?: string
  description?: string
  body?: string
  url?: string
  repo?: string
  author?: string
}

export interface BackendMeta {
  label?: string
  description?: string
  body?: string
  url?: string
  upstream?: string
  type?: string
  caveat?: string
  slug?: string
  terminal?: TerminalMeta
}

export interface CensusData {
  backends: BackendInfo[]
  features: FeatureResult[]
  /** category -> FeatureResult[] */
  categories: Record<string, FeatureResult[]>
  /** backend name -> feature id -> "yes" | "no" | "partial" */
  results: Record<string, Record<string, string>>
  /** backend name -> feature id -> note string */
  notes: Record<string, Record<string, string>>
  /** backend name -> { total, yes, no, partial, pct } */
  stats: Record<string, { total: number; yes: number; no: number; partial: number; pct: number }>
  /** backend name -> metadata from backends.json */
  meta: Record<string, BackendMeta>
  /** "backend:feature" -> { note, url? } from annotations.json */
  annotations: Record<string, { note: string; url?: string; result?: string }>
  /** feature id -> { name, url? } from features.json */
  featureDescriptions: Record<string, FeatureMeta>
  /** baseline -> feature ids */
  baselines: Record<string, string[]>
  /** backend name -> baseline -> { total, yes, pct } */
  baselineStats: Record<string, Record<string, { total: number; yes: number; pct: number }>>
  generated: string
}

interface FeatureMeta {
  name: string
  slug?: string
  url?: string
  tags?: string[]
  group?: string
  body?: string
  probe?: string
  baseline?: string
}

function loadFeatureDescriptions(): Record<string, FeatureMeta> {
  const path = join(__dirname, "..", "..", "features.json")
  if (!existsSync(path)) {
    throw new Error(`features.json not found at ${path}`)
  }
  {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>
    delete raw.$comment
    // Normalize: strings become { name: string }, objects stay as-is
    const result: Record<string, FeatureMeta> = {}
    for (const [id, val] of Object.entries(raw)) {
      if (typeof val === "string") result[id] = { name: val }
      else {
        const v = val as any
        result[id] = {
          name: v.name,
          slug: v.slug,
          url: v.url,
          tags: v.tags,
          group: v.group,
          body: v.body,
          probe: v.probe,
          baseline: v.baseline,
        }
      }
    }
    return result
  }
}

function loadAnnotations(): Record<string, { note: string; url?: string; result?: string }> {
  const annotationsPath = join(__dirname, "..", "..", "annotations.json")
  if (!existsSync(annotationsPath)) {
    throw new Error(`annotations.json not found at ${annotationsPath}`)
  }
  return JSON.parse(readFileSync(annotationsPath, "utf-8")) as Record<
    string,
    { note: string; url?: string; result?: string }
  >
}

function loadBackendMeta(): Record<string, BackendMeta> {
  const m = manifest()
  const meta: Record<string, BackendMeta> = {}
  for (const [name, entry] of Object.entries(m.backends)) {
    meta[name] = {
      label: entry.label,
      description: entry.description,
      url: entry.url,
      upstream: entry.upstream ?? undefined,
      type: entry.type,
      caveat: entry.caveat,
      slug: entry.slug,
      terminal: entry.terminal,
    }
  }
  return meta
}

declare const data: CensusData
export { data }

export default {
  load(): CensusData {
    // Load app (community) results as primary — these test real terminals
    const appData = loadAppResults()

    // Load headless results as fallback for terminals without app results
    let headlessData: CensusData
    const unifiedPath = join(resultsDir, "census.json")
    if (existsSync(unifiedPath)) {
      headlessData = loadUnifiedCensus(unifiedPath)
    } else {
      headlessData = loadPerBackendResults()
    }

    let result: CensusData
    // If we have app results, merge them as primary
    if (appData.backends.length > 0) {
      result = mergeResults(appData, headlessData)
    } else {
      // Fallback to headless only
      result = headlessData
    }

    // Compute baseline stats
    computeBaselines(result)
    return result
  },
}

/** Merge app results (primary) with headless results (fallback for missing terminals) */
function mergeResults(app: CensusData, headless: CensusData): CensusData {
  const merged = { ...app }

  // Add headless-only backends that don't have app results
  const appNames = new Set(app.backends.map((b) => b.name))
  for (const hb of headless.backends) {
    // Map headless backend names to app terminal names
    const appName = headlessToAppName(hb.name)
    if (!appNames.has(appName) && !appNames.has(hb.name)) {
      merged.backends.push(hb)
      merged.results[hb.name] = headless.results[hb.name] ?? {}
      merged.notes[hb.name] = headless.notes[hb.name] ?? {}
      merged.stats[hb.name] = headless.stats[hb.name] ?? { total: 0, yes: 0, no: 0, partial: 0, pct: 0 }
      if (headless.meta[hb.name]) merged.meta[hb.name] = headless.meta[hb.name]!
    }
  }

  // Merge headless-only features into the feature list
  const existingIds = new Set(merged.features.map((f) => f.id))
  for (const hf of headless.features) {
    if (!existingIds.has(hf.id)) {
      merged.features.push(hf)
      existingIds.add(hf.id)
    }
  }
  // Re-sort features and rebuild categories
  merged.features.sort((a, b) => a.id.localeCompare(b.id))
  merged.categories = {}
  for (const f of merged.features) {
    if (!merged.categories[f.category]) merged.categories[f.category] = []
    merged.categories[f.category]!.push(f)
  }

  return merged
}

function headlessToAppName(backend: string): string {
  const map: Record<string, string> = {
    xtermjs: "com.microsoft.VSCode",
    "ghostty-native": "ghostty",
    kitty: "kitty",
  }
  return map[backend] ?? backend
}

/** Load community/app results from docs/data/results/app/ */
function loadAppResults(): CensusData {
  const appDir = join(resultsDir, "app")
  let files: string[]
  try {
    files = readdirSync(appDir).filter((f) => f.endsWith(".json"))
  } catch {
    return emptyData()
  }
  if (files.length === 0) return emptyData()

  // Keep only latest result per terminal, and collect all platforms per terminal
  const latest = new Map<string, any>()
  const platformMap = new Map<string, Set<string>>()
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(appDir, file), "utf-8")) as any
      if (!raw.terminal || !raw.results) continue
      const key = raw.terminal
      if (!latest.has(key) || (raw.generated ?? "") > (latest.get(key).generated ?? "")) {
        latest.set(key, raw)
      }
      // Track all OS values seen for this terminal across all result files
      if (raw.os) {
        if (!platformMap.has(key)) platformMap.set(key, new Set())
        platformMap.get(key)!.add(raw.os)
      }
    } catch {}
  }

  const allBackends: BackendInfo[] = []
  const results: Record<string, Record<string, string>> = {}
  const notes: Record<string, Record<string, string>> = {}
  const featureSet = new Map<string, FeatureResult>()
  const featureDescs = loadFeatureDescriptions()

  for (const [name, raw] of latest) {
    allBackends.push({
      name,
      version: raw.terminalVersion ?? "",
      engine: "",
      type: "app",
      platforms: [...(platformMap.get(name) ?? [])],
    })
    results[name] = {}
    notes[name] = {}
    for (const [id, val] of Object.entries(raw.results ?? {})) {
      results[name][id] = val ? "yes" : "no"
      if (raw.notes?.[id]) notes[name][id] = raw.notes[id]
      if (!featureSet.has(id)) {
        const cat = id.split(".")[0]!
        const meta = featureDescs[id]
        featureSet.set(id, {
          id,
          name: meta?.name || id,
          category: cat,
          spec: meta?.url,
        })
      }
    }
  }

  // Sort by score (highest first)
  allBackends.sort((a, b) => {
    const aYes = Object.values(results[a.name] ?? {}).filter((v) => v === "yes").length
    const bYes = Object.values(results[b.name] ?? {}).filter((v) => v === "yes").length
    return bYes - aYes
  })

  const features = Array.from(featureSet.values()).sort((a, b) => a.id.localeCompare(b.id))
  const categories: Record<string, FeatureResult[]> = {}
  for (const f of features) {
    if (!categories[f.category]) categories[f.category] = []
    categories[f.category]!.push(f)
  }

  const stats: CensusData["stats"] = {}
  for (const b of allBackends) {
    const entries = Object.values(results[b.name]!)
    const total = entries.length
    const yes = entries.filter((v) => v === "yes").length
    const no = entries.filter((v) => v === "no").length
    const partial = entries.filter((v) => v === "partial").length
    const pct = total > 0 ? Math.round((yes / total) * 100) : 0
    stats[b.name] = { total, yes, no, partial, pct }
  }

  // Build meta — app metadata takes priority over headless backend metadata
  const meta: Record<string, BackendMeta> = {}
  for (const b of allBackends) {
    meta[b.name] = buildAppMeta(b.name)
  }

  return {
    backends: allBackends,
    features,
    categories,
    results,
    notes,
    stats,
    meta,
    annotations: loadAnnotations(),
    featureDescriptions: featureDescs,
    baselines: {},
    baselineStats: {},
    generated: new Date().toISOString(),
  }
}

function buildAppMeta(terminalName: string): BackendMeta {
  const labels: Record<string, string> = {
    ghostty: "Ghostty",
    kitty: "Kitty",
    iterm2: "iTerm2",
    "terminal-app": "Terminal.app",
    warp: "Warp",
    cmux: "cmux",
    cursor: "Cursor",
    "com.microsoft.VSCode": "VS Code",
    "com.todesktop.230313mzl4w4u92": "Cursor",
  }
  const slugs: Record<string, string> = {
    ghostty: "ghostty",
    kitty: "kitty",
    iterm2: "iterm2",
    "terminal-app": "terminal-app",
    warp: "warp",
    cmux: "cmux",
    cursor: "cursor",
    "com.microsoft.VSCode": "vscode",
    "com.todesktop.230313mzl4w4u92": "cursor",
  }
  const descriptions: Record<string, string> = {
    ghostty:
      "GPU-accelerated terminal by Mitchell Hashimoto. Written in Zig, Metal/OpenGL/Vulkan. Excellent standards compliance.",
    kitty:
      "GPU-accelerated terminal by Kovid Goyal. Pioneer of the Kitty keyboard and graphics protocols. Written in C/Python.",
    iterm2: "Feature-rich macOS terminal with split panes, profiles, and extensive customization. Native Cocoa app.",
    "terminal-app": "Apple's built-in macOS terminal. Ships with every Mac.",
    warp: "AI-powered terminal with blocks-based UI. Rust-based, GPU-accelerated.",
    cmux: "Terminal multiplexer built on libghostty (Ghostty's terminal emulation library). Inherits Ghostty's VT parser.",
    cursor: "AI code editor with integrated terminal. Based on VS Code, uses xterm.js for terminal emulation.",
    "com.microsoft.VSCode": "Microsoft's code editor with integrated terminal. Uses xterm.js for terminal emulation.",
    "com.todesktop.230313mzl4w4u92": "AI code editor with integrated terminal. Based on VS Code, uses xterm.js.",
  }

  const bodies: Record<string, string> = {
    ghostty: `<p>Ghostty is a terminal emulator created by <strong>Mitchell Hashimoto</strong>, founder of HashiCorp (Terraform, Vagrant, Vault). Written in <strong>Zig</strong> with GPU-accelerated rendering via Metal (macOS), OpenGL, and Vulkan. First released in late 2024 after years of development, Ghostty quickly gained attention for its focus on correctness and performance.</p>
<p>Ghostty's architecture separates the terminal emulation core into <strong>libghostty</strong>, a reusable library that other projects can embed. This is how <strong>cmux</strong> (the Ghostty multiplexer) gets its terminal emulation — it links against libghostty directly. The library handles VT parsing, grid management, and rendering, while the app adds window management and platform integration.</p>
<p>Among modern terminals, Ghostty has some of the best standards compliance, supporting kitty keyboard protocol, kitty graphics, sixel, OSC 8 hyperlinks, semantic prompts, and full Unicode including grapheme clustering. It scores consistently near the top of terminfo.dev's feature matrix.</p>`,

    kitty: `<p><strong>Kitty</strong> was created by <strong>Kovid Goyal</strong> and first released in 2017. Written in C and Python with <strong>OpenGL GPU rendering</strong>, it was one of the first terminals to use the GPU for text rendering, achieving smooth scrolling and low latency that traditional CPU-rendered terminals couldn't match.</p>
<p>Kitty's most lasting contribution to the terminal ecosystem is the <strong>Kitty keyboard protocol</strong> (CSI u), which solves decades-old ambiguity in how terminals encode keypresses. The protocol has since been adopted by Ghostty, WezTerm, foot, and others. Kitty also pioneered the <strong>Kitty graphics protocol</strong> for inline image display and introduced extended underline styles (curly, dotted, dashed) with independent underline colors — features now standard in modern terminals.</p>
<p>Kitty supports a rich extension ecosystem through "kittens" — small Python programs that run inside the terminal. Notable kittens include an image viewer, SSH integration, and a diff viewer. The terminal also features native tab and window management, remote control via IPC, and extensive Unicode support.</p>`,

    iterm2: `<p><strong>iTerm2</strong> is the most popular third-party terminal for macOS, created by <strong>George Nachman</strong>. It's a successor to the original iTerm project, first released in 2010 as a native Cocoa application. iTerm2 has been the de facto "power user" terminal on macOS for over a decade.</p>
<p>iTerm2 pioneered several features that became ecosystem standards: <strong>shell integration</strong> via OSC 133 semantic prompts (marking prompt, command, and output boundaries), the <strong>iTerm2 image protocol</strong> (OSC 1337) for inline image display, and sophisticated profile management. Its split pane system, tmux integration, and Instant Replay (scrubbing through terminal history) remain unmatched in many competitors.</p>
<p>While iTerm2 supports truecolor and most modern escape sequences, it has been slower to adopt some newer protocols like the kitty keyboard protocol. It remains the most feature-complete terminal on macOS for users who don't need GPU acceleration, with features like triggers (automated actions on pattern matches), password manager integration, and extensive mouse reporting.</p>`,

    "terminal-app": `<p><strong>Terminal.app</strong> is Apple's built-in terminal emulator, shipping with every Mac since <strong>Mac OS X 10.0</strong> (2001). It's the terminal most macOS users encounter first, and for many developers it's all they ever need.</p>
<p>Terminal.app is deliberately conservative in its feature set. It was slow to adopt truecolor support and still lacks modern protocols like the kitty keyboard protocol. However, it provides solid basics: UTF-8 support, 256-color mode, mouse tracking, and integration with macOS services like Profiles and the Touch Bar. Its shell integration supports marks and bookmarks for navigating command output.</p>
<p>Despite its limitations, Terminal.app is notable for its reliability and zero-setup experience. It's the baseline that macOS developers test against, and its VT100/VT220 compliance covers the vast majority of real-world terminal usage.</p>`,

    warp: `<p><strong>Warp</strong> is a modern terminal built in <strong>Rust</strong> with GPU acceleration, backed by venture capital funding. It breaks from the traditional terminal paradigm with a <strong>blocks-based UI</strong> where each command and its output form a distinct visual block that can be selected, copied, and shared independently.</p>
<p>Warp's most distinctive feature is its AI integration — it offers command suggestions, natural language to shell translation, and inline documentation. The terminal also features a modern text editor for command input (with selection, multi-cursor, and syntax highlighting) rather than the traditional readline-style input.</p>
<p>Under the hood, Warp uses its own GPU-rendered terminal emulator with good standards compliance. It supports truecolor, mouse tracking, bracketed paste, and most modern escape sequences. The Rust codebase provides native performance while the GPU renderer handles smooth scrolling and high-DPI displays. Available on macOS and Linux.</p>`,

    cmux: `<p><strong>cmux</strong> is a terminal multiplexer built by the <strong>Ghostty project</strong>, serving as a modern alternative to tmux and screen. Unlike traditional multiplexers that implement their own VT parser, cmux is built on <strong>libghostty</strong> — the same terminal emulation library that powers the Ghostty terminal.</p>
<p>This architectural choice means cmux inherits Ghostty's complete VT parser and renderer, including support for the kitty keyboard protocol, graphics protocols, semantic prompts, and full Unicode with grapheme clustering. Where tmux has historically been a compatibility bottleneck (stripping or mishandling modern escape sequences), cmux passes them through with full fidelity.</p>
<p>cmux aims to provide the session persistence and window management of tmux with the standards compliance of a modern terminal emulator. It scores identically to Ghostty on terminfo.dev because it uses the same underlying emulation library.</p>`,

    cursor: `<p><strong>Cursor</strong> is an AI-focused code editor built on top of <strong>VS Code</strong>, with an integrated terminal powered by <strong>xterm.js</strong>. It adds AI pair programming features including chat, command generation, and code completion powered by large language models.</p>
<p>Since Cursor's terminal is xterm.js (the same engine as VS Code), its terminal capabilities are identical — good basic support with truecolor, mouse tracking, and Unicode, but lacking some modern protocols like kitty keyboard and graphics protocols. The terminal is primarily a secondary interface; Cursor's focus is on the editor experience.</p>`,

    "com.microsoft.VSCode": `<p><strong>Visual Studio Code</strong> is Microsoft's open-source code editor, the most widely used IDE in the world. Its integrated terminal is powered by <strong>xterm.js</strong>, the most widely deployed terminal emulator — used not just in VS Code but in countless web-based terminals, cloud IDEs, and development tools.</p>
<p>VS Code pioneered <strong>shell integration</strong> via the OSC 633 protocol, which enables features like command decoration (success/failure markers), command navigation, and sticky scroll for terminal output. This protocol is now being adopted by other terminals.</p>
<p>The xterm.js terminal provides solid basics — truecolor, Unicode, mouse tracking, bracketed paste, and link detection. It lacks some advanced features like kitty keyboard protocol and graphics protocols, but its ubiquity means it's the baseline that most CLI tools target for compatibility.</p>`,

    "com.todesktop.230313mzl4w4u92": `<p><strong>Cursor</strong> is an AI-focused code editor built on <strong>VS Code</strong> with an <strong>xterm.js</strong> terminal. Terminal capabilities match VS Code — good basics, no advanced protocols.</p>`,
  }

  const urls: Record<string, string> = {
    ghostty: "https://ghostty.org",
    kitty: "https://sw.kovidgoyal.net/kitty",
    iterm2: "https://iterm2.com",
    "terminal-app": "https://support.apple.com/guide/terminal/welcome/mac",
    warp: "https://www.warp.dev",
    cmux: "https://github.com/ghostty-org/ghostty",
    cursor: "https://cursor.com",
    "com.microsoft.VSCode": "https://code.visualstudio.com",
    "com.todesktop.230313mzl4w4u92": "https://cursor.com",
  }

  // Look up terminal metadata from the @termless/core manifest
  // Map app terminal names to manifest backend names
  const appToManifest: Record<string, string> = {
    ghostty: "ghostty",
    kitty: "kitty",
    cmux: "ghostty", // cmux uses libghostty
    "com.microsoft.VSCode": "xtermjs",
    "com.todesktop.230313mzl4w4u92": "xtermjs",
    cursor: "xtermjs",
  }
  const manifestName = appToManifest[terminalName]
  let terminalMeta: TerminalMeta | undefined
  if (manifestName) {
    try {
      const m = manifest()
      const entry = m.backends[manifestName]
      if (entry?.terminal) {
        terminalMeta = entry.terminal
      }
    } catch {}
  }

  return {
    label: labels[terminalName] ?? terminalName,
    slug: slugs[terminalName] ?? terminalName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    description: descriptions[terminalName] ?? `${labels[terminalName] ?? terminalName} terminal emulator`,
    body: bodies[terminalName],
    url: urls[terminalName],
    terminal: terminalMeta,
  }
}

function loadUnifiedCensus(path: string): CensusData {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as any

  const backends: BackendInfo[] = (Object.values(raw.backends ?? {}) as BackendInfo[]).map((b) => ({
    ...b,
    type: "headless" as const,
    platforms: ["macos", "linux", "windows"],
  }))
  const backendNames = backends.map((b) => b.name)

  const features: FeatureResult[] = (raw.features ?? []).map((f: any) => ({
    id: f.id,
    name: f.name,
    category: f.category,
    spec: f.spec,
  }))

  // Group by category
  const categories: Record<string, FeatureResult[]> = {}
  for (const f of features) {
    if (!categories[f.category]) categories[f.category] = []
    categories[f.category]!.push(f)
  }

  // Build results and notes maps
  const results: Record<string, Record<string, string>> = {}
  const notes: Record<string, Record<string, string>> = {}
  for (const name of backendNames) {
    results[name] = {}
    notes[name] = {}
  }
  for (const f of raw.features ?? []) {
    for (const [backendName, result] of Object.entries(f.results ?? {})) {
      const r = result as any
      results[backendName] ??= {}
      notes[backendName] ??= {}
      results[backendName]![f.id] = r.support ?? "unknown"
      if (r.notes) notes[backendName]![f.id] = r.notes
    }
  }

  // Load annotations and merge into notes + apply result overrides
  const annotations = loadAnnotations()
  for (const [key, ann] of Object.entries(annotations)) {
    const [backend, ...featureParts] = key.split(":")
    const feature = featureParts.join(":")
    if (!notes[backend!]) notes[backend!] = {}
    // Annotation note replaces the auto-generated note
    notes[backend!]![feature] = ann.note
    // Annotation can override the probe result (e.g., "partial" for headless API gaps)
    if (ann.result && results[backend!]) {
      results[backend!]![feature] = ann.result
    }
  }

  // Compute per-backend stats
  const stats: CensusData["stats"] = {}
  for (const name of backendNames) {
    const entries = Object.values(results[name]!)
    const total = entries.length
    const yes = entries.filter((v) => v === "yes").length
    const no = entries.filter((v) => v === "no").length
    const partial = entries.filter((v) => v === "partial").length
    const pct = total > 0 ? Math.round((yes / total) * 100) : 0
    stats[name] = { total, yes, no, partial, pct }
  }

  return {
    backends,
    features,
    categories,
    results,
    notes,
    stats,
    meta: loadBackendMeta(),
    annotations,
    featureDescriptions: loadFeatureDescriptions(),
    baselines: {},
    baselineStats: {},
    generated: raw.generated ?? "",
  }
}

function loadPerBackendResults(): CensusData {
  let files: string[]
  try {
    files = readdirSync(resultsDir).filter((f) => f.endsWith(".json") && f !== "census.json")
  } catch (err) {
    throw new Error(`Failed to read census results from ${resultsDir}: ${err}`)
  }

  if (files.length === 0) return emptyData()

  // Each file is a per-backend result
  const allBackends: BackendInfo[] = []
  const results: Record<string, Record<string, string>> = {}
  const notes: Record<string, Record<string, string>> = {}
  const featureSet = new Map<string, FeatureResult>()
  const featureDescs = loadFeatureDescriptions()

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(resultsDir, file), "utf-8")) as any
      if (!raw.backend) continue
      allBackends.push({
        name: raw.backend,
        version: raw.version ?? "",
        engine: raw.engine ?? "",
        type: "headless",
        platforms: ["macos", "linux", "windows"],
      })
      results[raw.backend] = {}
      notes[raw.backend] = {}
      const rawNotes = raw.notes ?? {}
      for (const [id, val] of Object.entries(raw.results ?? {})) {
        results[raw.backend]![id] =
          typeof val === "boolean" ? (val ? "yes" : "no") : ((val as any).support ?? "unknown")
        if (rawNotes[id]) notes[raw.backend]![id] = rawNotes[id]
        if (!featureSet.has(id)) {
          const cat = id.split(".")[0]!
          const suffix = id.slice(cat.length + 1)
          const meta = featureDescs[id]
          featureSet.set(id, {
            id,
            name: meta?.name || suffix || id,
            category: cat,
            spec: meta?.url,
          })
        }
      }
    } catch (err) {
      throw new Error(`Failed to parse census result ${file}: ${err}`)
    }
  }

  allBackends.sort((a, b) => a.name.localeCompare(b.name))
  const features = Array.from(featureSet.values()).sort((a, b) => a.id.localeCompare(b.id))

  const categories: Record<string, FeatureResult[]> = {}
  for (const f of features) {
    if (!categories[f.category]) categories[f.category] = []
    categories[f.category]!.push(f)
  }

  const stats: CensusData["stats"] = {}
  for (const b of allBackends) {
    const entries = Object.values(results[b.name]!)
    const total = entries.length
    const yes = entries.filter((v) => v === "yes").length
    const no = entries.filter((v) => v === "no").length
    const partial = entries.filter((v) => v === "partial").length
    const pct = total > 0 ? Math.round((yes / total) * 100) : 0
    stats[b.name] = { total, yes, no, partial, pct }
  }

  const generated = new Date().toISOString()

  const annotations = loadAnnotations()
  for (const [key, ann] of Object.entries(annotations)) {
    const [backend, ...fp] = key.split(":")
    const feature = fp.join(":")
    if (notes[backend!]) notes[backend!]![feature] = ann.note
    if (ann.result && results[backend!]) results[backend!]![feature] = ann.result
  }

  // Recompute stats after overrides
  for (const b of allBackends) {
    const entries = Object.values(results[b.name]!)
    const total = entries.length
    const yes = entries.filter((v) => v === "yes").length
    const no = entries.filter((v) => v === "no").length
    const partial = entries.filter((v) => v === "partial").length
    const pct = total > 0 ? Math.round((yes / total) * 100) : 0
    stats[b.name] = { total, yes, no, partial, pct }
  }

  return {
    backends: allBackends,
    features,
    categories,
    results,
    notes,
    stats,
    meta: loadBackendMeta(),
    annotations,
    featureDescriptions: loadFeatureDescriptions(),
    baselines: {},
    baselineStats: {},
    generated,
  }
}

function emptyData(): CensusData {
  return {
    backends: [],
    features: [],
    categories: {},
    results: {},
    notes: {},
    stats: {},
    meta: {},
    annotations: {},
    featureDescriptions: loadFeatureDescriptions(),
    baselines: {},
    baselineStats: {},
    generated: "",
  }
}

function computeBaselines(data: CensusData): void {
  const baselineOrder = ["core", "modern", "rich", "unicode"]
  const baselines: Record<string, string[]> = {}
  for (const bl of baselineOrder) baselines[bl] = []

  // Group features by baseline
  for (const [id, meta] of Object.entries(data.featureDescriptions)) {
    if (meta.baseline && baselines[meta.baseline]) {
      baselines[meta.baseline]!.push(id)
    }
  }

  // Compute per-backend baseline stats
  const baselineStats: Record<string, Record<string, { total: number; yes: number; pct: number }>> = {}
  for (const backend of data.backends) {
    baselineStats[backend.name] = {}
    const br = data.results[backend.name] ?? {}
    for (const bl of baselineOrder) {
      const ids = baselines[bl] ?? []
      const total = ids.length
      const yes = ids.filter((id) => br[id] === "yes" || br[id] === "partial").length
      baselineStats[backend.name]![bl] = { total, yes, pct: total > 0 ? Math.round((yes / total) * 100) : 0 }
    }
  }

  data.baselines = baselines
  data.baselineStats = baselineStats
}
