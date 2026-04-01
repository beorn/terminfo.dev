/**
 * TestResults — scorecard after running probes.
 *
 * Shows category breakdown with pass/fail, summary score,
 * and hyperlinks to feature pages on terminfo.dev.
 */
import React from "react"
import { Box, Text, H2, Muted } from "silvery"
import { hyperlink } from "@silvery/ansi"
import type { ProbeResults } from "../types.ts"

interface TestResultsProps {
  data: ProbeResults
  slugs: Record<string, string>
}

export function TestResults({ data, slugs }: TestResultsProps) {
  const { passed, total, terminal } = data
  const pct = Math.round((passed / total) * 100)
  const version = terminal.version ? ` ${terminal.version}` : ""
  const categoryCount = new Set(Object.keys(data.results).map((id) => id.split(".")[0])).size

  // Group probes by category
  const categories = new Map<string, Array<{ id: string; name: string; pass: boolean; note?: string }>>()
  for (const probe of data.probes) {
    const cat = probe.id.split(".")[0]!
    if (!categories.has(cat)) categories.set(cat, [])
    categories.get(cat)!.push({
      id: probe.id,
      name: probe.name,
      pass: data.results[probe.id] ?? false,
      note: data.notes[probe.id],
    })
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" marginBottom={1}>
        <H2>{hyperlink("terminfo.dev", "https://terminfo.dev")} — can your terminal do that?</H2>
      </Box>

      <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
        <Text>
          Terminal:{" "}
          <Text bold>
            {terminal.name}
            {version}
          </Text>
        </Text>
        <Text>
          Platform: {terminal.os} {terminal.osVersion}
        </Text>
        <Text>
          Features: {total} across {categoryCount} categories
        </Text>
        <Text>Website: {hyperlink("https://terminfo.dev", "https://terminfo.dev")}</Text>
        <Text>
          Score:{" "}
          <Text bold>
            {passed}/{total} ({pct}%)
          </Text>
        </Text>
      </Box>

      {/* Category breakdown */}
      {[...categories.entries()].map(([cat, probes]) => {
        const catPassed = probes.filter((p) => p.pass).length
        const catColor = catPassed === probes.length ? "$success" : catPassed > 0 ? "$warning" : "$error"

        return (
          <Box key={cat} flexDirection="column">
            <Text color={catColor} bold>
              {cat}{" "}
              <Text color={catColor}>
                {catPassed}/{probes.length}
              </Text>
            </Text>
            {probes.map((p) => {
              const slug = slugs[p.id]
              const fCat = p.id.split(".")[0]
              const featureLink = hyperlink(p.name, `https://terminfo.dev/${fCat}/${slug}`)
              const note = p.note && !p.pass ? <Muted> ({p.note})</Muted> : null

              return (
                <Text key={p.id}>
                  {"  "}
                  <Text color={p.pass ? "$success" : "$error"}>{p.pass ? "✓" : "✗"}</Text> {featureLink}
                  {note}
                </Text>
              )
            })}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * PostTestStatus — shown after results, indicating terminal status on terminfo.dev.
 */
export function PostTestStatus({
  status,
  terminalLabel,
}: {
  status: "new" | "changed" | "unchanged"
  terminalLabel: string
}) {
  if (status === "unchanged") {
    return (
      <Box paddingLeft={2} marginTop={1}>
        <Muted>{terminalLabel} is already on terminfo.dev with identical results.</Muted>
      </Box>
    )
  }

  if (status === "new") {
    return (
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        <Text>
          <Text color="$warning" bold>
            ★ New terminal!
          </Text>{" "}
          <Text bold>{terminalLabel}</Text> isn't on terminfo.dev yet.
        </Text>
        <Muted>Help other developers by sharing your results:</Muted>
      </Box>
    )
  }

  // changed
  return (
    <Box marginTop={1} paddingLeft={2}>
      <Text color="$warning">
        Results differ from what's on terminfo.dev — your update would help keep data accurate.
      </Text>
    </Box>
  )
}

/**
 * SubmitNudge — non-interactive nudge for non-TTY environments.
 */
export function SubmitNudge({ isNew, terminalLabel }: { isNew: boolean; terminalLabel: string }) {
  if (isNew) {
    return (
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        <Text>
          <Text color="$warning" bold>
            ★ New terminal!
          </Text>{" "}
          <Text bold>{terminalLabel}</Text> isn't on terminfo.dev yet.
        </Text>
        <Text>
          Submit your results: <Text bold>npx terminfo.dev submit</Text>
        </Text>
      </Box>
    )
  }

  return (
    <Box marginTop={1} paddingLeft={2}>
      <Muted>Submit updated results: </Muted>
      <Text bold>npx terminfo.dev submit</Text>
    </Box>
  )
}

/**
 * SubmitResult — shown after a successful submission.
 */
export function SubmitResult({ url, hasVersion }: { url: string; hasVersion: boolean }) {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color="$success">+</Text> Issue created: {hyperlink(url, url)}
      </Text>
      {!hasVersion && (
        <Text>
          <Text color="$warning">⚠</Text> Please click the link above and add your terminal version to the issue.
        </Text>
      )}
    </Box>
  )
}
