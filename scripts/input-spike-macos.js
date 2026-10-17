// Spike only (29814): post one CGEvent key into the frontmost application and report the facts that
// separate "a grant is missing" from "the event went somewhere else". No permission is actuated.
ObjC.import("ApplicationServices")
ObjC.import("CoreGraphics")
ObjC.import("AppKit")

// osascript -l JavaScript is JXA, not Node: arguments arrive in run(argv), and there is no
// `process`. Returning the JSON string is what osascript prints.
function run(argv) {
  const trusted = $.AXIsProcessTrusted()
  const frontmost = $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier
  const front = frontmost ? String(ObjC.unwrap(frontmost)) : "unknown"
  // Each attempt posts through a different tap so a tap that filters synthetic input is named:
  // kCGAnnotatedSessionEventTap = 2, kCGSessionEventTap = 1, kCGHIDEventTap = 0.
  const attempt = Number(argv[0] ?? "0")
  const tap = [1, 0, 2][attempt % 3]
  // CGEventSourceStateHIDSystemState = 1; kCGEventKeyDown = 10.
  const source = $.CGEventSourceCreate(1)
  const before = $.CGEventSourceCounterForEventType(1, 10)
  const down = $.CGEventCreateKeyboardEvent(source, 0, true) // keyCode 0 = 'a'
  const up = $.CGEventCreateKeyboardEvent(source, 0, false)
  $.CGEventPost(tap, down)
  $.CGEventPost(tap, up)
  const after = $.CGEventSourceCounterForEventType(1, 10)
  return JSON.stringify({ trusted: Boolean(trusted), frontmost: front, keyCode: 0, tap, attempt, counterDelta: after - before })
}
