/**
 * Inline probe mechanism — probe this terminal directly via PTY I/O.
 *
 * Sends escape sequences to stdout, reads responses from stdin.
 * Delegates to packages/terminfo.dev/src/probes/ for the actual probe implementations.
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Load feature slugs from features.json for OSC 8 hyperlinks */
function loadFeatureSlugs(): Record<string, string> {
  const ROOT = join(__dirname, "..", "..", "..")
  const candidates = [join(ROOT, "content", "features.json")]
  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>
      delete raw.$comment
      const slugs: Record<string, string> = {}
      for (const [id, entry] of Object.entries(raw)) {
        slugs[id] = entry.slug ?? id.replaceAll(".", "-")
      }
      return slugs
    } catch {}
  }
  return {}
}

/** OSC 8 hyperlink */
function link(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}

export async function handleHere(opts: { json?: boolean }): Promise<void> {
  // Dynamic imports — these modules need real TTY access
  const { detectTerminal } = await import("terminfo.dev/src/detect.ts")
  const { ALL_PROBES } = await import("terminfo.dev/src/probes/unified.ts")
  const { withRawMode, drainStdin } = await import("terminfo.dev/src/tty.ts")

  const terminal = detectTerminal()
  const results: Record<string, boolean> = {}
  const notes: Record<string, string> = {}
  const responses: Record<string, string> = {}
  let passed = 0

  // Save cursor + scroll position, run probes, restore
  process.stdout.write("\x1b7") // save cursor (DECSC)

  await withRawMode(async () => {
    for (const probe of ALL_PROBES) {
      try {
        const result = await probe.run()
        results[probe.id] = result.pass
        if (result.note) notes[probe.id] = result.note
        if (result.response) responses[probe.id] = result.response
        if (result.pass) passed++
      } catch (err) {
        results[probe.id] = false
        notes[probe.id] = `error: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    await drainStdin(1000)
  })

  // Restore terminal state completely
  process.stdout.write("\x1b8") // restore cursor (DECRC)
  process.stdout.write("\x1bc") // RIS — full terminal reset

  const total = ALL_PROBES.length

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          terminal: terminal.name,
          terminalVersion: terminal.version,
          os: terminal.os,
          osVersion: terminal.osVersion,
          source: "community",
          generated: new Date().toISOString(),
          results,
          notes,
          responses,
        },
        null,
        2,
      ),
    )
    return
  }

  // Pretty print results
  const pct = Math.round((passed / total) * 100)
  const slugs = loadFeatureSlugs()

  const siteLink = link("https://terminfo.dev", "terminfo.dev")
  console.log(`${siteLink} — can your terminal do that?\n`)
  console.log(`  Terminal:  ${terminal.name}${terminal.version ? ` ${terminal.version}` : ""}`)
  console.log(`  Platform:  ${terminal.os} ${terminal.osVersion}`)
  console.log(
    `  Probes:    ${total} features across ${new Set(ALL_PROBES.map((p) => p.id.split(".")[0])).size} categories`,
  )
  console.log(`  Score:     ${passed}/${total} (${pct}%)\n`)

  const categories = new Map<string, Array<{ id: string; name: string; pass: boolean; note?: string }>>()
  for (const probe of ALL_PROBES) {
    const cat = probe.id.split(".")[0]!
    if (!categories.has(cat)) categories.set(cat, [])
    categories.get(cat)!.push({
      id: probe.id,
      name: probe.name,
      pass: results[probe.id] ?? false,
      note: notes[probe.id],
    })
  }

  for (const [cat, probes] of categories) {
    const catPassed = probes.filter((p) => p.pass).length
    const catLink = link(`https://terminfo.dev/${cat}`, cat)
    console.log(`${catLink} (${catPassed}/${probes.length})`)
    for (const p of probes) {
      const icon = p.pass ? "+" : "-"
      const note = p.note ? ` (${p.note})` : ""
      const slug = slugs[p.id] ?? p.id.replaceAll(".", "-")
      const fCat = p.id.split(".")[0]!
      const featureLink = link(`https://terminfo.dev/${fCat}/${slug}`, p.name)
      console.log(`  ${icon} ${featureLink}${note}`)
    }
  }

  console.log("\nSubmit results: terminfo submit")
}
