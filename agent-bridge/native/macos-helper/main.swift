import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// Small, dependency-free macOS primitive used by the Electron bridge. The
// helper deliberately exposes only focus and keyboard operations: audio is
// owned by CoreAudio/UAC and never passes through this process.

func emit(_ values: [String: Any]) {
    let data = try? JSONSerialization.data(withJSONObject: values, options: [])
    if let data, let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("{\"ok\":false,\"detail\":\"无法序列化辅助器结果\"}")
    }
}

func fail(_ detail: String) -> Never {
    emit(["ok": false, "detail": detail])
    exit(1)
}

func runningApplication(named query: String) -> NSRunningApplication? {
    let needle = query.lowercased()
    let candidates = NSWorkspace.shared.runningApplications.filter { app in
        let name = (app.localizedName ?? "").lowercased()
        let bundle = (app.bundleIdentifier ?? "").lowercased()
        return name == needle || name.contains(needle) || bundle.contains(needle)
    }
    // The Codex desktop app currently identifies itself as com.openai.codex
    // while its Chromium renderer children also contain "Codex" in the name.
    // Prefer the regular application process so AX points at the real window.
    if needle == "codex", let main = candidates.first(where: {
        $0.bundleIdentifier?.lowercased() == "com.openai.codex" && $0.activationPolicy == .regular
    }) { return main }
    return candidates.first(where: { $0.activationPolicy == .regular }) ?? candidates.first
}

func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value as? String
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success else {
        return []
    }
    return (value as? [AXUIElement]) ?? []
}

func textInputScore(_ element: AXUIElement) -> Int {
    let role = axString(element, kAXRoleAttribute as CFString) ?? ""
    let subrole = axString(element, kAXSubroleAttribute as CFString) ?? ""
    let title = (axString(element, kAXTitleAttribute as CFString) ?? "").lowercased()
    let description = (axString(element, kAXDescriptionAttribute as CFString) ?? "").lowercased()
    var score = 0
    if role == "AXTextArea" { score += 100 }
    if role == "AXTextField" || role == "AXComboBox" { score += 65 }
    if subrole.contains("text") { score += 20 }
    if title.contains("message") || title.contains("prompt") || title.contains("输入") { score += 20 }
    if description.contains("message") || description.contains("prompt") || description.contains("输入") { score += 20 }
    return score
}

func findComposer(in root: AXUIElement) -> AXUIElement? {
    var best: (score: Int, element: AXUIElement)?
    func visit(_ element: AXUIElement, depth: Int) {
        if depth > 12 { return }
        let score = textInputScore(element)
        if score > (best?.score ?? 0) { best = (score, element) }
        for child in axChildren(element) { visit(child, depth: depth + 1) }
    }
    visit(root, depth: 0)
    return best?.score ?? 0 > 0 ? best?.element : nil
}

func clickWindowComposerFallback(_ window: AXUIElement) -> Bool {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionValue) == .success,
          AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeValue) == .success,
          let positionValue,
          let sizeValue else { return false }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size),
          size.width > 200,
          size.height > 160,
          let source = CGEventSource(stateID: .hidSystemState) else { return false }
    // Codex/ChatGPT's composer is at the bottom center of the main window.
    // This is only a fallback for Electron web contents that do not expose
    // their internal AX tree to the host process.
    let point = CGPoint(x: position.x + size.width / 2, y: position.y + size.height - 72)
    let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
    let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
    return true
}

func focusApplication(_ appName: String) {
    guard let app = runningApplication(named: appName) else {
        fail("未找到正在运行的应用：\(appName)")
    }
    let pid = app.processIdentifier
    _ = app.activate(options: [.activateAllWindows])
    let axApp = AXUIElementCreateApplication(pid)
    var focusedWindowValue: CFTypeRef?
    let windowStatus = AXUIElementCopyAttributeValue(
        axApp,
        kAXFocusedWindowAttribute as CFString,
        &focusedWindowValue
    )
    guard windowStatus == .success, let focusedWindow = focusedWindowValue else {
        emit(["ok": true, "focused": false, "detail": "\(appName) 已置前，但无法读取窗口辅助功能树；请检查辅助功能权限"])
        return
    }
    let focusedWindowElement = focusedWindow as! AXUIElement
    guard let composer = findComposer(in: focusedWindowElement) else {
        if clickWindowComposerFallback(focusedWindowElement) {
            emit(["ok": true, "focused": true, "detail": "\(appName) 已置前，并通过窗口底部备用点击聚焦输入框"])
        } else {
            emit(["ok": true, "focused": false, "detail": "\(appName) 已置前，但没有找到可聚焦的文本输入框"])
        }
        return
    }
    let focused = AXUIElementSetAttributeValue(
        composer,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    ) == .success
    if focused {
        emit(["ok": true, "focused": true, "detail": "\(appName) 已置前并聚焦输入框"])
    } else {
        emit(["ok": true, "focused": false, "detail": "找到输入框，但 macOS 拒绝设置焦点"])
    }
}

func dumpAccessibility(_ appName: String) {
    guard let app = runningApplication(named: appName) else { fail("未找到正在运行的应用：\(appName)") }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var focusedWindowValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &focusedWindowValue) == .success,
          let focusedWindowValue else { fail("无法读取焦点窗口") }
    let window = focusedWindowValue as! AXUIElement
    func visit(_ element: AXUIElement, _ depth: Int) {
        if depth > 8 { return }
        let role = axString(element, kAXRoleAttribute as CFString) ?? "?"
        let title = axString(element, kAXTitleAttribute as CFString) ?? ""
        let description = axString(element, kAXDescriptionAttribute as CFString) ?? ""
        print("\(String(repeating: "  ", count: depth))\(role) title=\(title) description=\(description)")
        for child in axChildren(element) { visit(child, depth + 1) }
    }
    visit(window, 0)
}

let keyCodes: [String: CGKeyCode] = [
    "backspace": 51,
    "enter": 36,
    "escape": 53,
    "left": 123,
    "right": 124,
    "up": 126,
    "down": 125,
    "tab": 48,
    "fn": 63,
]

func sendKey(_ name: String, _ phase: String) {
    guard let code = keyCodes[name] else { fail("未知按键：\(name)") }
    guard let source = CGEventSource(stateID: .hidSystemState) else { fail("无法创建 CGEventSource") }
    let phases = phase == "tap" ? ["down", "up"] : [phase]
    for current in phases {
        guard let event = CGEvent(
            keyboardEventSource: source,
            virtualKey: code,
            keyDown: current == "down"
        ) else { fail("无法创建键盘事件：\(name)") }
        if name == "fn" { event.flags.insert(.maskSecondaryFn) }
        event.post(tap: .cghidEventTap)
    }
    emit(["ok": true, "detail": "\(name):\(phase)"])
}

func sendCommandTab() {
    guard let source = CGEventSource(stateID: .hidSystemState) else { fail("无法创建 CGEventSource") }
    guard let commandDown = CGEvent(keyboardEventSource: source, virtualKey: 55, keyDown: true),
          let tabDown = CGEvent(keyboardEventSource: source, virtualKey: 48, keyDown: true),
          let tabUp = CGEvent(keyboardEventSource: source, virtualKey: 48, keyDown: false),
          let commandUp = CGEvent(keyboardEventSource: source, virtualKey: 55, keyDown: false) else {
        fail("无法创建 Command+Tab 键盘事件")
    }
    commandDown.post(tap: .cghidEventTap)
    tabDown.flags.insert(.maskCommand)
    tabDown.post(tap: .cghidEventTap)
    tabUp.flags.insert(.maskCommand)
    tabUp.post(tap: .cghidEventTap)
    commandUp.post(tap: .cghidEventTap)
    emit(["ok": true, "detail": "Command+Tab"])
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("缺少命令") }

switch command {
case "trusted":
    emit(["ok": true, "trusted": AXIsProcessTrusted(), "detail": "AXIsProcessTrusted"])
case "focus":
    guard args.count >= 2 else { fail("focus 缺少应用名") }
    focusApplication(args[1])
case "dump":
    guard args.count >= 2 else { fail("dump 缺少应用名") }
    dumpAccessibility(args[1])
case "key":
    guard args.count >= 3 else { fail("key 需要按键名和 down/up/tap") }
    sendKey(args[1], args[2])
case "command-tab":
    sendCommandTab()
default:
    fail("未知命令：\(command)")
}
