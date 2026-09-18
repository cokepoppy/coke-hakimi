import { contextBridge, ipcRenderer } from 'electron';
import type { AudioInputInfo, AudioMeter, BridgeState, ChipIdentity, DeviceMessage, DevicePortInfo } from './protocol';

contextBridge.exposeInMainWorld('hakimiBridge', {
  listPorts: (): Promise<DevicePortInfo[]> => ipcRenderer.invoke('ports:list'),
  getState: (): Promise<BridgeState> => ipcRenderer.invoke('bridge:state'),
  listAudioInputs: (): Promise<AudioInputInfo[]> => ipcRenderer.invoke('mac:audio-inputs'),
  identifyChip: (path: string): Promise<ChipIdentity> => ipcRenderer.invoke('firmware:chip-info', path),
  connect: (path: string): Promise<DevicePortInfo> => ipcRenderer.invoke('device:connect', path),
  disconnect: (): Promise<void> => ipcRenderer.invoke('device:disconnect'),
  send: (message: DeviceMessage): Promise<void> => ipcRenderer.invoke('device:send', message),
  focusAgent: (appName?: string): Promise<{ focused: boolean; detail: string }> => ipcRenderer.invoke('mac:focus-agent', appName),
  activate: (appName: string): Promise<void> => ipcRenderer.invoke('mac:activate', appName),
  key: (name: string, phase: 'down' | 'up' | 'tap'): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('mac:key', name, phase),
  commandTab: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('mac:command-tab'),
  startAudioTest: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('audio:test-start'),
  stopAudioTest: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('audio:test-stop'),
  openDocs: (): Promise<void> => ipcRenderer.invoke('app:open-docs'),
  onState: (callback: (state: BridgeState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BridgeState) => callback(state);
    ipcRenderer.on('bridge-state', listener);
    return () => ipcRenderer.removeListener('bridge-state', listener);
  },
  onAudioMeter: (callback: (meter: AudioMeter) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, meter: AudioMeter) => callback(meter);
    ipcRenderer.on('audio-meter', listener);
    return () => ipcRenderer.removeListener('audio-meter', listener);
  },
  onDeviceMessage: (callback: (message: DeviceMessage) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: DeviceMessage) => callback(message);
    ipcRenderer.on('device-message', listener);
    return () => ipcRenderer.removeListener('device-message', listener);
  },
  onSerialLine: (callback: (line: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string) => callback(line);
    ipcRenderer.on('serial-line', listener);
    return () => ipcRenderer.removeListener('serial-line', listener);
  },
  onSerialAudioLine: (callback: (line: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, line: string) => callback(line);
    ipcRenderer.on('serial-audio-line', listener);
    return () => ipcRenderer.removeListener('serial-audio-line', listener);
  },
  onError: (callback: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('bridge-error', listener);
    return () => ipcRenderer.removeListener('bridge-error', listener);
  },
  onAction: (callback: (action: { type: string; phase?: string; event?: string; detail: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: { type: string; phase?: string; event?: string; detail: string }) => callback(action);
    ipcRenderer.on('bridge-action', listener);
    return () => ipcRenderer.removeListener('bridge-action', listener);
  },
});
