export type { ProbeDefinition, ProbeResult, TermlessContext, TermContext } from "./types.ts"
export {
  sgrProbe,
  cursorProbe,
  modeProbe,
  behavioralModeProbe,
  responseProbe,
  capabilityProbe,
  widthProbe,
  isBlank,
  probe,
} from "./helpers.ts"

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
  // Extensions first — OSC 52 clipboard probes may trigger permission dialogs
  // (e.g. Kitty). Running them early gives the user time to click "Accept"
  // while the remaining probes execute.
  ...extensionsProbes,
  ...sgrProbes,
  ...cursorProbes,
  ...textProbes,
  ...eraseProbes,
  ...editingProbes,
  ...modesProbes,
  ...deviceProbes,
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
