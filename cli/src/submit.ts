/**
 * Submit results to terminfo.dev via GitHub issue.
 */

import { writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

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
}

export async function submitResults(data: SubmitData): Promise<string | null> {
  const passed = Object.values(data.results).filter(Boolean).length
  const total = Object.keys(data.results).length
  const pct = Math.round((passed / total) * 100)

  const title = `[census] ${data.terminal}${data.terminalVersion ? ` ${data.terminalVersion}` : ""} on ${data.os} — ${pct}% (${passed}/${total})`

  const body = `## Community Census Result

| Field | Value |
|-------|-------|
| Terminal | ${data.terminal} |
| Version | ${data.terminalVersion || "unknown"} |
| OS | ${data.os} ${data.osVersion || ""} |
| Score | ${passed}/${total} (${pct}%) |
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
*Submitted via \`npx terminfo.dev\`*`

  if (!hasGhCli()) {
    const filename = `terminfo-${data.terminal}-${data.os}-${Date.now()}.json`
    writeFileSync(filename, JSON.stringify(data, null, 2))
    console.log(`\n\x1b[33mgh CLI not found. Results saved to ${filename}\x1b[0m`)
    console.log(`To submit: https://github.com/${REPO}/issues/new`)
    return null
  }

  // Write body to temp file to avoid shell escaping issues
  const bodyFile = join(tmpdir(), `terminfo-submit-${Date.now()}.md`)
  try {
    writeFileSync(bodyFile, body)
    const result = execFileSync("gh", [
      "issue", "create",
      "--repo", REPO,
      "--title", title,
      "--body-file", bodyFile,
    ], { encoding: "utf-8", timeout: 30000 })
    return result.trim()
  } catch (err) {
    console.error(`\x1b[31mFailed to create issue\x1b[0m`)
    console.error(err instanceof Error ? err.message : String(err))
    return null
  } finally {
    try { unlinkSync(bodyFile) } catch {}
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
