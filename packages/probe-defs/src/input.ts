import type { ProbeDefinition, ProbeResult } from "./types.ts"
import { probe } from "./helpers.ts"
import { kittyKeyboardFlagProbe } from "./extensions.ts"

const absentEventNote = "No generated input event and encoded report were validated"

/** A current parser mode is diagnostic context, not a mouse-event observation. */
function mouseInputProbe(id: string, modeName: string): ProbeDefinition {
  return probe(
    id,
    (ctx) => ({
      pass: false,
      response: JSON.stringify({ currentMode: ctx.getMode(modeName) === true }),
      note: absentEventNote,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "legacy",
        note: absentEventNote,
      },
    }),
    () =>
      Promise.resolve<ProbeResult>({
        pass: false,
        note: absentEventNote,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: absentEventNote,
        },
      }),
  )
}

export const inputProbes: ProbeDefinition[] = [
  probe(
    "input.modify-other-keys",
    (ctx) => ({
      pass: false,
      response: JSON.stringify({ declaredModifyOtherKeys: ctx.capabilities.extensions.has("modifyOtherKeys") }),
      note: absentEventNote,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "legacy",
        note: absentEventNote,
      },
    }),
    () =>
      Promise.resolve<ProbeResult>({
        pass: false,
        note: absentEventNote,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: absentEventNote,
        },
      }),
  ),

  // Negotiation only; actual key encoding requires an input-event observation.
  kittyKeyboardFlagProbe("input.csi-u", 1, 1),

  mouseInputProbe("input.pixel-mouse", "pixelMouse"),
  mouseInputProbe("input.urxvt-mouse", "mouseTracking"),
  mouseInputProbe("input.x10-mouse", "mouseTracking"),

  // Mode 3 cannot be distinguished from mode 2 by this declared capability.
  probe(
    "input.modify-other-keys-3",
    (ctx) => ({
      pass: false,
      response: JSON.stringify({ declaredModifyOtherKeys: ctx.capabilities.extensions.has("modifyOtherKeys") }),
      note: absentEventNote,
      observation: {
        outcome: "inconclusive",
        reason: "insufficient-evidence",
        evidence: "legacy",
        note: absentEventNote,
      },
    }),
    () =>
      Promise.resolve<ProbeResult>({
        pass: false,
        note: absentEventNote,
        observation: {
          outcome: "inconclusive",
          reason: "insufficient-evidence",
          evidence: "none",
          note: absentEventNote,
        },
      }),
  ),

  mouseInputProbe("input.button-event-mouse", "mouseTracking"),
]
