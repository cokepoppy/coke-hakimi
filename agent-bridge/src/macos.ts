import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const NATIVE_HELPER = join(__dirname, 'macos-helper');

const KEY_CODES: Record<string, number> = {
  backspace: 51,
  enter: 36,
  escape: 53,
  left: 123,
  right: 124,
  up: 126,
  down: 125,
  tab: 48,
  fn: 63,
};

async function runAppleScript(script: string): Promise<string> {
  const result = await execFileAsync('osascript', ['-e', script], { timeout: 2500 });
  return result.stdout.trim();
}

type HelperResponse = {
  ok?: boolean;
  focused?: boolean;
  trusted?: boolean;
  detail?: string;
};

async function runNativeHelper(args: string[]): Promise<HelperResponse | undefined> {
  if (process.platform !== 'darwin' || !existsSync(NATIVE_HELPER)) return undefined;
  try {
    const result = await execFileAsync(NATIVE_HELPER, args, { timeout: 2500 });
    return JSON.parse(result.stdout.trim()) as HelperResponse;
  } catch {
    return undefined;
  }
}

export async function accessibilityTrusted(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const helper = await runNativeHelper(['trusted']);
  if (typeof helper?.trusted === 'boolean') return helper.trusted;
  try {
    const output = await runAppleScript('tell application "System Events" to return UI elements enabled');
    return output.toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export async function activateApp(appName: string): Promise<void> {
  await execFileAsync('open', ['-a', appName], { timeout: 3000 });
}

export async function focusCodexWindow(appName = 'Codex'): Promise<{ focused: boolean; detail: string }> {
  if (process.platform !== 'darwin') return { focused: false, detail: '仅支持 macOS' };
  try {
    await activateApp(appName);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const helper = await runNativeHelper(['focus', appName]);
    if (helper) {
      return {
        focused: helper.focused ?? helper.ok ?? false,
        detail: helper.detail || `${appName} 已置前并尝试聚焦输入框`,
      };
    }
    await runAppleScript(`tell application "System Events" to tell process "${appName}" to set frontmost to true`);
    return { focused: true, detail: `${appName} 已置前；未找到原生辅助功能适配器` };
  } catch (error) {
    return { focused: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function postKey(name: string, phase: 'down' | 'up' | 'tap'): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== 'darwin') return { ok: false, detail: '仅支持 macOS' };
  const code = KEY_CODES[name];
  if (code === undefined) return { ok: false, detail: `未知按键: ${name}` };
  try {
    const helper = await runNativeHelper(['key', name, phase]);
    if (helper) return { ok: helper.ok ?? false, detail: helper.detail || `${name}:${phase}` };
    const downUp = `tell application "System Events" to key code ${code}`;
    if (phase === 'tap' || name === 'fn') {
      await runAppleScript(downUp);
    } else if (phase === 'down') {
      await runAppleScript(`tell application "System Events" to key down ${code}`);
    } else {
      await runAppleScript(`tell application "System Events" to key up ${code}`);
    }
    return { ok: true, detail: `${name}:${phase}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function commandTab(): Promise<{ ok: boolean; detail: string }> {
  if (process.platform !== 'darwin') return { ok: false, detail: '仅支持 macOS' };
  try {
    const helper = await runNativeHelper(['command-tab']);
    if (helper) return { ok: helper.ok ?? false, detail: helper.detail || 'Command+Tab' };
    await runAppleScript('tell application "System Events" to key code 55 using {command down}');
    return { ok: true, detail: 'Command+Tab' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function listAudioInputs(): Promise<import('./protocol').AudioInputInfo[]> {
  if (process.platform !== 'darwin') return [];
  try {
    const result = await execFileAsync('system_profiler', ['SPAudioDataType', '-json'], { timeout: 3500 });
    const root = JSON.parse(result.stdout) as {
      SPAudioDataType?: Array<{ _items?: Array<Record<string, unknown>> }>;
    };
    const items = root.SPAudioDataType?.flatMap((group) => group._items || []) || [];
    return items
      .filter((item) => Number(item.coreaudio_device_input || 0) > 0)
      .map((item) => ({
        name: String(item._name || item.coreaudio_input_source || 'Unknown input'),
        manufacturer: typeof item.coreaudio_device_manufacturer === 'string'
          ? item.coreaudio_device_manufacturer
          : undefined,
        transport: typeof item.coreaudio_device_transport === 'string'
          ? item.coreaudio_device_transport
          : undefined,
        sampleRate: typeof item.coreaudio_device_srate === 'number'
          ? item.coreaudio_device_srate
          : undefined,
        isDefaultInput: item.coreaudio_default_audio_input_device === 'spaudio_yes',
      }));
  } catch {
    return [];
  }
}
