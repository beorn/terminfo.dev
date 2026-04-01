/**
 * HelpView — default `npx terminfo.dev` output.
 *
 * Shows terminal info, feature count, and available commands.
 */
import React from "react"
import { Box, Text, H2, Muted } from "silvery"
import { hyperlink } from "@silvery/ansi"

interface HelpViewProps {
  terminal: { name: string; version: string; os: string; osVersion: string }
  featureCount: number
  categoryCount: number
}

export function HelpView({ terminal, featureCount, categoryCount }: HelpViewProps) {
  const siteLink = hyperlink("terminfo.dev", "https://terminfo.dev")
  const siteUrl = hyperlink("https://terminfo.dev", "https://terminfo.dev")
  const version = terminal.version ? ` ${terminal.version}` : ""

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <H2>{siteLink} — can your terminal do that?</H2>
      </Box>

      <Box flexDirection="column" paddingLeft={2}>
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
          Features: {featureCount} across {categoryCount} categories
        </Text>
        <Text>Website: {siteUrl}</Text>
      </Box>

      <Box flexDirection="column" paddingLeft={2}>
        <Muted>Test your terminal against {featureCount} features from the ECMA-48,</Muted>
        <Muted>VT100/VT510, xterm, and Kitty specifications. Results can be</Muted>
        <Muted>submitted to the community database at terminfo.dev.</Muted>
      </Box>

      <Box flexDirection="column">
        <Text>Commands:</Text>
        <Box flexDirection="column" paddingLeft={2}>
          <Text>
            <Text bold>test</Text> Test this terminal's feature support
          </Text>
          <Text>
            <Text bold>test --json</Text> Machine-readable output
          </Text>
          <Text>
            <Text bold>test --serve</Text> Start daemon for remote testing
          </Text>
          <Text>
            <Text bold>test --all</Text> Test all running daemons
          </Text>
          <Text>
            <Text bold>submit</Text> Test + submit results to terminfo.dev
          </Text>
          <Text>
            <Text bold>detect</Text> Detect current terminal
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        <Text>Options:</Text>
        <Box flexDirection="column" paddingLeft={2}>
          <Text>
            <Text bold>--help</Text> Show this help
          </Text>
          <Text>
            <Text bold>--version</Text> Show version
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
