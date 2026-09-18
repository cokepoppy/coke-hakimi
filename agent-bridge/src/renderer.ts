import type { AudioInputInfo, AudioMeter, BridgeState, ChipIdentity, DeviceMessage, DevicePortInfo } from './protocol';

declare global {
  interface Window {
    hakimiBridge: {
      listPorts(): Promise<DevicePortInfo[]>;
      getState(): Promise<BridgeState>;
      listAudioInputs(): Promise<AudioInputInfo[]>;
      identifyChip(path: string): Promise<ChipIdentity>;
      connect(path: string): Promise<DevicePortInfo>;
      disconnect(): Promise<void>;
      send(message: DeviceMessage): Promise<void>;
      focusAgent(appName?: string): Promise<{ focused: boolean; detail: string }>;
      activate(appName: string): Promise<void>;
      key(name: string, phase: 'down' | 'up' | 'tap'): Promise<{ ok: boolean; detail: string }>;
      commandTab(): Promise<{ ok: boolean; detail: string }>;
      startAudioTest(): Promise<{ ok: boolean; detail: string }>;
      stopAudioTest(): Promise<{ ok: boolean; detail: string }>;
      openDocs(): Promise<void>;
      onState(callback: (state: BridgeState) => void): () => void;
      onAudioMeter(callback: (meter: AudioMeter) => void): () => void;
      onDeviceMessage(callback: (message: DeviceMessage) => void): () => void;
      onSerialLine(callback: (line: string) => void): () => void;
      onSerialAudioLine(callback: (line: string) => void): () => void;
      onError(callback: (message: string) => void): () => void;
      onAction(callback: (action: { type: string; phase?: string; event?: string; detail: string }) => void): () => void;
    };
  }
}

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const ports = $('#ports') as HTMLSelectElement;
const logs = $('#logs');
const stateSummary = $('#state-summary');
const chipStatus = $('#chip-status');
const agentList = $('#agent-list');
const audioStatus = $('#audio-status');
const audioInputs = $('#audio-inputs');
const audioReceiveStatus = $('#audio-receive-status');
const audioMeterValues = $('#audio-meter-values');
const audioMeterFill = $('#audio-meter-fill') as HTMLDivElement;
const audioMeterMeta = $('#audio-meter-meta');
const a11yStatus = $('#a11y-status');
const result = $('#result');

function log(line: string): void {
  const item = document.createElement('div');
  item.className = 'log-line';
  item.textContent = `${new Date().toLocaleTimeString()}  ${line}`;
  logs.prepend(item);
  while (logs.children.length > 80) logs.lastElementChild?.remove();
}

function render(state: BridgeState): void {
  stateSummary.textContent = state.connected
    ? `设备已连接 · ${state.port?.path ?? 'unknown'}`
    : '设备未连接';
  stateSummary.className = `connection ${state.connected ? 'online' : 'offline'}`;
  chipStatus.textContent = state.chip
    ? `${state.chip.chip} ${state.chip.revisionText} · 选择 ${state.chip.family.toUpperCase()}`
    : '尚未读取芯片版本';
  chipStatus.className = `status-chip ${state.chip?.family === 'v3' ? 'online' : 'pending'}`;
  const blackHole = state.audioInputs.find((item) => /blackhole/i.test(item.name));
  audioStatus.textContent = state.audioForwarding ? `正在转发到 ${blackHole?.name || 'BlackHole 2ch'}` : state.audioDeviceHint;
  audioStatus.className = `status-chip ${blackHole ? 'online' : 'pending'}`;
  renderAudioMeter({
    received: state.audioFramesReceived > 0,
    rms: state.audioLastRms,
    peak: state.audioLastPeak,
    framesReceived: state.audioFramesReceived,
    framesForwarded: state.audioFramesForwarded,
    framesDropped: state.audioFramesDropped,
    packetAt: state.audioLastPacketAt,
  });
  audioInputs.replaceChildren();
  if (!state.audioInputs.length) {
    audioInputs.textContent = '暂未发现音频输入设备';
  } else {
    for (const input of state.audioInputs) {
      const row = document.createElement('div');
      row.className = 'audio-input-row';
      row.textContent = `${input.name}${input.isDefaultInput ? ' · 当前默认输入' : ''}`;
      audioInputs.append(row);
    }
  }
  a11yStatus.textContent = state.accessibilityTrusted ? '辅助功能：已授权' : '辅助功能：未授权';
  a11yStatus.className = `status-chip ${state.accessibilityTrusted ? 'online' : 'pending'}`;
  agentList.replaceChildren();
  for (const snapshot of state.snapshots) {
    const card = document.createElement('article');
    card.className = `agent-card state-${snapshot.state}`;
    card.innerHTML = `
      <div class="agent-card-top"><strong>${escapeHtml(snapshot.agentName)}</strong><span>${escapeHtml(snapshot.state)}</span></div>
      <div class="agent-title">${escapeHtml(snapshot.title || snapshot.projectName || '未命名任务')}</div>
      <div class="agent-meta">${escapeHtml(snapshot.projectPath || '尚未读取项目路径')}</div>
      <p>${escapeHtml(snapshot.summary || snapshot.lastLog || '暂无摘要')}</p>
    `;
    agentList.append(card);
  }
}

function renderAudioMeter(meter: AudioMeter): void {
  const fresh = Boolean(meter.packetAt && Date.now() - meter.packetAt < 1000);
  audioReceiveStatus.textContent = fresh
    ? '正在收到麦克风 PCM'
    : meter.received ? '曾收到 PCM，当前没有新数据' : '尚未收到麦克风数据';
  audioReceiveStatus.className = `status-chip ${fresh ? 'online' : 'pending'}`;
  audioMeterValues.textContent = `RMS ${meter.rms.toFixed(1)} · Peak ${meter.peak}`;
  audioMeterFill.style.width = `${Math.min(100, Math.max(2, meter.rms / 20))}%`;
  audioMeterFill.className = fresh && meter.rms > 20 ? 'meter-fill active' : 'meter-fill';
  audioMeterMeta.textContent = `收到 ${meter.framesReceived} 帧 · 转发 ${meter.framesForwarded} 帧 · 丢弃 ${meter.framesDropped} 帧`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] || char);
}

async function refreshPorts(): Promise<void> {
  const values = await window.hakimiBridge.listPorts();
  ports.replaceChildren();
  if (!values.length) {
    ports.add(new Option('未发现串口设备', ''));
    return;
  }
  for (const port of values) ports.add(new Option(port.friendlyName, port.path));
}

$('#refresh').addEventListener('click', () => void refreshPorts());
$('#identify-chip').addEventListener('click', async () => {
  if (!ports.value) return;
  try {
    const chip = await window.hakimiBridge.identifyChip(ports.value);
    log(`芯片检测：${chip.chip} ${chip.revisionText} → ${chip.family.toUpperCase()}${chip.mac ? ` · ${chip.mac}` : ''}`);
    result.textContent = `已确认 ${chip.revisionText}，后续只能使用 ${chip.family.toUpperCase()} 固件`;
  } catch (error) {
    log(`芯片检测失败：${error instanceof Error ? error.message : String(error)}`);
  }
});
$('#refresh-audio').addEventListener('click', async () => {
  const inputs = await window.hakimiBridge.listAudioInputs();
  const state = await window.hakimiBridge.getState();
  state.audioInputs = inputs;
  render(state);
  log(`音频输入设备：${inputs.map((item) => item.name).join(', ') || '无'}`);
});
$('#audio-test-start').addEventListener('click', async () => {
  const value = await window.hakimiBridge.startAudioTest();
  log(value.detail);
  result.textContent = value.detail;
});
$('#audio-test-stop').addEventListener('click', async () => {
  const value = await window.hakimiBridge.stopAudioTest();
  log(value.detail);
  result.textContent = value.detail;
});
$('#connect').addEventListener('click', async () => {
  if (!ports.value) return;
  try {
    await window.hakimiBridge.connect(ports.value);
    log(`已连接 ${ports.value}`);
  } catch (error) {
    log(`连接失败：${error instanceof Error ? error.message : String(error)}`);
  }
});
$('#disconnect').addEventListener('click', async () => {
  await window.hakimiBridge.disconnect();
  log('已断开设备');
});
$('#focus-codex').addEventListener('click', async () => {
  const value = await window.hakimiBridge.focusAgent('Codex');
  log(value.detail);
  result.textContent = value.detail;
});
$('#test-backspace').addEventListener('click', async () => {
  const value = await window.hakimiBridge.key('backspace', 'tap');
  log(value.detail);
  result.textContent = value.detail;
});
$('#test-left').addEventListener('click', async () => {
  const value = await window.hakimiBridge.key('left', 'tap');
  log(value.detail);
  result.textContent = value.detail;
});
$('#test-right').addEventListener('click', async () => {
  const value = await window.hakimiBridge.key('right', 'tap');
  log(value.detail);
  result.textContent = value.detail;
});
$('#test-fn').addEventListener('click', async () => {
  const value = await window.hakimiBridge.key('fn', 'tap');
  log(value.detail);
  result.textContent = `${value.detail} · 请确认豆包是否开始监听`;
});
$('#test-cmdtab').addEventListener('click', async () => {
  const value = await window.hakimiBridge.commandTab();
  log(value.detail);
  result.textContent = value.detail;
});
$('#docs').addEventListener('click', () => void window.hakimiBridge.openDocs());

window.hakimiBridge.onState(render);
window.hakimiBridge.onAudioMeter(renderAudioMeter);
window.hakimiBridge.onDeviceMessage((message) => log(`设备事件：${JSON.stringify(message)}`));
window.hakimiBridge.onSerialLine((line) => log(`串口：${line}`));
window.hakimiBridge.onSerialAudioLine((line) => log(`音频辅助器：${line}`));
window.hakimiBridge.onError((message) => {
  log(`错误：${message}`);
  result.textContent = message;
});
window.hakimiBridge.onAction((action) => {
  log(`硬件映射：${action.event || action.type}${action.phase ? `/${action.phase}` : ''} · ${action.detail}`);
  result.textContent = action.detail;
});
void refreshPorts();
void window.hakimiBridge.getState().then(render);
