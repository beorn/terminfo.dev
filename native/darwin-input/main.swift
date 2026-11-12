// The macOS input mechanism for terminfo's collector (#33574).
//
// Build (the job compiles it, nothing is committed as a binary):
//   swiftc -O -o "$RUNNER_TEMP/darwin-input-helper" native/darwin-input/main.swift
//
// NOTHING HERE WRITES A TCC ROW, CALLS SUDO, OR INSTALLS ANYTHING. The hosted-runner workflow grants
// Accessibility beside the existing Screen Recording grant and reads the row back; this helper only
// reports what it observes and refuses by name when the grant is missing. NEVER run a TCC write from
// this file, on a fleet host or on a person's Mac.
//
// Keys are posted to the measured app's pid only (CGEvent.postToPid), never to the HID or session
// tap. What each key post proves, in the same call and immediately before the post: the process (the
// app is frontmost), the window (the run's own window is the app's front layer-0 window AND its key
// window) and, when a tab tty is given, the selected tab (Terminal's selected tab of that window has
// the run's own tty, read by Apple events to Terminal). A key can still reach whatever that tab runs;
// nothing here proves more than those three facts at post time (@cto 75732b9d,
// 60e39dfc, 33587: codimac's console has other people's apps open). Mouse and wheel events still use
// the HID tap; they land by screen position, and the collector never posts them on an owned host. A
// posting the app ignores is not detectable here: the collector installs this helper only after one
// injected key comes back through the app's own TTY.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

func out(_ text: String) {
    print(text)
}

func processId(_ raw: String) -> pid_t {
    guard let value = Int32(raw), value > 1 else {
        fail("not a process id: \(raw)")
    }
    return pid_t(value)
}

func trusted() -> Bool {
    return AXIsProcessTrusted()
}

func requireTrust() {
    if !trusted() {
        fail("accessibility grant absent: AXIsProcessTrusted=false for this helper (\(CommandLine.arguments[0])); " +
            "the hosted-runner workflow grants it beside Screen Recording and reads the row back")
    }
}

struct Keysym {
    let keyCode: CGKeyCode
    let flags: CGEventFlags
    let unicode: [UniChar]
}

let namedKeys: [String: CGKeyCode] = [
    "Return": 36, "Tab": 48, "Space": 49, "Escape": 53, "BackSpace": 51, "Delete": 117,
    "Up": 126, "Down": 125, "Left": 123, "Right": 124,
    "Home": 115, "End": 119, "Page_Up": 116, "Page_Down": 121,
    "KP_Add": 69, "KP_Subtract": 78, "KP_Multiply": 67, "KP_Divide": 75, "KP_Enter": 76,
]

func keysym(_ text: String) -> Keysym {
    var flags: CGEventFlags = []
    var name = text
    var modifiers: [String] = []
    while let plus = name.firstIndex(of: "+"), plus != name.startIndex {
        modifiers.append(String(name[name.startIndex..<plus]).lowercased())
        name = String(name[name.index(after: plus)...])
    }
    for modifier in modifiers {
        switch modifier {
        case "ctrl", "control": flags.insert(.maskControl)
        case "shift": flags.insert(.maskShift)
        case "alt", "meta": flags.insert(.maskAlternate)
        case "super", "cmd": flags.insert(.maskCommand)
        default: fail("unknown modifier in keysym \(text): \(modifier)")
        }
    }
    if let keyCode = namedKeys[name] {
        let numericPad: CGEventFlags = name.hasPrefix("KP_") ? .maskNumericPad : []
        return Keysym(keyCode: keyCode, flags: flags.union(numericPad), unicode: [])
    }
    // "code:<n>" posts virtual keycode n with NO unicode payload. The plain-character form below
    // posts virtual keycode 0 WITH one, so the two routes are separable: an app that takes the
    // keycode route and drops the unicode one is a different defect from an app that takes neither.
    if name.hasPrefix("code:") {
        guard let keyCode = UInt16(name.dropFirst("code:".count)), keyCode > 0 else {
            fail("code: takes a positive virtual keycode, as in code:6 for the ANSI z key; got \(text)")
        }
        return Keysym(keyCode: CGKeyCode(keyCode), flags: flags, unicode: [])
    }
    let scalars = Array(name.unicodeScalars)
    guard scalars.count == 1, let scalar = scalars.first else {
        fail("unknown keysym \(text): expected one printable character, a named key, or ctrl+/shift+ modifiers")
    }
    // A printable character carries its own unicode payload, so the posting does not depend on the
    // runner's keyboard layout.
    return Keysym(keyCode: 0, flags: flags, unicode: Array(String(scalar).utf16))
}

func currentPointer() -> CGPoint {
    guard let event = CGEvent(source: nil) else {
        fail("the WindowServer returned no event source for the pointer location")
    }
    return event.location
}

/// The element behind an accessibility attribute, or nil when the attribute is not an element.
func axElement(_ raw: CFTypeRef?) -> AXUIElement? {
    guard let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(raw, to: AXUIElement.self)
}

func axValue(_ raw: CFTypeRef?) -> AXValue? {
    guard let raw, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    return unsafeBitCast(raw, to: AXValue.self)
}

/// The window the accessibility layer says holds keyboard focus for this pid. The WindowServer's
/// frontmost application is NOT this: an app can be frontmost with a different window focused, and a
/// posting then lands in a window the run never launched (#33574, run 43106790420).
func focusedWindowFrame(_ pid: pid_t) -> CGRect? {
    let application = AXUIElementCreateApplication(pid)
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &raw) == .success,
          let window = axElement(raw) else { return nil }
    var positionRaw: CFTypeRef?
    var sizeRaw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionRaw) == .success,
          AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRaw) == .success,
          let position = axValue(positionRaw), let size = axValue(sizeRaw) else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &extent) else { return nil }
    return CGRect(origin: point, size: extent)
}

func describe(_ rect: CGRect) -> String {
    return "\(Int(rect.origin.x)),\(Int(rect.origin.y)) \(Int(rect.width))x\(Int(rect.height))"
}

/// Same window, by geometry: one point of slack absorbs rounding between the two APIs, and a
/// different window the app placed on the same rectangle is accepted, which the front-window check
/// above has already excluded for the launch window.
func sameWindow(_ left: CGRect, _ right: CGRect) -> Bool {
    let tolerance = 1.0
    return abs(left.origin.x - right.origin.x) <= tolerance && abs(left.origin.y - right.origin.y) <= tolerance &&
        abs(left.width - right.width) <= tolerance && abs(left.height - right.height) <= tolerance
}

func postKey(_ keysym: Keysym, to pid: pid_t) {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        fail("the WindowServer returned no HID event source")
    }
    for downState in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: keysym.keyCode, keyDown: downState) else {
            fail("CGEventCreateKeyboardEvent returned nil")
        }
        event.flags = keysym.flags
        if !keysym.unicode.isEmpty {
            keysym.unicode.withUnsafeBufferPointer { buffer in
                event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
            }
        }
        event.postToPid(pid)
    }
}

func postMouse(_ type: CGEventType, at point: CGPoint) {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        fail("the WindowServer returned no HID event source")
    }
    guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
        fail("CGEventCreateMouseEvent returned nil")
    }
    event.post(tap: .cghidEventTap)
}

func postWheel(_ notches: Int32) {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        fail("the WindowServer returned no HID event source")
    }
    guard let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: notches, wheel2: 0, wheel3: 0) else {
        fail("CGEventCreateScrollWheelEvent returned nil")
    }
    event.location = currentPointer()
    event.post(tap: .cghidEventTap)
}

func windowRows(_ pid: pid_t) -> [[String: Int]] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
        fail("CGWindowListCopyWindowInfo returned no list")
    }
    var rows: [[String: Int]] = []
    for entry in list {
        guard let owner = entry[kCGWindowOwnerPID as String] as? Int, owner == Int(pid) else { continue }
        guard let layer = entry[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        guard let id = entry[kCGWindowNumber as String] as? Int else { continue }
        guard let bounds = entry[kCGWindowBounds as String] as? [String: Any] else { continue }
        func coordinate(_ key: String) -> Int {
            if let value = bounds[key] as? Int { return value }
            if let value = bounds[key] as? Double { return Int(value.rounded()) }
            return 0
        }
        rows.append([
            "id": id,
            "x": coordinate("X"),
            "y": coordinate("Y"),
            "width": coordinate("Width"),
            "height": coordinate("Height"),
        ])
    }
    return rows
}

func frontmostPid() -> pid_t {
    return NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
}

func activate(_ pid: pid_t) {
    guard let app = NSRunningApplication(processIdentifier: pid) else {
        fail("no running application has pid \(pid)")
    }
    let name = app.bundleIdentifier ?? app.localizedName ?? "pid \(pid)"
    if frontmostPid() == pid { return }
    if !app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) {
        fail("\(name) refused activation through NSRunningApplication.activate")
    }
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline {
        if frontmostPid() == pid { return }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    let front = NSWorkspace.shared.frontmostApplication
    let frontName = front?.bundleIdentifier ?? front?.localizedName ?? "pid \(front?.processIdentifier ?? 0)"
    fail("\(name) is not the frontmost application after activation; frontmost is \(frontName), so a posting " +
        "would land in the wrong window")
}

func serialize(_ rows: [[String: Int]]) -> String {
    let bodies = rows.map { row -> String in
        let ordered = ["id", "x", "y", "width", "height"].map { "\"\($0)\":\(row[$0] ?? 0)" }
        return "{" + ordered.joined(separator: ",") + "}"
    }
    return "[" + bodies.joined(separator: ",") + "]"
}

/// The run's own window must be this pid's front layer-0 window and its accessibility key window;
/// otherwise a posting lands in another window and its silence would be read as terminal behaviour.
/// Returns the proof line; refuses by name otherwise.
func requireKeyWindow(_ pid: pid_t, _ target: Int) -> String {
    if frontmostPid() != pid {
        let front = NSWorkspace.shared.frontmostApplication
        let frontName = front?.bundleIdentifier ?? front?.localizedName ?? "pid \(front?.processIdentifier ?? 0)"
        fail("pid \(pid) is not the frontmost application at post time; frontmost is \(frontName)")
    }
    // CGWindowListCopyWindowInfo is front-to-back, so the first layer-0 window this pid owns is
    // the one a keystroke reaches. A posting into any other window is silence, not a reading.
    let front = windowRows(pid).first?["id"]
    guard let front else {
        fail("pid \(pid) owns no on-screen layer-0 window; the targeted window \(target) cannot be key")
    }
    if front != target {
        fail("the run's own window \(target) is not the app front window; the app front window is \(front), " +
            "so a posting would land in another window and its silence would be read as terminal behaviour")
    }
    // Front is not key: an app can be frontmost with a different one of its windows focused, and a
    // posting then lands there. Refuse by name rather than let that silence be read as the app's.
    guard let targetRow = windowRows(pid).first(where: { $0["id"] == target }) else {
        fail("window \(target) of pid \(pid) disappeared between the census and the key-window check")
    }
    let targetFrame = CGRect(
        x: targetRow["x"] ?? 0, y: targetRow["y"] ?? 0,
        width: targetRow["width"] ?? 0, height: targetRow["height"] ?? 0)
    guard let keyFrame = focusedWindowFrame(pid) else {
        fail("pid \(pid) reported no focused window through the accessibility layer, so the helper cannot " +
            "prove the run's own window \(target) is the key window; refusing to post into a window it " +
            "cannot verify")
    }
    if !sameWindow(keyFrame, targetFrame) {
        fail("the run's own window \(target) at \(describe(targetFrame)) is not the key window of pid \(pid): " +
            "the accessibility layer reports the key window at \(describe(keyFrame)), so a posting would land " +
            "in another window and its silence would be read as terminal behaviour")
    }
    return "frontmost=true front-window=true key=true pid=\(pid) window=\(target)"
}

/// Terminal's selected tab of the run's window must be the run's own tab: the window proof does not
/// cover tabs, and a key posted while another tab is selected reaches that tab's shell. Read by Apple
/// events to Terminal only (@cto 615cf90b, 75732b9d); refuses by name on any other answer.
func requireSelectedTab(_ target: Int, _ tty: String) -> String {
    let source = "tell application \"Terminal\" to get tty of selected tab of window id \(target)"
    guard let script = NSAppleScript(source: source) else {
        fail("the selected-tab query for window \(target) did not compile")
    }
    var error: NSDictionary?
    let result = script.executeAndReturnError(&error)
    if let error {
        fail("the selected tab of window \(target) could not be read through Apple events to Terminal: \(error)")
    }
    guard let selected = result.stringValue, !selected.isEmpty else {
        fail("Terminal named no tty for the selected tab of window \(target)")
    }
    if selected != tty {
        fail("the selected tab of window \(target) is \(selected), not the run's own tab \(tty), so the key " +
            "would reach another tab's shell")
    }
    return "tab=\(tty)"
}

func windowId(_ raw: String, _ verb: String) -> Int {
    guard let target = Int(raw), target > 0 else {
        fail("\(verb) requires a positive window id; got \(raw)")
    }
    return target
}


let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: darwin-input-helper <trust|front|windows|key|mouse> ...")
}

switch arguments[1] {
case "trust":
    out("trusted=\(trusted())")
case "front":
    guard arguments.count == 3 || arguments.count == 4 else {
        fail("usage: darwin-input-helper front <pid> [window-id]")
    }
    requireTrust()
    let pid = processId(arguments[2])
    activate(pid)
    if arguments.count == 4 {
        out(requireKeyWindow(pid, windowId(arguments[3], "front")))
    } else {
        out("frontmost=true pid=\(pid)")
    }
case "windows":
    guard arguments.count == 3 else { fail("usage: darwin-input-helper windows <pid>") }
    let pid = processId(arguments[2])
    out(serialize(windowRows(pid)))
case "key":
    guard arguments.count == 5 || arguments.count == 6 else {
        fail("usage: darwin-input-helper key <pid> <window-id> <keysym> [tab-tty]")
    }
    requireTrust()
    let pid = processId(arguments[2])
    let target = windowId(arguments[3], "key")
    let posted = keysym(arguments[4])
    // The process, window and tab proofs and the post share one process call, so nothing can take
    // focus between a separate check and the post.
    let proof = requireKeyWindow(pid, target)
    let tab = arguments.count == 6 ? " \(requireSelectedTab(target, arguments[5]))" : ""
    postKey(posted, to: pid)
    out("posted=key route=pid \(proof)\(tab) code=\(posted.keyCode) unicode=\(posted.unicode.count)")
case "mouse":
    guard arguments.count >= 4 else { fail("usage: darwin-input-helper mouse <move|press|release|click> ...") }
    requireTrust()
    let operation = arguments[2]
    switch operation {
    case "move":
        guard arguments.count == 6 else { fail("usage: darwin-input-helper mouse move <plain|dragged> <x> <y>") }
        let dragged = arguments[3] == "dragged"
        guard let x = Double(arguments[4]), let y = Double(arguments[5]) else {
            fail("mouse move requires finite screen coordinates; got \(arguments[4]),\(arguments[5])")
        }
        postMouse(dragged ? .leftMouseDragged : .mouseMoved, at: CGPoint(x: x, y: y))
        out("posted=\(dragged ? "dragged" : "move")")
    case "press", "release", "click":
        guard arguments.count == 4 else { fail("usage: darwin-input-helper mouse \(operation) <button>") }
        guard let button = Int(arguments[3]), [1, 4, 5].contains(button) else {
            fail("mouse \(operation) requires button 1, 4 or 5; got \(arguments[3])")
        }
        switch button {
        case 4, 5:
            // Wheel 4 scrolls up and 5 scrolls down: one line notch per click, the same shape a
            // Linux XTEST button-4/5 click produces.
            postWheel(button == 4 ? 1 : -1)
        default:
            switch operation {
            case "press": postMouse(.leftMouseDown, at: currentPointer())
            case "release": postMouse(.leftMouseUp, at: currentPointer())
            default:
                postMouse(.leftMouseDown, at: currentPointer())
                postMouse(.leftMouseUp, at: currentPointer())
            }
        }
        out("posted=\(operation) button=\(button)")
    default:
        fail("unknown mouse operation: \(operation)")
    }
default:
    fail("unknown command: \(arguments[1])")
}

