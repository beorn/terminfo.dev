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
// 60e39dfc, 33587: codimac's console has other people's apps open). Mouse and wheel events go through
// the HID tap, which lands by screen position, so every mouse verb now NAMES the pid and window and
// proves that window is still this pid's, that the point is inside its re-read frame, AND that the
// topmost window at that point is that same window — every other app's window, menu, banner and the
// Dock included — in the same call as the post (@cto cbc34e67, 1ca329e6). Every posting verb also
// holds one exclusive lock for the length of its own
// invocation, so two runs cannot interleave a proof with someone else's focus change. A posting the app
// ignores is not detectable here: the collector installs this helper only after one injected key comes
// back through the app's own TTY.

import AppKit
import Darwin
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

func postWheel(_ notches: Int32, at point: CGPoint) {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        fail("the WindowServer returned no HID event source")
    }
    guard let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: notches, wheel2: 0, wheel3: 0) else {
        fail("CGEventCreateScrollWheelEvent returned nil")
    }
    event.location = point
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
    let targetFrame = requireOwnedWindow(pid, target).frame
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

/// The run's own window as the app reports it NOW: the row must still belong to `pid`. Returns the
/// proof line and the frame from that ONE read, so a coordinate transform and the ownership proof can
/// never be taken from different reads (@cto cbc34e67 condition 2).
/// The run's own window's bounds as the window server reports them: floating, unrounded, layer 0, this pid.
/// Read separately from windowRows because the census row is integer-shaped for its published output and
/// the safety checks must not inherit that rounding (@dev/17 P1.2).
func ownedWindowFrame(_ pid: pid_t, _ target: Int) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for entry in list {
        guard (entry[kCGWindowOwnerPID as String] as? Int) == Int(pid) else { continue }
        guard (entry[kCGWindowLayer as String] as? Int) == 0 else { continue }
        guard (entry[kCGWindowNumber as String] as? Int) == target else { continue }
        guard let bounds = entry[kCGWindowBounds as String] as? [String: Any] else { continue }
        return CGRect(
            x: number(bounds["X"]), y: number(bounds["Y"]),
            width: number(bounds["Width"]), height: number(bounds["Height"]))
    }
    return nil
}

/// CGWindowBounds are top-left origin with Y down, measured from the main display; AppKit screen points
/// are bottom-left origin with Y up. The conversion is one subtraction about the main display's height,
/// and it is the only one this helper applies — so it is checked by the selftest rather than assumed
/// (@dev/17 P1.1).
func appKitPoint(_ point: CGPoint, mainDisplayHeight: CGFloat) -> CGPoint {
    CGPoint(x: point.x, y: mainDisplayHeight - point.y)
}

/// The window the window server itself says receives a mouse-down at `point`, from the top down. Unlike a
/// rectangle walk it skips transparent pixels and windows that ignore mouse events, which is why it is the
/// decision and the rectangle list is only the naming evidence (@dev/17 P1.1). 0 means no receiver.
func hitTestWindowNumber(_ point: CGPoint) -> Int {
    guard let main = NSScreen.screens.first, main.frame.height > 0 else {
        fail("no main-display geometry is available, so the mouse-down hit test cannot be converted to screen " +
            "coordinates; refusing to post where no receiver can be proved")
    }
    return NSWindow.windowNumber(
        at: appKitPoint(point, mainDisplayHeight: main.frame.height), belowWindowWithWindowNumber: 0)
}

/// A drag is a press in one call and a release in the next; this helper's lock covers one invocation and
/// there is no run-level custody to span the sequence, so a refused middle event would strand an unmatched
/// press (@dev/17 P1.3, @cto 1ca329e6 carry). Refuse by name instead of half-posting, and post no up into
/// a window that was never verified.
func requireDragCustody(_ verb: String) {
    fail("mouse \(verb) is part of a drag, and this helper has no run-level custody spanning press, move and " +
        "release; refusing it rather than leaving an unmatched press, so no drag row can be graded here yet")
}

func requireOwnedWindow(_ pid: pid_t, _ target: Int) -> (proof: String, frame: CGRect) {
    guard windowRows(pid).contains(where: { $0["id"] == target }) else {
        fail("window \(target) does not belong to pid \(pid) any more, so a posting there could not be this " +
            "run's own window")
    }
    guard let frame = ownedWindowFrame(pid, target) else {
        fail("window \(target) of pid \(pid) reports bounds this helper cannot read, so no point could be " +
            "proved inside it; refusing to post")
    }
    guard frame.width >= 1, frame.height >= 1 else {
        fail("window \(target) of pid \(pid) reports no usable size (\(describe(frame)))")
    }
    return ("owned=true pid=\(pid) window=\(target)", frame)
}

/// Screen points and frames are half-open: a point on the far edge is outside the window it borders.
func insideWindow(_ point: CGPoint, _ frame: CGRect) -> Bool {
    point.x >= frame.minX && point.y >= frame.minY && point.x < frame.maxX && point.y < frame.maxY
}

/// One on-screen window as the window server lists it, front to back.
struct ScreenWindow {
    let id: Int
    let ownerPid: Int
    let layer: Int
    let frame: CGRect
}

/// Every on-screen window, front to back, across ALL layers and ALL owners. Vanishing windows are
/// skipped by the caller's size rule; nothing here filters by owner or layer.
func screenWindows() -> [ScreenWindow] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
        fail("CGWindowListCopyWindowInfo returned no list")
    }
    var rows: [ScreenWindow] = []
    for entry in list {
        guard let bounds = entry[kCGWindowBounds as String] as? [String: Any] else { continue }
        let rect = CGRect(
            x: number(bounds["X"]), y: number(bounds["Y"]),
            width: number(bounds["Width"]), height: number(bounds["Height"]))
        rows.append(ScreenWindow(
            id: (entry[kCGWindowNumber as String] as? Int) ?? -1,
            ownerPid: (entry[kCGWindowOwnerPID as String] as? Int) ?? -1,
            layer: (entry[kCGWindowLayer as String] as? Int) ?? -1,
            frame: rect))
    }
    return rows
}

func number(_ value: Any?) -> CGFloat {
    // Authoritative floating bounds, unrounded. Rounding each edge independently can shrink a blocker or
    // expand permission by up to half a point per edge, which is enough to hide a covering window
    // (@dev/17 P1.2, 2026-11-13): a foreign window at x=0.49 width 99.49 contains x=99, its rounded
    // bounds (0...99) do not. Integer consumers round at their own boundary; nothing on the safety path does.
    if let int = value as? Int { return CGFloat(int) }
    if let double = value as? Double { return CGFloat(double) }
    return 0
}

/// The window HID events reach at `point`: the FIRST window, front to back, whose frame contains it.
/// This is the only question that decides where a posted event lands, and it is not the same question
/// as "is the point inside our window" — another app's window, a menu, a banner or the Dock can sit
/// over the point and take the event while our window is still the right owner (@cto 1ca329e6).
func coveringWindow(_ rows: [ScreenWindow], _ point: CGPoint) -> ScreenWindow? {
    for row in rows where row.frame.width >= 1 && row.frame.height >= 1 {
        if insideWindow(point, row.frame) { return row }
    }
    return nil
}

/// Refuse unless the topmost window at `point` is the run's own. Called in the SAME process call as the
/// post, immediately before it, so nothing separates the proof from the event. The refusal names the
/// covering window's owner pid and layer — never its title, which is the app's text.
func requireTopmost(_ point: CGPoint, _ pid: pid_t, _ target: Int, _ operation: String) {
    let where_ = "point \(point.x),\(point.y)"
    let rows = screenWindows()
    let covering = coveringWindow(rows, point)
    let hit = hitTestWindowNumber(point)
    if hit == 0 {
        let rect = covering.map {
            ", although window \($0.id) owned by pid \($0.ownerPid) at layer \($0.layer) lists it in its bounds"
        } ?? ", and no listed window contains it"
        fail("the window server reports no window accepts a mouse event at \(where_)\(rect); refusing the mouse " +
            "\(operation) rather than posting where nothing proved a receiver")
    }
    guard let hitRow = rows.first(where: { $0.id == hit }) else {
        fail("the mouse-down hit test at \(where_) names window \(hit), which the on-screen list does not carry, " +
            "so its owner cannot be proved; refusing the mouse \(operation)")
    }
    if hit != target || hitRow.ownerPid != Int(pid) {
        fail("\(where_) hit-tests to window \(hit) owned by pid \(hitRow.ownerPid) at layer \(hitRow.layer), " +
            "not the run's own window \(target) of pid \(pid); refusing the mouse \(operation)")
    }
    if let covering, covering.id != hit {
        fail("the hit test names window \(hit) while the front-to-back rectangle walk names window " +
            "\(covering.id) owned by pid \(covering.ownerPid) at layer \(covering.layer); the two readings " +
            "disagree at \(where_), so the receiver is not proved; refusing the mouse \(operation)")
    }
}

/// The topmost rule's own test, on synthetic rows. No window server read, no event, no app, no trust.
/// Run by the compile-only gate and by anyone who wants to know the rule still holds.
func selftest() {
    let point = CGPoint(x: 50, y: 50)
    let own = ScreenWindow(id: 7, ownerPid: 100, layer: 0, frame: CGRect(x: 0, y: 0, width: 100, height: 100))
    func outcome(_ rows: [ScreenWindow], _ at: CGPoint? = nil) -> String {
        guard let row = coveringWindow(rows, at ?? point) else { return "none" }
        return "window=\(row.id) pid=\(row.ownerPid) layer=\(row.layer)"
    }
    let cases: [(String, String, String)] = [
        ("uncovered", outcome([own]), "window=7 pid=100 layer=0"),
        ("covered-by-other-app", outcome([
            ScreenWindow(id: 9, ownerPid: 200, layer: 0,
                         frame: CGRect(x: 0, y: 0, width: 100, height: 100)),
            own,
        ]), "window=9 pid=200 layer=0"),
        ("covered-by-higher-layer", outcome([
            ScreenWindow(id: 8, ownerPid: 100, layer: 3,
                         frame: CGRect(x: 0, y: 0, width: 100, height: 100)),
            own,
        ]), "window=8 pid=100 layer=3"),
        ("unrelated-window-elsewhere", outcome([
            ScreenWindow(id: 9, ownerPid: 200, layer: 0,
                         frame: CGRect(x: 500, y: 500, width: 10, height: 10)),
            own,
        ]), "window=7 pid=100 layer=0"),
        ("no-window-at-the-point", outcome([
            ScreenWindow(id: 9, ownerPid: 200, layer: 0,
                         frame: CGRect(x: 500, y: 500, width: 10, height: 10)),
        ]), "none"),
    ]
    var failed = 0
    for (name, got, want) in cases {
        if got == want {
            out("selftest=ok case=\(name)")
        } else {
            failed += 1
            out("selftest=FAIL case=\(name) got=\(got) want=\(want)")
        }
    }
    // The arithmetic the hit test stands on, checked here because the platform call itself cannot be
    // exercised without a window server (@dev/17 P1.1, P1.2).
    let conversions: [(String, CGPoint, CGFloat, CGPoint)] = [
        ("appkit-flip-mid", CGPoint(x: 10, y: 90), 100, CGPoint(x: 10, y: 10)),
        ("appkit-flip-origin", CGPoint(x: 0, y: 0), 900, CGPoint(x: 0, y: 900)),
        ("appkit-flip-bottom", CGPoint(x: 5, y: 900), 900, CGPoint(x: 5, y: 0)),
    ]
    for (name, cg, height, want) in conversions {
        let got = appKitPoint(cg, mainDisplayHeight: height)
        if got == want {
            out("selftest=ok case=\(name)")
        } else {
            failed += 1
            out("selftest=FAIL case=\(name) got=\(got.x),\(got.y) want=\(want.x),\(want.y)")
        }
    }
    // Rounding each edge independently hides this blocker: raw bounds contain x=99, rounded (0...99) do not.
    let fractional: [(String, [ScreenWindow], CGPoint, String)] = [
        ("fractional-blocker-not-hidden", [
            ScreenWindow(id: 9, ownerPid: 200, layer: 0,
                         frame: CGRect(x: 0.49, y: 0, width: 99.49, height: 100)),
            ScreenWindow(id: 7, ownerPid: 100, layer: 0, frame: CGRect(x: 0, y: 0, width: 200, height: 200)),
        ], CGPoint(x: 99, y: 50), "window=9 pid=200 layer=0"),
        ("fractional-far-edge-excluded", [
            ScreenWindow(id: 9, ownerPid: 200, layer: 0,
                         frame: CGRect(x: 0, y: 0, width: 99.5, height: 100)),
        ], CGPoint(x: 99.5, y: 50), "none"),
        ("fractional-origin-inside", [
            ScreenWindow(id: 9, ownerPid: 200, layer: 0,
                         frame: CGRect(x: 0.5, y: 0, width: 99.5, height: 100)),
        ], CGPoint(x: 99.9, y: 50), "window=9 pid=200 layer=0"),
        ("fractional-before-origin", [
            ScreenWindow(id: 9, ownerPid: 200, layer: 0,
                         frame: CGRect(x: 0.5, y: 0, width: 99.5, height: 100)),
        ], CGPoint(x: 0.25, y: 50), "none"),
    ]
    for (name, rows, at, want) in fractional {
        let got = outcome(rows, at)
        if got == want {
            out("selftest=ok case=\(name)")
        } else {
            failed += 1
            out("selftest=FAIL case=\(name) got=\(got) want=\(want)")
        }
    }
    let total = cases.count + conversions.count + fractional.count
    if failed > 0 { fail("\(failed) topmost-window selftest case(s) failed") }
    out("selftest=ok cases=\(total)")
}

/// One posted event at a time across processes. The proof and the post must be atomic, or a second run
/// can move focus between them and the posting lands in another window with its silence read as the
/// app's (@cto cbc34e67 point 4). One fixed file, exclusive, released when this process exits. The
/// run-level "one run at a time" is custody, not this lock, and is not built here.
///
/// This lock covers ONE invocation. A drag is a press in one call and a release in the next, so the
/// lock does not span it: run-level custody has to cover the whole drag before any drag row may be
/// graded (@cto 1ca329e6 carry).
func holdInputLock() {
    let path = "/tmp/darwin-input-helper.input.lock"
    // O_NOFOLLOW: a symlink planted at this fixed path must not redirect the lock (or a later write) to a
    // file someone else chose. The lock is only ever this file, created 0600 by this user.
    let descriptor = open(path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    if descriptor < 0 {
        fail("the input lock \(path) could not be opened, so no posting may be proved atomic; refusing to post")
    }
    // Owner-checked (@cto aaeb18ac): a lock file this user does not own could be held open by someone
    // else's process, which would turn "one posting at a time" into "whoever opened it first".
    var info = stat()
    if fstat(descriptor, &info) != 0 {
        fail("the input lock \(path) could not be inspected, so no posting may be proved atomic; refusing to post")
    }
    if info.st_uid != getuid() {
        fail("the input lock \(path) is owned by uid \(info.st_uid), not this user (\(getuid())); refusing to post through a lock someone else controls")
    }
    if info.st_mode & mode_t(S_IFMT) != mode_t(S_IFREG) {
        fail("the input lock \(path) is not a regular file; refusing to post through it")
    }
    if flock(descriptor, LOCK_EX) != 0 {
        fail("the input lock \(path) could not be taken, so no posting may be proved atomic; refusing to post")
    }
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
case "selftest":
    // Pure: synthetic rows only. No window server read, no event, no app, no trust.
    selftest()
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
    holdInputLock()
    // The process, window and tab proofs and the post share one process call, so nothing can take
    // focus between a separate check and the post.
    let proof = requireKeyWindow(pid, target)
    let tab = arguments.count == 6 ? " \(requireSelectedTab(target, arguments[5]))" : ""
    postKey(posted, to: pid)
    out("posted=key route=pid \(proof)\(tab) code=\(posted.keyCode) unicode=\(posted.unicode.count)")
case "mouse":
    guard arguments.count >= 6 else {
        fail("usage: darwin-input-helper mouse <move|press|release|click> <pid> <window-id> ...")
    }
    requireTrust()
    let operation = arguments[2]
    let pid = processId(arguments[3])
    let target = windowId(arguments[4], operation)
    holdInputLock()
    switch operation {
    case "move":
        guard arguments.count == 8 else {
            fail("usage: darwin-input-helper mouse move <pid> <window-id> <plain|dragged> <x> <y>")
        }
        let dragged = arguments[5] == "dragged"
        if dragged { requireDragCustody("move dragged") }
        guard let x = Double(arguments[6]), let y = Double(arguments[7]) else {
            fail("mouse move requires finite window-relative coordinates; got \(arguments[6]),\(arguments[7])")
        }
        // Window-relative in, screen point out, from the frame proved in this same call.
        let owned = requireOwnedWindow(pid, target)
        let point = CGPoint(x: owned.frame.minX + x, y: owned.frame.minY + y)
        guard insideWindow(point, owned.frame) else {
            fail("mouse move \(x),\(y) is outside the run's own window \(target) at \(describe(owned.frame)); " +
                "refusing the move")
        }
        requireTopmost(point, pid, target, "move")
        postMouse(dragged ? .leftMouseDragged : .mouseMoved, at: point)
        out("posted=\(dragged ? "dragged" : "move") \(owned.proof) point=\(x),\(y)")
    case "press", "release", "click":
        guard arguments.count == 6 else {
            fail("usage: darwin-input-helper mouse \(operation) <pid> <window-id> <button>")
        }
        guard let button = Int(arguments[5]), [1, 4, 5].contains(button) else {
            fail("mouse \(operation) requires button 1, 4 or 5; got \(arguments[5])")
        }
        // A left press and its matching release are two invocations: one half can be refused, and then an
        // unmatched press is live. Refuse both by name until run custody exists (@dev/17 P1.3). Click posts
        // its own up in the same call; wheel is not a drag.
        if button == 1 && operation != "click" { requireDragCustody(operation) }
        // A click, press or wheel acts where the pointer IS, so the pointer is proved inside the
        // window that was just proved to be this run's. Nothing here moves it: a caller that has not
        // placed it inside its own window gets a refusal, never a click somewhere else.
        let owned = requireOwnedWindow(pid, target)
        let pointer = currentPointer()
        guard insideWindow(pointer, owned.frame) else {
            fail("the pointer is at \(pointer.x),\(pointer.y), outside the run's own window \(target) at " +
                "\(describe(owned.frame)); refusing the \(operation)")
        }
        // Owner and frame are not enough: whatever is stacked above that point receives the event.
        requireTopmost(pointer, pid, target, operation)
        switch button {
        case 4, 5:
            // Wheel 4 scrolls up and 5 scrolls down: one line notch per click, the same shape a
            // Linux XTEST button-4/5 click produces.
            postWheel(button == 4 ? 1 : -1, at: pointer)
        default:
            switch operation {
            case "press": postMouse(.leftMouseDown, at: pointer)
            case "release": postMouse(.leftMouseUp, at: pointer)
            default:
                postMouse(.leftMouseDown, at: pointer)
                postMouse(.leftMouseUp, at: pointer)
            }
        }
        out("posted=\(operation) button=\(button) \(owned.proof) point=\(Int(pointer.x - owned.frame.minX))," +
            "\(Int(pointer.y - owned.frame.minY))")
    default:
        fail("unknown mouse operation: \(operation)")
    }
default:
    fail("unknown command: \(arguments[1])")
}

