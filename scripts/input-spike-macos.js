// Spike only (29814): post one CGEvent key into the frontmost application and report the facts that
// separate "a grant is missing" from "the event went somewhere else". No permission is actuated.
ObjC.import("ApplicationServices")
ObjC.import("CoreGraphics")
ObjC.import("AppKit")

function main() {
  const trusted = $.AXIsProcessTrusted()
  const frontmost = $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier
  const front = frontmost ? String(ObjC.unwrap(frontmost)) : "unknown"
  // CGEventSourceStateHIDSystemState = 1; kCGSessionEventTap = 1.
  const source = $.CGEventSourceCreate(1)
  const down = $.CGEventCreateKeyboardEvent(source, 0, true) // keyCode 0 = 'a'
  const up = $.CGEventCreateKeyboardEvent(source, 0, false)
  $.CGEventPost(1, down)
  $.CGEventPost(1, up)
  return JSON.stringify({ trusted: Boolean(trusted), frontmost: front, keyCode: 0 })
}

console.log(main())
