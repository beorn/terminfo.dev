/**
 * DetectView — `npx terminfo.dev detect` output.
 *
 * Shows detected terminal name, version, and OS.
 */
import React from "react"
import { Box, Text, H2 } from "silvery"

interface DetectViewProps {
  terminal: { name: string; version: string; os: string; osVersion: string }
}

export function DetectView({ terminal }: DetectViewProps) {
  const version = terminal.version ? ` ${terminal.version}` : ""
  return (
    <Box flexDirection="column" gap={1}>
      <H2>terminfo detect</H2>
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          Terminal:{" "}
          <Text bold>
            {terminal.name}
            {version}
          </Text>
        </Text>
        <Text>
          OS: {terminal.os} {terminal.osVersion}
        </Text>
      </Box>
    </Box>
  )
}
