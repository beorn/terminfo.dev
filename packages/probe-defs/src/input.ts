import type { ProbeDefinition } from "./types.ts"
import { probe, notTestedResult } from "./helpers.ts"
import { kittyKeyboardFlagProbe } from "./extensions.ts"

/**
 * Mouse/wheel effect cannot be delivered in this run, so the row is recorded Not tested by this
 * run (cto ruling 19685f18) with its named missing capability, never inconclusive. A current parser
 * mode is diagnostic context only.
 */
function mouseInputProbe(id: string, modeName: string): ProbeDefinition {
  const noObservable = "No mouse or wheel-injection capability in this run"
  return probe(
    id,
    (ctx) => notTestedResult(noObservable, { currentMode: ctx.getMode(modeName) === true }),
    () => Promise.resolve(notTestedResult(noObservable, {})),
  )
}

export const inputProbes: ProbeDefinition[] = [
  probe(
    "input.modify-other-keys",
    (ctx) =>
      notTestedResult("No key-injection capability in this run", {
        declaredModifyOtherKeys: ctx.capabilities.extensions.has("modifyOtherKeys"),
      }),
    () => Promise.resolve(notTestedResult("No key-injection capability in this run", {})),
  ),

  // Negotiation only; actual key encoding requires an input-event observation.
  kittyKeyboardFlagProbe("input.csi-u", 1, 1),

  mouseInputProbe("input.pixel-mouse", "pixelMouse"),
  mouseInputProbe("input.urxvt-mouse", "mouseTracking"),
  mouseInputProbe("input.x10-mouse", "mouseTracking"),

  // Mode 3 cannot be distinguished from mode 2 by this declared capability.
  probe(
    "input.modify-other-keys-3",
    (ctx) =>
      notTestedResult("No key-injection capability in this run", {
        declaredModifyOtherKeys: ctx.capabilities.extensions.has("modifyOtherKeys"),
      }),
    () => Promise.resolve(notTestedResult("No key-injection capability in this run", {})),
  ),

  mouseInputProbe("input.button-event-mouse", "mouseTracking"),
]
