/**
 * Silvery-rendered CLI report for terminfo probe results.
 */
import React from "react"
import { Box, Text } from "silvery"
import { renderString } from "silvery"

interface ProbeResult {
  id: string
  name: string
  pass: boolean
  note?: string
}

interface ReportProps {
  terminal: string
  terminalVersion: string
  os: string
  osVersion: string
  probeCount: number
  categoryCount: number
  passed: number
  total: number
  categories: Map<string, ProbeResult[]>
}

/** OSC 8 hyperlink wrapper */
function osc8(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}

function featureUrl(id: string, slug: string): string {
  const cat = id.split(".")[0]!
  return `https://terminfo.dev/${cat}/${slug}`
}

function Header({ terminal, terminalVersion, os, osVersion, probeCount, categoryCount, passed, total }: ReportProps) {
  const pct = Math.round((passed / total) * 100)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{osc8("https://terminfo.dev", "terminfo.dev")}</Text>
      <Text dimColor>Can your terminal do that?</Text>
      <Text> </Text>
      <Box flexDirection="row" gap={2}>
        <Box flexDirection="column" width={12}>
          <Text dimColor>Terminal</Text>
          <Text dimColor>Platform</Text>
          <Text dimColor>Probes</Text>
          <Text dimColor>Score</Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>
            {terminal}
            {terminalVersion ? ` ${terminalVersion}` : ""}
          </Text>
          <Text>
            {os} {osVersion}
          </Text>
          <Text>
            {probeCount} features, {categoryCount} categories
          </Text>
          <Text bold color={pct === 100 ? "green" : pct >= 90 ? "yellow" : "red"}>
            {passed}/{total} ({pct}%)
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

function CategorySection({
  name,
  probes,
  slugs,
}: {
  name: string
  probes: ProbeResult[]
  slugs: Record<string, string>
}) {
  const catPassed = probes.filter((p) => p.pass).length
  const allPassed = catPassed === probes.length
  const catUrl = `https://terminfo.dev/${name}`

  return (
    <Box flexDirection="column">
      <Text color={allPassed ? "green" : catPassed > 0 ? "yellow" : "red"}>
        {osc8(catUrl, name)} ({catPassed}/{probes.length})
      </Text>
      {probes.map((p) => {
        const slug = slugs[p.id] ?? p.id.replaceAll(".", "-")
        const url = featureUrl(p.id, slug)
        const icon = p.pass ? "✓" : "✗"
        return (
          <Box key={p.id} flexDirection="row" paddingLeft={2}>
            <Text color={p.pass ? "green" : "red"}>{icon} </Text>
            <Text>{osc8(url, p.name)}</Text>
            {p.note && <Text dimColor> — {p.note}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

function Footer({ submitMode }: { submitMode: boolean }) {
  if (submitMode) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>Submit: npx terminfo.dev --submit</Text>
      <Text dimColor>JSON: npx terminfo.dev --json</Text>
    </Box>
  )
}

function Report(props: ReportProps & { slugs: Record<string, string>; submitMode: boolean }) {
  return (
    <Box flexDirection="column">
      <Header {...props} />
      {[...props.categories.entries()].map(([name, probes]) => (
        <CategorySection key={name} name={name} probes={probes} slugs={props.slugs} />
      ))}
      <Footer submitMode={props.submitMode} />
    </Box>
  )
}

export async function renderReport(
  props: ReportProps & { slugs: Record<string, string>; submitMode: boolean },
): Promise<string> {
  const width = process.stdout.columns ?? 80
  return renderString(<Report {...props} />, { width })
}
