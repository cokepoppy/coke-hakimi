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
} from './macos';
import { AgentRegistry } from './agent-adapter';
import { identifyP4Chip } from './firmware';
import {
  encodeMessage,
  parseMessage,
  type BridgeState,
  type DeviceMessage,
  type DevicePortInfo,
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
        lastMessage = message;
        broadcast('device-message', message);
        void handleDeviceMessage(message);
      }
      else broadcast('serial-line', String(line).slice(0, 500));
    });
    port.on('error', (error) => broadcast('bridge-error', error.message));
    port.on('close', () => broadcast('device-disconnected', this.current));
    this.send({ topic: 'bridge/hello', payload: { protocol: 'hakimi-agent-bridge-v1', tsMs: Date.now() } });
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
let lastDeviceAgentKey = '';
let audioInputsCache: Awaited<ReturnType<typeof listAudioInputs>> = [];
let audioInputsCachedAt = 0;
let chipIdentity: Awaited<ReturnType<typeof identifyP4Chip>> | undefined;

function broadcast(channel: string, payload: unknown): void {
  for (const target of BrowserWindow.getAllWindows()) target.webContents.send(channel, payload);
}

async function state(): Promise<BridgeState> {
  const snapshots = await agents.snapshots();
  if (Date.now() - audioInputsCachedAt > 4000) {
    audioInputsCache = await listAudioInputs();
    audioInputsCachedAt = Date.now();
  }
  const hasHakimiMicrophone = audioInputsCache.some((item) => /hakimi microphone/i.test(item.name));
  return {
    connected: serial.isConnected(),
    port: serial.info(),
    chip: chipIdentity,
    audioMode: 'native-uac',
    audioInputs: audioInputsCache,
    audioDeviceHint: hasHakimiMicrophone
      ? 'Hakimi Microphone 已被 macOS 识别'
      : '未发现 Hakimi Microphone；请先刷入 UAC 固件并切到原生 USB',
    accessibilityTrusted: await accessibilityTrusted(),
    codexRunning: snapshots.some((item) => item.agentId === 'codex' && item.state !== 'idle'),
    snapshots,
    lastDeviceEvent: lastMessage,
    lastError,
  };
}

async function publishState(): Promise<void> {
  const current = await state();
  broadcast('bridge-state', current);
  await syncAgentToDevice(current.snapshots);
}

function messageText(snapshot: BridgeState['snapshots'][number]): string {
  return [snapshot.stage, snapshot.summary || snapshot.lastLog].filter(Boolean).join(' · ').slice(0, 180)
    || '暂无新的 Agent 输出';
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

async function beginVoiceInput(): Promise<void> {
  const focus = await focusCodexWindow('Codex');
  if (!focus.focused) lastError = focus.detail;
  if (voiceKeyDown) return;
  const key = await postKey('fn', 'down');
  voiceKeyDown = key.ok;
  broadcast('bridge-action', { type: 'voice', phase: 'start', detail: `${focus.detail}；${key.detail}` });
  await publishState();
}

async function endVoiceInput(): Promise<void> {
  if (!voiceKeyDown) return;
  const key = await postKey('fn', 'up');
  voiceKeyDown = false;
  broadcast('bridge-action', { type: 'voice', phase: 'end', detail: key.detail });
  await publishState();
}

async function handleDeviceMessage(message: DeviceMessage): Promise<void> {
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
  else if (event === 'button.sw3.short_press') result = await commandTab();
  else if (action === 'agent_enter' || action === 'agent_prompt') result = await postKey('enter', 'tap');
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

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  void publishState();
  setInterval(() => void publishState(), 2500);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
