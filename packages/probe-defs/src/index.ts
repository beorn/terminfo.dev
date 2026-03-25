export type { ProbeDefinition, ProbeResult, TermlessContext, TermContext } from "./types.ts"
export { sgrProbe, cursorProbe, modeProbe, behavioralModeProbe, responseProbe, capabilityProbe, widthProbe, probe } from "./helpers.ts"

import { sgrProbes } from "./sgr.ts"
import { cursorProbes } from "./cursor.ts"
import { textProbes } from "./text.ts"
import { eraseProbes } from "./erase.ts"
import { editingProbes } from "./editing.ts"
import { modesProbes } from "./modes.ts"
import { deviceProbes } from "./device.ts"
import { extensionsProbes } from "./extensions.ts"
import { inputProbes } from "./input.ts"
import { resetProbes } from "./reset.ts"
import { scrollbackProbes } from "./scrollback.ts"
import { charsetsProbes } from "./charsets.ts"
import { unicodeProbes } from "./unicode.ts"

export const ALL_PROBES = [
  ...sgrProbes,
  ...cursorProbes,
  ...textProbes,
  ...eraseProbes,
  ...editingProbes,
  ...modesProbes,
  ...deviceProbes,
  ...extensionsProbes,
  ...inputProbes,
  ...resetProbes,
  ...scrollbackProbes,
  ...charsetsProbes,
  ...unicodeProbes,
]

export {
  sgrProbes,
  cursorProbes,
  textProbes,
  eraseProbes,
  editingProbes,
  modesProbes,
  deviceProbes,
  extensionsProbes,
  inputProbes,
  resetProbes,
  scrollbackProbes,
  charsetsProbes,
  unicodeProbes,
}
