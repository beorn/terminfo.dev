/**
 * Submit results to terminfo.dev via GitHub issue.
 */

import { createStyle } from "@silvery/ansi"
import { writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

const s = createStyle()

const REPO = "beorn/terminfo.dev"

interface SubmitData {
  terminal: string
  terminalVersion: string
  os: string
  osVersion: string
  results: Record<string, boolean>
  notes: Record<string, string>
  responses: Record<string, string>
  generated: string
  cliVersion?: string
  probeCount?: number
}

export async function submitResults(data: SubmitData): Promise<string | null> {
  const passed = Object.values(data.results).filter(Boolean).length
  const total = Object.keys(data.results).length
  const pct = Math.round((passed / total) * 100)
  const ver = data.terminalVersion ? ` ${data.terminalVersion}` : ""

  console.log(`\n  Submitting: ${s.bold(`${data.terminal}${ver}`)} on ${data.os} — ${pct}% (${passed}/${total})`)

  if (!data.terminalVersion) {
    console.log(`  ${s.yellow("⚠ No version detected — use --terminal-version to specify")}`)
  }

  // Check for duplicates
  if (hasGhCli()) {
    const existing = checkDuplicate(data.terminal, data.terminalVersion, data.os)
    if (existing) {
      console.log(`  ${s.yellow(`⚠ Similar submission exists: ${existing}`)}`)
      console.log(`  Submitting anyway (different probe version may have new results)`)
    }
  }

  const title = `[probe] ${data.terminal}${ver} on ${data.os} — ${pct}% (${passed}/${total})`

  const body = `## Community Census Result

| Field | Value |
|-------|-------|
| Terminal | ${data.terminal} |
| Version | ${data.terminalVersion || "unknown"} |
| OS | ${data.os} ${data.osVersion || ""} |
| Score | ${passed}/${total} (${pct}%) |
| CLI Version | ${data.cliVersion ?? "unknown"} |
| Probes | ${data.probeCount ?? total} |
| Generated | ${data.generated} |

### Summary

${formatSummary(data)}

<details>
<summary>Full JSON</summary>

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

</details>

---
*Submitted via \`npx terminfo.dev submit\`*`

  if (!hasGhCli()) {
    // No gh CLI — open browser with pre-filled issue
    const issueUrl = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=probe-results`

    console.log(`\n  ${s.yellow("gh CLI not found — opening browser instead")}`)

    try {
      const { execFileSync: exec } = await import("node:child_process")
      const { platform } = await import("node:os")
      const os = platform()
      if (os === "darwin") exec("open", [issueUrl])
      else if (os === "win32") exec("cmd", ["/c", "start", issueUrl])
      else exec("xdg-open", [issueUrl])
      console.log(`  Browser opened — review and click "Submit new issue"`)
      return null
    } catch {
      // Browser open failed — save file as last resort
      const filename = `terminfo-${data.terminal}-${data.os}-${Date.now()}.json`
      writeFileSync(filename, JSON.stringify(data, null, 2))
      console.log(`  ${s.yellow(`Couldn't open browser. Results saved to ${filename}`)}`)
      console.log(`  To submit manually: https://github.com/${REPO}/issues/new`)
      console.log(`  Paste the contents of ${filename} in the issue body.`)
      return null
    }
  }

  const bodyFile = join(tmpdir(), `terminfo-submit-${Date.now()}.md`)
  try {
    writeFileSync(bodyFile, body)
    const result = execFileSync("gh", ["issue", "create", "--repo", REPO, "--title", title, "--body-file", bodyFile], {
      encoding: "utf-8",
      timeout: 30000,
    })
    return result.trim()
  } catch (err) {
    console.error(`  ${s.red("Failed to create issue")}`)
    console.error(`  ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    try {
      unlinkSync(bodyFile)
    } catch {}
  }
}

function hasGhCli(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore", timeout: 5000 })
    return true
  } catch {
    return false
  }
}

function checkDuplicate(terminal: string, version: string, os: string): string | null {
  try {
    const search = `[probe] ${terminal}${version ? ` ${version}` : ""} on ${os}`
    const result = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        REPO,
        "--search",
        search,
        "--state",
        "all",
        "--limit",
        "1",
        "--json",
        "url,title",
        "--jq",
        '.[0] | .title + " " + .url',
      ],
      { encoding: "utf-8", timeout: 10000 },
    )
    return result.trim() || null
  } catch {
    return null
  }
}

function formatSummary(data: SubmitData): string {
  const categories = new Map<string, { pass: number; fail: number; failList: string[] }>()
  for (const [id, pass] of Object.entries(data.results)) {
    const cat = id.split(".")[0]!
    if (!categories.has(cat)) categories.set(cat, { pass: 0, fail: 0, failList: [] })
    const entry = categories.get(cat)!
    if (pass) entry.pass++
    else {
      entry.fail++
      const note = data.notes[id]
      entry.failList.push(note ? `- \`${id}\`: ${note}` : `- \`${id}\``)
    }
  }
  const lines: string[] = []
  for (const [cat, { pass, fail, failList }] of categories) {
    const icon = fail === 0 ? "✅" : "⚠️"
    lines.push(`${icon} **${cat}**: ${pass}/${pass + fail}`)
    if (failList.length > 0) lines.push(...failList)
  }
  return lines.join("\n")
}
