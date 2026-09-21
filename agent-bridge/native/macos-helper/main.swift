import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import AVFoundation
import AudioToolbox
import Vision
#if canImport(Darwin)
import Darwin
#endif

// Small, dependency-free macOS primitive used by the Electron bridge. The
// helper deliberately exposes small focus, keyboard, and CoreAudio operations.
// Raw PCM is kept out of Electron's renderer and is consumed by a native
// CoreAudio source node when the serial-blackhole path is active.

func emit(_ values: [String: Any]) {
    let data = try? JSONSerialization.data(withJSONObject: values, options: [])
    if let data, let text = String(data: data, encoding: .utf8) {
        // stdout is a pipe when launched by Electron and Swift's print can be
        // block-buffered there. The bridge needs the ready/error line now.
        FileHandle.standardOutput.write(Data((text + "\n").utf8))
    } else {
        FileHandle.standardOutput.write(Data("{\"ok\":false,\"detail\":\"无法序列化辅助器结果\"}\n".utf8))
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
        if needle == "codex" {
            // The current macOS Codex desktop app is packaged as ChatGPT.app
            // (com.openai.chatgpt), while older releases used com.openai.codex.
            return name == needle || name.contains(needle) || bundle.contains(needle)
                || name == "chatgpt" || bundle == "com.openai.chatgpt"
        }
        return name == needle || name.contains(needle) || bundle.contains(needle)
    }
    // The Codex desktop app currently identifies itself as com.openai.codex
    // while its Chromium renderer children also contain "Codex" in the name.
    // Prefer the regular application process so AX points at the real window.
    if needle == "codex", let main = candidates.first(where: {
        let bundle = $0.bundleIdentifier?.lowercased()
        return (bundle == "com.openai.codex" || bundle == "com.openai.chatgpt")
            && $0.activationPolicy == .regular
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

func axText(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    if let text = value as? String { return text }
    if let attributed = value as? NSAttributedString { return attributed.string }
    return nil
}

func axCursor(_ element: AXUIElement) -> Int? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
          let value else { return nil }
    let axValue = value as! AXValue
    var range = CFRange(location: 0, length: 0)
    guard AXValueGetValue(axValue, .cfRange, &range) else { return nil }
    return max(0, range.location + range.length)
}

func focusedWindow(for app: NSRunningApplication) -> AXUIElement? {
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var focusedWindowValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        axApp,
        kAXFocusedWindowAttribute as CFString,
        &focusedWindowValue
    ) == .success, let focusedWindowValue else { return nil }
    return (focusedWindowValue as! AXUIElement)
}

func focusedComposer(in window: AXUIElement) -> AXUIElement? {
    var focusedValue: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(
        window,
        kAXFocusedUIElementAttribute as CFString,
        &focusedValue
    )
    if status == .success, let focusedValue {
        let focused = focusedValue as! AXUIElement
        if textInputScore(focused) > 0 {
            return focused
        }
    }
    return findComposer(in: window)
}

func composerSnapshot(_ appName: String) -> [String: Any] {
    guard AXIsProcessTrusted() else {
        return ["ok": false, "supported": false, "focused": false, "text": "", "cursor": 0,
                "detail": "尚未获得 macOS 辅助功能权限"]
    }
    guard let app = runningApplication(named: appName) else {
        return ["ok": false, "supported": false, "focused": false, "text": "", "cursor": 0,
                "detail": "未找到正在运行的应用：\(appName)"]
    }
    guard let window = focusedWindow(for: app) else {
        return ["ok": false, "supported": false, "focused": false, "text": "", "cursor": 0,
                "detail": "无法读取 \(appName) 的焦点窗口"]
    }
    guard let composer = focusedComposer(in: window) else {
        if let ocr = ocrComposerSnapshot(app: app, appName: appName) { return ocr }
        return ["ok": false, "supported": false, "focused": false, "text": "", "cursor": 0,
                "detail": "没有找到 \(appName) 的文本输入框"]
    }
    let rawText = axText(composer, kAXValueAttribute as CFString) ?? ""
    let text = String(rawText.prefix(4000))
    let cursor = min(axCursor(composer) ?? text.count, text.count)
    return ["ok": true, "supported": true, "focused": true, "text": text, "cursor": cursor,
            "source": "mac-accessibility", "detail": "已读取 \(appName) 输入框"]
}

func frontWindowID(for pid: pid_t) -> CGWindowID? {
    guard let rawWindows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else { return nil }
    let candidates = rawWindows.compactMap { info -> (CGWindowID, CGFloat)? in
        guard let ownerPID = info[kCGWindowOwnerPID as String] as? Int,
              ownerPID == Int(pid),
              let layer = info[kCGWindowLayer as String] as? Int,
              layer == 0,
              let number = info[kCGWindowNumber as String] as? NSNumber,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds),
              rect.width > 400, rect.height > 250 else { return nil }
        return (CGWindowID(number.uint32Value), rect.width * rect.height)
    }
    return candidates.max(by: { $0.1 < $1.1 })?.0
}

func windowBounds(for windowID: CGWindowID) -> CGRect? {
    guard let rawWindows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else { return nil }
    for info in rawWindows {
        guard let number = info[kCGWindowNumber as String] as? NSNumber,
              CGWindowID(number.uint32Value) == windowID,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary else { continue }
        return CGRect(dictionaryRepresentation: bounds)
    }
    return nil
}

func screenImage() -> CGImage? {
    let path = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("hakimi-ocr-\(UUID().uuidString).png")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-m", path.path]
    do {
        try process.run()
        let deadline = Date().addingTimeInterval(2.0)
        while process.isRunning && Date() < deadline { usleep(50_000) }
        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
            try? FileManager.default.removeItem(at: path)
            return nil
        }
        guard process.terminationStatus == 0,
              let nsImage = NSImage(contentsOf: path),
              let image = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            try? FileManager.default.removeItem(at: path)
            return nil
        }
        try? FileManager.default.removeItem(at: path)
        return image
    } catch {
        try? FileManager.default.removeItem(at: path)
        return nil
    }
}

func windowImage(for windowID: CGWindowID) -> CGImage? {
    // macOS 15 marks CGWindowListCreateImage as obsolete at compile time,
    // although the symbol remains available on the supported desktop builds.
    // Resolve it dynamically so the helper still builds on the current SDK and
    // can capture the Codex window without the bridge window occluding it.
    typealias CreateImage = @convention(c) (CGRect, CGWindowListOption, CGWindowID, CGWindowImageOption) -> CGImage?
    guard let symbol = dlsym(dlopen(nil, RTLD_LAZY), "CGWindowListCreateImage") else { return nil }
    let createImage = unsafeBitCast(symbol, to: CreateImage.self)
    return createImage(.null, .optionIncludingWindow, windowID, [.bestResolution, .boundsIgnoreFraming])
}

func normalizedComposerToken(_ text: String) -> String {
    text.lowercased().filter { $0.isLetter || $0.isNumber }.map(String.init).joined()
}

func isComposerPlaceholder(_ text: String) -> Bool {
    let token = normalizedComposerToken(text)
    if [
        "doanything", "doanythin", "doanythinq", "poanything",
        "oanything", "oanythin", "askanything", "askanythin",
        "输入消息", "输入内容",
    ].contains(token) { return true }
    // Vision occasionally reads the gray leading D as P/O and still keeps
    // the stable "anything" suffix. Treat only these short placeholder-like
    // prefixes as the default; do not discard ordinary user sentences.
    if token.hasSuffix("anything") {
        let prefix = String(token.dropLast("anything".count))
        return ["d", "do", "p", "po", "o", "ask"].contains(prefix)
    }
    return false
}

func ocrComposerText(for app: NSRunningApplication) -> String? {
    guard let windowID = frontWindowID(for: app.processIdentifier),
          let windowCapture = windowImage(for: windowID) else { return nil }

    // The composer is the upper strip of the bottom-center card. OCR over the
    // entire Retina screen made small Chinese glyphs look like Latin fragments
    // (for example, the visible "看就看" was reported as ",YJC"). Crop to the
    // Codex window image first so Vision receives much larger glyphs and none
    // of the conversation/tool labels around it. Capturing the window itself
    // also prevents the bridge window from covering the OCR source.
    let windowRect = CGRect(origin: .zero, size: CGSize(width: windowCapture.width, height: windowCapture.height))
    let composerRect = CGRect(
        x: windowRect.width * 0.22,
        y: windowRect.height * 0.855,
        width: windowRect.width * 0.54,
        height: windowRect.height * 0.095
    ).intersection(windowRect)
    guard composerRect.width > 200,
          composerRect.height > 60,
          let composerImage = windowCapture.cropping(to: composerRect) else { return nil }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.minimumTextHeight = 0.01
    let handler = VNImageRequestHandler(cgImage: composerImage, options: [:])
    do { try handler.perform([request]) } catch { return nil }
    let recognizedLines = (request.results ?? [])
        .sorted { $0.boundingBox.minY > $1.boundingBox.minY }
        .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
    guard !recognizedLines.isEmpty else { return "" }

    // Vision can return the gray placeholder together with a caret/icon, or
    // split it into multiple observations. Filter each observation and then
    // check the combined token as well, so the placeholder never becomes a
    // real draft on the device.
    let combinedToken = normalizedComposerToken(recognizedLines.joined())
    if isComposerPlaceholder(combinedToken) { return "" }
    let lines = recognizedLines.filter { !isComposerPlaceholder($0) }
    return lines.joined(separator: "\n")
}

func ocrComposerSnapshot(app: NSRunningApplication, appName: String) -> [String: Any]? {
    guard let text = ocrComposerText(for: app) else { return nil }
    let bounded = String(text.prefix(4000))
    return [
        "ok": true,
        "supported": true,
        "focused": true,
        "text": bounded,
        "cursor": bounded.count,
        "source": "mac-ocr",
        "detail": "AX 未暴露文本控件，已用只读 OCR 读取 \(appName) 输入框",
    ]
}

func watchComposer(_ appName: String) -> Never {
    var previousSignature = ""
    while true {
        let snapshot = composerSnapshot(appName)
        let signature = [
            String(describing: snapshot["supported"] ?? false),
            String(describing: snapshot["focused"] ?? false),
            String(describing: snapshot["text"] ?? ""),
            String(describing: snapshot["cursor"] ?? 0),
            String(describing: snapshot["source"] ?? ""),
            String(describing: snapshot["detail"] ?? ""),
        ].joined(separator: "|")
        if signature != previousSignature {
            emit(snapshot)
            previousSignature = signature
        }
        let source = String(describing: snapshot["source"] ?? "")
        usleep(source == "mac-ocr" ? 350_000 : 150_000)
    }
}

func clickWindowComposerFallback(_ window: AXUIElement, app: NSRunningApplication) -> Bool {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    var position = CGPoint.zero
    var size = CGSize.zero
    let axHasFrame = AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionValue) == .success
        && AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeValue) == .success
        && positionValue != nil
        && sizeValue != nil
        && AXValueGetValue(positionValue as! AXValue, .cgPoint, &position)
        && AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    if !axHasFrame || size.width <= 200 || size.height <= 160 {
        guard let windowID = frontWindowID(for: app.processIdentifier),
              let bounds = windowBounds(for: windowID) else { return false }
        position = bounds.origin
        size = bounds.size
    }
    guard let source = CGEventSource(stateID: .hidSystemState) else { return false }
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
        if clickWindowComposerFallback(focusedWindowElement, app: app) {
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

final class FloatRingBuffer {
    private let lock = NSLock()
    private var values: [Float]
    private var readIndex = 0
    private var writeIndex = 0
    private var count = 0

    init(capacity: Int) {
        values = Array(repeating: 0, count: capacity)
    }

    func push(_ value: Float) {
        lock.lock()
        values[writeIndex] = value
        writeIndex = (writeIndex + 1) % values.count
        if count == values.count {
            readIndex = (readIndex + 1) % values.count
        } else {
            count += 1
        }
        lock.unlock()
    }

    func pop(into destination: UnsafeMutablePointer<Float>, count requested: Int) -> Int {
        lock.lock()
        let amount = min(requested, count)
        if amount > 0 {
            for index in 0..<amount {
                destination[index] = values[readIndex]
                readIndex = (readIndex + 1) % values.count
            }
            count -= amount
        }
        lock.unlock()
        return amount
    }
}

func audioDeviceID(named query: String) -> AudioDeviceID? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &dataSize
    ) == noErr else { return nil }
    let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.stride
    var devices = Array(repeating: AudioDeviceID(0), count: count)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &dataSize,
        &devices
    ) == noErr else { return nil }
    let needle = query.lowercased()
    for device in devices {
        var name: Unmanaged<CFString>?
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.stride)
        var nameAddress = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = withUnsafeMutablePointer(to: &name) { pointer in
            AudioObjectGetPropertyData(device, &nameAddress, 0, nil, &nameSize, pointer)
        }
        guard status == noErr, let name else { continue }
        let value = name.takeUnretainedValue() as String
        if value.lowercased() == needle || value.lowercased().contains(needle) {
            return device
        }
    }
    return nil
}

func setCurrentOutputDevice(_ device: AudioDeviceID, on outputNode: AVAudioOutputNode) -> OSStatus {
    guard let audioUnit = outputNode.audioUnit else { return -1 }
    var device = device
    return AudioUnitSetProperty(
        audioUnit,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &device,
        UInt32(MemoryLayout<AudioDeviceID>.stride)
    )
}

func setDefaultInputDevice(named query: String) {
    guard let device = audioDeviceID(named: query) else {
        fail("找不到 macOS 输入设备：\(query)")
    }
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var selected = device
    let status = AudioObjectSetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        UInt32(MemoryLayout<AudioDeviceID>.stride),
        &selected
    )
    guard status == noErr else {
        fail("无法设置默认输入设备为 \(query)，OSStatus=\(status)")
    }
    emit(["ok": true, "device": query, "detail": "系统默认输入已切换到 \(query)"])
}

func startAudioSink(_ deviceName: String) -> Never {
    guard let device = audioDeviceID(named: deviceName) else {
        fail("找不到 macOS 音频设备：\(deviceName)。请先安装 BlackHole 2ch，或设置 HAKIMI_VIRTUAL_MIC")
    }
    // BlackHole normally exposes a 48 kHz CoreAudio device while the ESP32
    // serial stream is 16 kHz.  Feed the source node at the hardware rate and
    // expand each serial sample three times so the virtual input receives
    // actual PCM instead of an empty/mismatched render stream.
    guard let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 48_000,
        channels: 1,
        interleaved: false
    ) else { fail("无法创建 48 kHz 音频格式") }

    let ring = FloatRingBuffer(capacity: 16_000 * 2)
    let engine = AVAudioEngine()
    let source = AVAudioSourceNode(format: format) { _, _, frameCount, audioBufferList in
        let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
        for buffer in buffers {
            guard let data = buffer.mData else { continue }
            let destination = data.assumingMemoryBound(to: Float.self)
            let frames = min(Int(frameCount), Int(buffer.mDataByteSize) / MemoryLayout<Float>.stride)
            let copied = ring.pop(into: destination, count: frames)
            if copied < frames {
                destination.advanced(by: copied).initialize(repeating: 0, count: frames - copied)
            }
        }
        return noErr
    }
    engine.attach(source)
    engine.connect(source, to: engine.mainMixerNode, format: format)
    let deviceStatus = setCurrentOutputDevice(device, on: engine.outputNode)
    guard deviceStatus == noErr else {
        fail("无法把 CoreAudio 输出切到 \(deviceName)，OSStatus=\(deviceStatus)")
    }
    do {
        try engine.start()
    } catch {
        fail("启动 CoreAudio 音频输出失败：\(error.localizedDescription)")
    }
    emit(["ok": true, "ready": true, "detail": "CoreAudio 已输出到 \(deviceName)，等待串口 PCM"])

    // SerialAudioSink writes little-endian signed 16-bit samples. Keep one
    // possible odd byte between reads so a USB/serial chunk boundary cannot
    // shift the sample alignment.
    var pending = Data()
    while true {
        let incoming = FileHandle.standardInput.readData(ofLength: 8192)
        if incoming.isEmpty { break }
        pending.append(incoming)
        let usable = pending.count - (pending.count % 2)
        if usable == 0 { continue }
        pending.withUnsafeBytes { raw in
            guard let bytes = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            for offset in stride(from: 0, to: usable, by: 2) {
                let bits = UInt16(bytes[offset]) | (UInt16(bytes[offset + 1]) << 8)
                let sample = Int16(bitPattern: bits)
                let value = Float(sample) / 32_768.0
                ring.push(value)
                ring.push(value)
                ring.push(value)
            }
        }
        pending.removeFirst(usable)
    }
    engine.stop()
    exit(0)
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
case "watch-composer":
    guard args.count >= 2 else { fail("watch-composer 缺少应用名") }
    watchComposer(args[1])
case "key":
    guard args.count >= 3 else { fail("key 需要按键名和 down/up/tap") }
    sendKey(args[1], args[2])
case "command-tab":
    sendCommandTab()
case "audio-sink":
    startAudioSink(args.count >= 2 ? args[1] : "BlackHole 2ch")
case "set-default-input":
    setDefaultInputDevice(named: args.count >= 2 ? args[1] : "BlackHole 2ch")
default:
    fail("未知命令：\(command)")
}
