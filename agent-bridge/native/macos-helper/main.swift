import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import AVFoundation
import AudioToolbox

// Small, dependency-free macOS primitive used by the Electron bridge. The
// helper deliberately exposes small focus, keyboard, and CoreAudio operations.
// Raw PCM is kept out of Electron's renderer and is consumed by a native
// CoreAudio source node when the serial-blackhole path is active.

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

func startAudioSink(_ deviceName: String) -> Never {
    guard let device = audioDeviceID(named: deviceName) else {
        fail("找不到 macOS 音频设备：\(deviceName)。请先安装 BlackHole 2ch，或设置 HAKIMI_VIRTUAL_MIC")
    }
    guard let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
    ) else { fail("无法创建 16 kHz 音频格式") }

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
                ring.push(Float(sample) / 32_768.0)
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
case "key":
    guard args.count >= 3 else { fail("key 需要按键名和 down/up/tap") }
    sendKey(args[1], args[2])
case "command-tab":
    sendCommandTab()
case "audio-sink":
    startAudioSink(args.count >= 2 ? args[1] : "BlackHole 2ch")
default:
    fail("未知命令：\(command)")
}
