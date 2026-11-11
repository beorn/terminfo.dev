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
// Every event is posted to the HID event tap, so the app receives the same stream a real keyboard
// and mouse produce. A posting the app ignores is not detectable here: the collector installs this
// helper only after one injected key comes back through the app's own TTY.

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

func postKey(_ keysym: Keysym) {
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
        event.post(tap: .cghidEventTap)
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

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: darwin-input-helper <trust|front|windows|key|mouse> ...")
}

switch arguments[1] {
case "trust":
    out("trusted=\(trusted())")
case "front":
    guard arguments.count == 3 else { fail("usage: darwin-input-helper front <pid>") }
    requireTrust()
    let pid = processId(arguments[2])
    activate(pid)
    out("frontmost=true pid=\(pid)")
case "windows":
    guard arguments.count == 3 else { fail("usage: darwin-input-helper windows <pid>") }
    let pid = processId(arguments[2])
    out(serialize(windowRows(pid)))
case "key":
    guard arguments.count == 4 else { fail("usage: darwin-input-helper key <pid> <keysym>") }
    requireTrust()
    _ = processId(arguments[2])
    postKey(keysym(arguments[3]))
    out("posted=key")
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

