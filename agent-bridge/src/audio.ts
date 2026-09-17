import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

export type AudioSinkStats = {
  running: boolean;
  deviceName: string;
  bytesWritten: number;
  chunksWritten: number;
  lastError?: string;
};

type NativeResponse = {
  ok?: boolean;
  ready?: boolean;
  detail?: string;
};

const DEFAULT_DEVICE = 'BlackHole 2ch';

/**
 * Feeds signed 16-bit little-endian mono PCM to a macOS CoreAudio output
 * device. BlackHole exposes that output as an input device to Doubao and
 * other apps. The helper is deliberately kept outside Electron's JS process
 * so the audio callback is scheduled by CoreAudio rather than the renderer.
 */
export class SerialAudioSink {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private deviceName = process.env.HAKIMI_VIRTUAL_MIC || DEFAULT_DEVICE;
  private bytesWritten = 0;
  private chunksWritten = 0;
  private lastError?: string;

  constructor(private readonly onLine: (line: string) => void) {}

  async start(deviceName = this.deviceName): Promise<void> {
    if (this.child && !this.child.killed && this.child.stdin.writable) return;
    if (this.starting) return this.starting;
    if (process.platform !== 'darwin') throw new Error('串口音频虚拟麦克风目前只支持 macOS');

    const helper = join(__dirname, 'macos-helper');
    if (!existsSync(helper)) throw new Error('找不到 dist/macos-helper，请先 npm run build');
    this.deviceName = deviceName;
    this.lastError = undefined;
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(helper, ['audio-sink', deviceName], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      let settled = false;
      const settleError = (error: Error) => {
        this.lastError = error.message;
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const settleReady = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        this.onLine(line.slice(0, 500));
        try {
          const response = JSON.parse(line) as NativeResponse;
          if (response.ready && response.ok !== false) settleReady();
          if (response.ok === false) settleError(new Error(response.detail || 'macOS 音频输出启动失败'));
        } catch {
          // The helper's stdout is expected to be JSON, but keep diagnostics
          // visible if a future native implementation prints plain text.
        }
      });
      createInterface({ input: child.stderr }).on('line', (line) => this.onLine(`stderr: ${line.slice(0, 480)}`));
      child.once('error', settleError);
      child.once('exit', (code, signal) => {
        this.child = undefined;
      const detail = `macOS 音频辅助器已退出 (${signal || (code ?? 'unknown')})`;
        if (!settled) settleError(new Error(detail));
        else if (code !== 0) this.lastError = detail;
      });
      setTimeout(() => {
        if (!settled) settleError(new Error('等待 macOS 音频输出启动超时'));
      }, 3000).unref();
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  write(pcm: Buffer): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable || stdin.destroyed) return false;
    if (stdin.writableLength > 128 * 1024) {
      this.lastError = 'CoreAudio 音频管道积压超过 128 KiB，丢弃当前帧以保持低延迟';
      return false;
    }
    try {
      stdin.write(pcm);
      this.bytesWritten += pcm.length;
      this.chunksWritten += 1;
      // A false return value only means Node asked us to respect backpressure;
      // the current chunk has already been accepted by the pipe. The caller
      // uses a bounded stdin buffer and will drop a later chunk if necessary.
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 800);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  stats(): AudioSinkStats {
    return {
      running: Boolean(this.child && !this.child.killed && this.child.stdin.writable),
      deviceName: this.deviceName,
      bytesWritten: this.bytesWritten,
      chunksWritten: this.chunksWritten,
      lastError: this.lastError,
    };
  }
}
