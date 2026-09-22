import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  activateApp,
  accessibilityTrusted,
  commandTab,
  focusCodexWindow,
  listAudioInputs,
  postKey,
  watchAgentComposer,
  type ComposerSnapshot,
} from './macos';
import { AgentRegistry } from './agent-adapter';
import { boostPcmForVirtualMic, DEFAULT_VIRTUAL_MIC_GAIN, SerialAudioSink } from './audio';
import { identifyP4Chip } from './firmware';
import {
  KeyboardlessVoiceAutomation,
  type VoiceAutomationEvent,
} from './voice-automation';
import {
  encodeMessage,
  parseMessage,
  type AudioMeter,
  type AudioPcmPayload,
  type BridgeState,
  type DeviceMessage,
  type DevicePortInfo,
  type InputDraft,
} from './protocol';

let windowRef: BrowserWindow | undefined;

class HakimiSerial {
  private port?: SerialPort;
  private parser?: ReadlineParser;
  private current?: DevicePortInfo;

  async list(): Promise<DevicePortInfo[]> {
    const ports = await SerialPort.list();
    return ports
      .filter((port) => port.path.startsWith('/dev/cu.') || port.path.startsWith('/dev/tty.') || port.path.startsWith('COM'))
      .map((port) => ({
        // macOS serialport commonly enumerates the tty sibling while esptool
        // and interactive applications prefer the cu sibling.
        path: port.path.startsWith('/dev/tty.')
          && existsSync(port.path.replace('/dev/tty.', '/dev/cu.'))
          ? port.path.replace('/dev/tty.', '/dev/cu.')
          : port.path,
        manufacturer: port.manufacturer,
        serialNumber: port.serialNumber,
        vendorId: port.vendorId,
        productId: port.productId,
        friendlyName: [port.manufacturer, port.vendorId && `VID:${port.vendorId}`, port.path]
          .filter(Boolean)
          .join(' · '),
      }));
  }

  async connect(path: string): Promise<DevicePortInfo> {
    await this.disconnect();
    const match = (await this.list()).find((port) => port.path === path);
    if (!match) throw new Error(`串口不存在: ${path}`);
    const port = new SerialPort({ path, baudRate: 4_000_000, autoOpen: false });
    await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
    this.port = port;
    this.current = match;
    this.parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    this.parser.on('data', (line: string) => {
      const message = parseMessage(line);
      if (message) {
        // PCM packets can be several kilobytes per second. Do not copy their
        // Base64 body into the UI log or the bridge state snapshot.
        if (message.topic !== 'audio/pcm') {
          lastMessage = message;
          broadcast('device-message', message);
        }
        void handleDeviceMessage(message);
      }
      else broadcast('serial-line', String(line).slice(0, 500));
    });
    port.on('error', (error) => broadcast('bridge-error', error.message));
    port.on('close', () => {
      // A reconnect may come from an older image without WakeNet. Do not keep
      // the previous board's wake-word mode after the serial port disappears.
      deviceWakeWordReady = false;
      deviceWakeWordModel = undefined;
      keyboardlessVoice.setMode('vad-fallback');
      broadcast('device-disconnected', this.current);
    });
    this.send({ topic: 'bridge/hello', payload: { protocol: 'hakimi-agent-bridge-v1', tsMs: Date.now() } });
    // The board may have booted before Electron connects, so query the
    // current microphone/WakeNet state instead of relying only on the
    // one-shot audio/status message emitted during boot.
    this.send({ topic: 'audio/query', payload: { source: 'bridge-connect' } });
    return match;
  }

  async disconnect(): Promise<void> {
    const port = this.port;
    this.port = undefined;
    this.parser = undefined;
    this.current = undefined;
    if (port?.isOpen) await new Promise<void>((resolve) => port.close(() => resolve()));
  }

  send(message: DeviceMessage): void {
    if (!this.port?.isOpen) throw new Error('设备串口尚未连接');
    this.port.write(encodeMessage(message));
  }

  isConnected(): boolean {
    return Boolean(this.port?.isOpen);
  }

  info(): DevicePortInfo | undefined {
    return this.current;
  }

  trySend(message: DeviceMessage): boolean {
    if (!this.port?.isOpen) return false;
    this.port.write(encodeMessage(message));
    return true;
  }
}

const serial = new HakimiSerial();
const agents = new AgentRegistry();
let lastMessage: DeviceMessage | undefined;
let lastError: string | undefined;
let voiceKeyDown = false;
let audioMonitor = false;
let keyboardlessVoiceEnabled = process.env.HAKIMI_AUTO_VOICE !== '0';
const keyboardlessVoice = new KeyboardlessVoiceAutomation();
if (keyboardlessVoiceEnabled) keyboardlessVoice.enable();
let keyboardlessVoicePending = false;
let keyboardlessFocusPromise: ReturnType<typeof focusCodexWindow> | undefined;
let keyboardlessLastEvent: string | undefined;
let keyboardlessVoiceKeyDown = false;
let deviceWakeWordReady = false;
let deviceWakeWordModel: string | undefined;
let lastDeviceAgentKey = '';
let audioInputsCache: Awaited<ReturnType<typeof listAudioInputs>> = [];
let audioInputsCachedAt = 0;
let chipIdentity: Awaited<ReturnType<typeof identifyP4Chip>> | undefined;
let audioFramesReceived = 0;
let audioFramesForwarded = 0;
let audioFramesDropped = 0;
let audioLastPacketAt: number | undefined;
let audioLastRms = 0;
let audioLastPeak = 0;
let audioMeterBroadcastAt = 0;
let inputDraft: InputDraft | undefined;
let composerSnapshot: ComposerSnapshot | undefined;
let composerSignature = '';
let inputDraftRevision = 0;
let stopComposerWatcher: (() => void) | undefined;
let stopVoiceAutomationTicker: (() => void) | undefined;
const audioSink = new SerialAudioSink((line) => broadcast('serial-audio-line', line));
const virtualMicGain = Number.isFinite(Number(process.env.HAKIMI_VIRTUAL_MIC_GAIN))
  ? Number(process.env.HAKIMI_VIRTUAL_MIC_GAIN)
  : DEFAULT_VIRTUAL_MIC_GAIN;

function broadcast(channel: string, payload: unknown): void {
  for (const target of BrowserWindow.getAllWindows()) target.webContents.send(channel, payload);
}

async function state(): Promise<BridgeState> {
  const snapshots = await agents.snapshots();
  if (Date.now() - audioInputsCachedAt > 4000) {
    audioInputsCache = await listAudioInputs();
    audioInputsCachedAt = Date.now();
  }
  const hasBlackHole = audioInputsCache.some((item) => /blackhole/i.test(item.name));
  const sinkStats = audioSink.stats();
  return {
    connected: serial.isConnected(),
    port: serial.info(),
    chip: chipIdentity,
    audioMode: 'serial-blackhole',
    audioInputs: audioInputsCache,
    audioDeviceHint: hasBlackHole
      ? `${sinkStats.deviceName} 已被 macOS 识别；点击音频测试即可转发串口麦克风`
      : '未发现 BlackHole 2ch；请安装后再点击音频测试',
    audioForwarding: voiceKeyDown || audioMonitor || keyboardlessVoicePending,
    audioFramesReceived,
    audioFramesForwarded,
    audioFramesDropped,
    audioLastPacketAt,
    audioLastRms,
    audioLastPeak,
    voiceAutomation: {
      enabled: keyboardlessVoiceEnabled,
      phase: keyboardlessVoice.getPhase(),
      mode: deviceWakeWordReady ? 'wake-word-pending' : 'vad-fallback',
      lastEvent: keyboardlessLastEvent,
    },
    accessibilityTrusted: await accessibilityTrusted(),
    codexRunning: snapshots.some((item) => item.agentId === 'codex' && item.state !== 'idle'),
    snapshots,
    inputDraft,
    lastDeviceEvent: lastMessage,
    lastError,
  };
}

async function publishState(): Promise<void> {
  const current = await state();
  broadcast('bridge-state', current);
  await syncAgentToDevice(current.snapshots);
  sendInputDraftToDevice(inputDraft);
}

function sendInputDraftToDevice(draft: InputDraft | undefined): void {
  // An unavailable Accessibility snapshot is not an empty composer. Do not
  // let the periodic state publication erase a valid draft/test message that
  // was already shown on the device. A supported empty draft still clears it.
  if (!draft || draft.status === 'unavailable') return;
  serial.trySend({
    topic: 'ui/input-draft',
    payload: {
      text: draft.text,
      cursor: draft.cursor,
      revision: draft.revision,
      status: draft.status,
      source: draft.source,
      updatedAt: draft.updatedAt,
    },
  });
}

function clearStaleDraftOnDeviceConnect(): void {
  // A freshly started bridge has no Accessibility snapshot yet. Clear only
  // in that explicit reconnect case so an old automated-smoke string cannot
  // survive on the device; periodic "unavailable" polling still preserves a
  // valid draft already shown on screen.
  if (inputDraft) return;
  serial.trySend({
    topic: 'ui/input-draft',
    payload: {
      text: '',
      cursor: 0,
      revision: 0,
      status: 'ready',
      source: 'bridge-connect-reset',
      updatedAt: Date.now(),
    },
  });
}

function applyComposerSnapshot(next: ComposerSnapshot): void {
  composerSnapshot = next;
  const status: InputDraft['status'] = next.supported ? (voiceKeyDown ? 'composing' : 'ready') : 'unavailable';
  const text = next.supported && typeof next.text === 'string' ? next.text : '';
  const cursor = Math.max(0, Math.min(Number(next.cursor || 0), text.length));
  const signature = [status, text, cursor, next.detail || ''].join('|');
  if (signature === composerSignature) return;
  if (text !== inputDraft?.text || cursor !== inputDraft?.cursor) inputDraftRevision += 1;
  composerSignature = signature;
  inputDraft = {
    text,
    cursor,
    revision: inputDraftRevision,
    source: next.supported ? (next.source || 'mac-accessibility') : 'unknown',
    status,
    updatedAt: Date.now(),
    detail: next.detail,
  };
  broadcast('input-draft', inputDraft);
  sendInputDraftToDevice(inputDraft);
}

function refreshComposerStatus(): void {
  if (composerSnapshot) applyComposerSnapshot(composerSnapshot);
}

function messageText(snapshot: BridgeState['snapshots'][number]): string {
  const body = (snapshot.summary || snapshot.lastLog || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    // These separators are not needed on the device and some are absent from
    // its CJK font, where they render as a square/garbled glyph.
    .replace(/[·•▪◦\uFFFD\u25A1]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.slice(0, 200) || '暂无新的 Agent 输出';
}

async function syncAgentToDevice(snapshots: BridgeState['snapshots']): Promise<void> {
  const snapshot = snapshots.find((item) => item.agentId !== 'bridge') || snapshots[0];
  if (!snapshot) return;
  const key = [snapshot.agentId, snapshot.sessionId, snapshot.state, snapshot.title, messageText(snapshot)].join('|');
  if (key === lastDeviceAgentKey) return;
  lastDeviceAgentKey = key;
  serial.trySend({
    topic: 'speech/text',
    payload: {
      sessionId: snapshot.sessionId || `bridge-${snapshot.agentId}`,
      title: snapshot.title || snapshot.agentName,
      body: messageText(snapshot),
      status: snapshot.state,
      statusText: snapshot.stage || snapshot.state,
      source: 'hakimi-agent-bridge',
    },
  });
}

function normalizedEvent(payload: Record<string, unknown>): string {
  return String(payload.event || payload.action || '').toLowerCase();
}

function gesture(payload: Record<string, unknown>): string {
  return String(payload.gesture || payload.phase || '').toLowerCase();
}

async function beginVoiceInput(
  focusPromise?: ReturnType<typeof focusCodexWindow>,
  source: 'physical' | 'keyboardless' = 'physical',
): Promise<void> {
  const focus = await (focusPromise || focusCodexWindow('Codex'));
  if (!focus.focused) lastError = focus.detail;
  if (voiceKeyDown) return;
  const key = await postKey('fn', 'down');
  voiceKeyDown = key.ok;
  keyboardlessVoiceKeyDown = source === 'keyboardless' && key.ok;
  refreshComposerStatus();
  broadcast('bridge-action', { type: 'voice', phase: 'start', detail: `${focus.detail}；${key.detail}` });
  await publishState();
}

function sendVoiceStatus(body: string, status: 'listening' | 'working' | 'done' | 'waiting_user'): void {
  serial.trySend({
    topic: 'speech/text',
    payload: {
      sessionId: 'keyboardless-voice',
      title: 'HAKIMI VOICE',
      body,
      status,
      statusText: status,
      source: 'keyboardless-voice-automation',
    },
  });
}

async function handleKeyboardlessVoiceEvent(event: VoiceAutomationEvent): Promise<void> {
  keyboardlessLastEvent = event.type;
  broadcast('bridge-action', {
    type: 'voice-automation',
    phase: event.type,
    detail: event.type === 'wake-detected'
      ? `VAD 唤醒候选，片段 ${event.durationMs}ms`
      : event.type,
  });

  if (event.type === 'wake-detected') {
    // Focus the target window and press Fn immediately after WakeNet fires.
    // Waiting until command-start is too late: the first syllables of the
    // user's command arrive before Doubao has entered listening mode.
    keyboardlessFocusPromise = focusCodexWindow('Codex');
    await beginVoiceInput(keyboardlessFocusPromise, 'keyboardless');
    sendVoiceStatus(event.mode === 'wake-word' ? '已唤醒，请说话' : '请说话', 'waiting_user');
    await publishState();
    return;
  }
  if (event.type === 'command-start') {
    await beginVoiceInput(keyboardlessFocusPromise);
    sendVoiceStatus('正在听取', 'working');
    await publishState();
    return;
  }
  if (event.type === 'command-end') {
    await endVoiceInput();
    keyboardlessVoicePending = false;
    keyboardlessFocusPromise = undefined;
    sendVoiceStatus('语音已提交', 'done');
    await publishState();
    return;
  }
  if (event.type === 'command-timeout') {
    await endVoiceInput();
    keyboardlessFocusPromise = undefined;
    sendVoiceStatus('等待唤醒', 'listening');
    await publishState();
  }
}

async function setKeyboardlessVoice(enabled: boolean): Promise<{ ok: boolean; detail: string }> {
  keyboardlessVoiceEnabled = enabled;
  keyboardlessVoicePending = false;
  keyboardlessFocusPromise = undefined;
  if (enabled) {
    keyboardlessVoice.enable();
    const detail = deviceWakeWordReady
      ? `已启用免键盘语音：等待板端唤醒词 ${deviceWakeWordModel || ''}`.trim()
      : '已启用免键盘语音：等待 VAD 唤醒候选';
    broadcast('bridge-action', { type: 'voice-automation', phase: 'enabled', detail });
    await publishState();
    return { ok: true, detail };
  }
  keyboardlessVoice.disable();
  await endVoiceInput();
  const detail = '已停用免键盘语音';
  broadcast('bridge-action', { type: 'voice-automation', phase: 'disabled', detail });
  await publishState();
  return { ok: true, detail };
}

async function endVoiceInput(): Promise<void> {
  if (!voiceKeyDown) return;
  const key = await postKey('fn', 'up');
  voiceKeyDown = false;
  keyboardlessVoiceKeyDown = false;
  refreshComposerStatus();
  broadcast('bridge-action', { type: 'voice', phase: 'end', detail: key.detail });
  await publishState();
}

function shouldForwardAudio(): boolean {
  // A keyboardless session presses Fn at wake time, but must not forward the
  // wake phrase or the pause after it. Forward only after command-start.
  const physicalVoiceKeyDown = voiceKeyDown && !keyboardlessVoiceKeyDown;
  return physicalVoiceKeyDown || audioMonitor || keyboardlessVoicePending;
}

function publishAudioMeter(): void {
  const now = Date.now();
  if (now - audioMeterBroadcastAt < 150) return;
  audioMeterBroadcastAt = now;
  const meter: AudioMeter = {
    received: audioFramesReceived > 0,
    rms: audioLastRms,
    peak: audioLastPeak,
    framesReceived: audioFramesReceived,
    framesForwarded: audioFramesForwarded,
    framesDropped: audioFramesDropped,
    packetAt: audioLastPacketAt,
  };
  broadcast('audio-meter', meter);
}

async function startAudioMonitor(): Promise<{ ok: boolean; detail: string }> {
  audioMonitor = true;
  try {
    await audioSink.start();
    const detail = `已开始串口音频测试：${audioSink.stats().deviceName}；请在豆包中选择该输入设备`;
    broadcast('bridge-action', { type: 'audio', phase: 'start', detail });
    await publishState();
    return { ok: true, detail };
  } catch (error) {
    audioMonitor = false;
    lastError = error instanceof Error ? error.message : String(error);
    broadcast('bridge-error', lastError);
    await publishState();
    return { ok: false, detail: lastError };
  }
}

async function stopAudioMonitor(): Promise<{ ok: boolean; detail: string }> {
  audioMonitor = false;
  if (!voiceKeyDown) await audioSink.stop();
  const detail = '已停止串口音频测试';
  broadcast('bridge-action', { type: 'audio', phase: 'stop', detail });
  await publishState();
  return { ok: true, detail };
}

function handleAudioPcm(message: DeviceMessage): void {
  const payload = message.payload as Partial<AudioPcmPayload> | undefined;
  if (!payload || typeof payload.dataBase64 !== 'string') return;
  if (payload.encoding !== 's16le' || payload.sampleRate !== 16_000 || payload.channels !== 1) {
    lastError = '收到不支持的串口音频格式：需要 16 kHz / 单声道 / s16le';
    return;
  }
  audioFramesReceived += 1;
  audioLastPacketAt = Date.now();
  let pcm: Buffer;
  try {
    pcm = Buffer.from(payload.dataBase64, 'base64');
  } catch {
    audioFramesDropped += 1;
    publishAudioMeter();
    return;
  }
  let sumSquares = 0;
  let peak = 0;
  const sampleCount = Math.floor(pcm.length / 2);
  for (let offset = 0; offset < sampleCount; offset += 1) {
    const sample = Math.abs(pcm.readInt16LE(offset * 2));
    sumSquares += sample * sample;
    if (sample > peak) peak = sample;
  }
  audioLastRms = sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0;
  audioLastPeak = peak;
  publishAudioMeter();
  const automationFeed = keyboardlessVoiceEnabled
    ? keyboardlessVoice.feed(pcm, Date.now())
    : undefined;
  if (automationFeed) {
    for (const event of automationFeed.events) {
      if (event.type === 'command-start') keyboardlessVoicePending = true;
      void handleKeyboardlessVoiceEvent(event);
    }
  }
  if (!shouldForwardAudio() && !automationFeed?.forward) return;
  void audioSink.start().then(() => {
    if (!shouldForwardAudio()) return;
    const writeFrame = (frame: Buffer): void => {
      if (audioSink.write(boostPcmForVirtualMic(frame, virtualMicGain))) audioFramesForwarded += 1;
      else audioFramesDropped += 1;
    };
    // Include the short pre-roll collected after WakeNet fired so the first
    // syllables are not lost while the native CoreAudio sink starts.
    for (const event of automationFeed?.events || []) {
      if (event.type === 'command-start') {
        for (const frame of event.preRoll) writeFrame(frame);
      }
    }
    writeFrame(pcm);
    publishAudioMeter();
  }).catch((error) => {
    audioFramesDropped += 1;
    lastError = error instanceof Error ? error.message : String(error);
    broadcast('bridge-error', lastError);
    publishAudioMeter();
  });
}

function handleWakeWordMessage(message: DeviceMessage): void {
  if (!keyboardlessVoiceEnabled || !deviceWakeWordReady) return;
  const event = keyboardlessVoice.triggerWake(Date.now());
  if (event) void handleKeyboardlessVoiceEvent(event);
}

function startVoiceAutomationTicker(): void {
  const timer = setInterval(() => {
    if (!keyboardlessVoiceEnabled) return;
    for (const event of keyboardlessVoice.tick(Date.now())) {
      void handleKeyboardlessVoiceEvent(event);
    }
  }, 100);
  stopVoiceAutomationTicker = () => clearInterval(timer);
}

async function handleDeviceMessage(message: DeviceMessage): Promise<void> {
  if (message.topic === 'audio/pcm') {
    handleAudioPcm(message);
    return;
  }
  if (message.topic === 'audio/status') {
    const payload = message.payload || {};
    if (payload.wakeWord === true) {
      deviceWakeWordReady = true;
      deviceWakeWordModel = typeof payload.wakeWordModel === 'string' ? payload.wakeWordModel : undefined;
      keyboardlessVoice.setMode('wake-word');
    } else if (payload.wakeWord === false) {
      deviceWakeWordReady = false;
      deviceWakeWordModel = undefined;
      keyboardlessVoice.setMode('vad-fallback');
    }
    broadcast('device-message', message);
    await publishState();
    return;
  }
  if (message.topic === 'audio/wake') {
    handleWakeWordMessage(message);
    return;
  }
  if (message.topic !== 'input/event' || !message.payload) return;
  const payload = message.payload;
  const event = normalizedEvent(payload);
  const currentGesture = gesture(payload);
  const action = String(payload.action || '').toLowerCase();
  const isVoice = action === 'voice_ptt' || event === 'button.sw1.hold' || event === 'voice_ptt';
  if (isVoice && (currentGesture === 'hold_start' || currentGesture === 'start')) {
    await beginVoiceInput();
    return;
  }
  if (isVoice && (currentGesture === 'hold_end' || currentGesture === 'end' || currentGesture === 'release')) {
    await endVoiceInput();
    return;
  }

  let result: { ok: boolean; detail: string } | undefined;
  if (event === 'joystick.left' || event === 'knob.rotate_ccw') result = await postKey('left', 'tap');
  else if (event === 'joystick.right' || event === 'knob.rotate_cw') result = await postKey('right', 'tap');
  else if (event === 'joystick.up') result = await postKey('up', 'tap');
  else if (event === 'joystick.down') result = await postKey('down', 'tap');
  else if (event === 'joystick.center.short_press' || event === 'button.encoder.short_press') result = await postKey('enter', 'tap');
  else if (event === 'button.sw2.short_press') result = await postKey('backspace', 'tap');
  else if (event === 'button.sw3.short_press') result = await postKey('enter', 'tap');
  else if (action === 'agent_enter') result = await postKey('enter', 'tap');
  if (result) broadcast('bridge-action', { type: 'input', event, detail: result.detail });
}

function registerIpc(): void {
  ipcMain.handle('ports:list', () => serial.list());
  ipcMain.handle('bridge:state', () => state());
  ipcMain.handle('firmware:chip-info', async (_event, path: string) => {
    if (serial.isConnected()) throw new Error('请先断开串口，再读取芯片版本');
    chipIdentity = await identifyP4Chip(path);
    await publishState();
    return chipIdentity;
  });
  ipcMain.handle('mac:audio-inputs', async () => {
    audioInputsCache = await listAudioInputs();
    audioInputsCachedAt = Date.now();
    return audioInputsCache;
  });
  ipcMain.handle('device:connect', async (_event, path: string) => {
    const port = await serial.connect(path);
    clearStaleDraftOnDeviceConnect();
    await publishState();
    return port;
  });
  ipcMain.handle('device:disconnect', async () => {
    await serial.disconnect();
    await publishState();
  });
  ipcMain.handle('device:send', async (_event, message: DeviceMessage) => {
    serial.send(message);
  });
  ipcMain.handle('mac:focus-agent', async (_event, appName?: string) => {
    const result = await focusCodexWindow(appName || 'Codex');
    if (!result.focused) lastError = result.detail;
    await publishState();
    return result;
  });
  ipcMain.handle('mac:activate', async (_event, appName: string) => {
    await activateApp(appName);
  });
  ipcMain.handle('mac:key', (_event, name: string, phase: 'down' | 'up' | 'tap') => postKey(name, phase));
  ipcMain.handle('mac:command-tab', () => commandTab());
  ipcMain.handle('audio:test-start', () => startAudioMonitor());
  ipcMain.handle('audio:test-stop', () => stopAudioMonitor());
  ipcMain.handle('voice:auto', (_event, enabled: boolean) => setKeyboardlessVoice(Boolean(enabled)));
  ipcMain.handle('app:open-docs', () => shell.openExternal('https://github.com/YizhengWw/HachimoDock'));
}

function createWindow(): void {
  windowRef = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: 'Hakimi Agent Bridge',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  windowRef.loadFile(join(__dirname, 'index.html'));
}

async function autoConnectHakimi(): Promise<void> {
  const devices = await serial.list();
  // The Hakimi ESP32-P4 board uses the CH343 USB serial bridge. Restrict the
  // automatic connection to that known VID/PID so another serial device is
  // never opened just because it happens to be present at startup.
  const candidate = devices.find((port) => {
    const vendor = port.vendorId?.toLowerCase();
    const product = port.productId?.toLowerCase();
    return vendor === '1a86' && product === '55d3';
  });
  if (!candidate) return;
  try {
    await serial.connect(candidate.path);
    clearStaleDraftOnDeviceConnect();
  } catch (error) {
    lastError = `自动连接 Hakimi 失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

app.whenReady().then(() => {
  registerIpc();
  stopComposerWatcher = watchAgentComposer('Codex', applyComposerSnapshot, (detail) => {
    if (!lastError) lastError = detail;
  });
  startVoiceAutomationTicker();
  createWindow();
  void autoConnectHakimi().then(() => publishState());
  setInterval(() => void publishState(), 2500);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopComposerWatcher?.();
  stopVoiceAutomationTicker?.();
  void audioSink.stop();
});

process.on('uncaughtException', (error) => {
  lastError = error.message;
  broadcast('bridge-error', error.message);
});

// Keep the first hardware loop intentionally transparent: every event is
// visible in the UI before we add destructive key mappings.
process.on('unhandledRejection', (error) => {
  lastError = error instanceof Error ? error.message : String(error);
  broadcast('bridge-error', lastError);
});
