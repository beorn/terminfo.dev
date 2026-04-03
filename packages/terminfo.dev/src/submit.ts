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
  cliVersion?: string
  probeCount?: number
}

export async function submitResults(data: SubmitData): Promise<string | null> {
  const passed = Object.values(data.results).filter(Boolean).length
  const total = Object.keys(data.results).length
  const pct = Math.round((passed / total) * 100)
  const ver = data.terminalVersion ? ` ${data.terminalVersion}` : ""

  const title = `[probe] ${data.terminal}${ver} on ${data.os} — ${pct}% (${passed}/${total})`
  const body = formatIssueBody(data, passed, total, pct)

  if (!hasGhCli()) {
    return submitViaBrowser(title, body, data)
  }

  const bodyFile = join(tmpdir(), `terminfo-submit-${Date.now()}.md`)
  try {
    writeFileSync(bodyFile, body)
    const url = execFileSync("gh", ["issue", "create", "--repo", REPO, "--title", title, "--body-file", bodyFile], {
      encoding: "utf-8",
      timeout: 30000,
    }).trim()
    return url
  } catch (err) {
    console.error(`  Failed to create issue: ${err instanceof Error ? err.message : String(err)}`)
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

async function submitViaBrowser(title: string, body: string, data: SubmitData): Promise<string | null> {
  const issueUrl = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=probe-results`
  console.log("  Opening browser...")
  try {
    const { platform } = await import("node:os")
    const os = platform()
    if (os === "darwin") execFileSync("open", [issueUrl])
    else if (os === "win32") execFileSync("cmd", ["/c", "start", issueUrl])
    else execFileSync("xdg-open", [issueUrl])
    console.log(`  Review and click "Submit new issue".`)
    return null
  } catch {
    const filename = `terminfo-${data.terminal}-${data.os}-${Date.now()}.json`
    writeFileSync(filename, JSON.stringify(data, null, 2))
    console.log(`  Couldn't open browser. Results saved to ${filename}`)
    return null
  }
}

function formatIssueBody(data: SubmitData, passed: number, total: number, pct: number): string {
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

  return `## Community Census Result

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

${lines.join("\n")}

<details>
<summary>Full JSON</summary>

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

</details>

---
*Submitted via \`npx terminfo.dev submit\`*`
}
