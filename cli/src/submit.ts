/**
 * Submit results to terminfo.dev via GitHub issue.
 *
 * Creates an issue on beorn/terminfo.dev with the JSON results
 * attached as a code block. Maintainers review and merge into
 * the results database.
 */

const REPO = "beorn/terminfo.dev"
const ISSUE_LABEL = "community-results"

interface SubmitResult {
  terminal: string
  terminalVersion: string
  os: string
  osVersion: string
  results: Record<string, boolean>
  notes: Record<string, string>
  responses: Record<string, string>
  generated: string
}

/**
 * Submit results by creating a GitHub issue.
 * Requires `gh` CLI to be installed and authenticated.
 */
export async function submitResults(data: SubmitResult): Promise<string | null> {
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

### Results

<details>
<summary>Full JSON (click to expand)</summary>

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

</details>

### Summary

${formatSummary(data)}

---
*Submitted via \`npx terminfo\`*`

  // Try gh CLI first
  if (await hasGhCli()) {
    try {
      const { execSync } = await import("node:child_process")
      const result = execSync(
        `gh issue create --repo ${REPO} --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --label ${ISSUE_LABEL}`,
        { encoding: "utf-8", timeout: 30000 },
      )
      const url = result.trim()
      return url
    } catch (err) {
      console.error(`\x1b[31mFailed to create issue via gh CLI\x1b[0m`)
      console.error(err instanceof Error ? err.message : String(err))
      return null
    }
  }

  // Fallback: write to file and give instructions
  const { writeFileSync } = await import("node:fs")
  const filename = `terminfo-${data.terminal}-${data.os}-${Date.now()}.json`
  writeFileSync(filename, JSON.stringify(data, null, 2))
  console.log(`\n\x1b[33mgh CLI not found. Results saved to ${filename}\x1b[0m`)
  console.log(`To submit manually:`)
  console.log(`  1. Go to https://github.com/${REPO}/issues/new`)
  console.log(`  2. Title: ${title}`)
  console.log(`  3. Paste the contents of ${filename}`)
  return null
}

async function hasGhCli(): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process")
    execSync("gh --version", { stdio: "ignore", timeout: 5000 })
    return true
  } catch {
    return false
  }
}

function formatSummary(data: SubmitResult): string {
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
    const total = pass + fail
    const icon = fail === 0 ? "✅" : "⚠️"
    lines.push(`${icon} **${cat}**: ${pass}/${total}`)
    if (failList.length > 0) lines.push(...failList)
  }

  return lines.join("\n")
}
