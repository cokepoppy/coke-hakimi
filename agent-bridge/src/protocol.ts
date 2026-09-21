export type DeviceMessage = {
  topic: string;
  payload?: Record<string, unknown>;
};

export type DevicePortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  friendlyName: string;
};

export type AudioInputInfo = {
  name: string;
  manufacturer?: string;
  transport?: string;
  sampleRate?: number;
  isDefaultInput: boolean;
};

export type AudioMode = 'serial-blackhole' | 'native-uac';

export type AudioPcmPayload = {
  seq?: number;
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
  encoding: 's16le';
  dataBase64: string;
};

export type AudioMeter = {
  received: boolean;
  rms: number;
  peak: number;
  framesReceived: number;
  framesForwarded: number;
  framesDropped: number;
  packetAt?: number;
};

export type ChipIdentity = {
  chip: 'ESP32-P4' | 'unknown';
  revisionText: string;
  revision: number;
  family: 'v1' | 'v3' | 'unknown';
  mac?: string;
  raw: string;
};

export type AgentState =
  | 'idle'
  | 'listening'
  | 'working'
  | 'waiting_user'
  | 'done'
  | 'error'
  | 'disconnected';

export type InputDraftStatus = 'ready' | 'composing' | 'unavailable';

export type InputDraft = {
  text: string;
  cursor: number;
  revision: number;
  source: 'mac-accessibility' | 'mac-ocr' | 'unknown';
  status: InputDraftStatus;
  updatedAt: number;
  detail?: string;
};

export type AgentSnapshot = {
  agentId: string;
  agentName: string;
  projectName?: string;
  projectPath?: string;
  sessionId?: string;
  title?: string;
  state: AgentState;
  stage?: string;
  summary?: string;
  lastLog?: string;
  updatedAt: number;
};

export type BridgeState = {
  connected: boolean;
  port?: DevicePortInfo;
  chip?: ChipIdentity;
  audioMode: AudioMode;
  audioInputs: AudioInputInfo[];
  audioDeviceHint: string;
  audioForwarding: boolean;
  audioFramesReceived: number;
  audioFramesForwarded: number;
  audioFramesDropped: number;
  audioLastPacketAt?: number;
  audioLastRms: number;
  audioLastPeak: number;
  accessibilityTrusted: boolean;
  codexRunning: boolean;
  snapshots: AgentSnapshot[];
  inputDraft?: InputDraft;
  lastDeviceEvent?: DeviceMessage;
  lastError?: string;
};

export function encodeMessage(message: DeviceMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseMessage(line: string): DeviceMessage | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.topic !== 'string') return undefined;
    return {
      topic: record.topic,
      payload: record.payload && typeof record.payload === 'object'
        ? record.payload as Record<string, unknown>
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export function summarizeDeviceMessage(message: DeviceMessage): string {
  const payload = message.payload ? ` ${JSON.stringify(message.payload)}` : '';
  return `${message.topic}${payload}`.slice(0, 500);
}
