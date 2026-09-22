export type VoiceAutomationPhase =
  | 'off'
  | 'waiting_wake'
  | 'waiting_command'
  | 'capturing'
  | 'cooldown';

export type VoiceAutomationEvent =
  | { type: 'wake-detected'; durationMs: number; mode: 'vad-fallback' | 'wake-word' }
  | { type: 'command-start'; preRoll: Buffer[] }
  | { type: 'command-end'; reason: 'silence' | 'max-duration' }
  | { type: 'command-timeout' };

export type VoiceAutomationConfig = {
  sampleRate: number;
  speechRmsThreshold: number;
  wakeWordCommandRmsThreshold: number;
  endSilenceMs: number;
  minWakeSpeechMs: number;
  maxWakeSpeechMs: number;
  commandTimeoutMs: number;
  maxCaptureMs: number;
  cooldownMs: number;
  preRollMs: number;
};

export const DEFAULT_VOICE_AUTOMATION_CONFIG: VoiceAutomationConfig = {
  sampleRate: 16_000,
  speechRmsThreshold: 900,
  // The ES8311 path on this board has a much smaller PCM amplitude than a
  // Mac microphone. Once WakeNet has already fired, use a lower threshold
  // for the command segment; the hardware wake word remains the gate.
  wakeWordCommandRmsThreshold: 120,
  endSilenceMs: 900,
  minWakeSpeechMs: 250,
  maxWakeSpeechMs: 2_500,
  commandTimeoutMs: 4_000,
  maxCaptureMs: 20_000,
  cooldownMs: 600,
  preRollMs: 300,
};

export type VoiceAutomationFeed = {
  events: VoiceAutomationEvent[];
  forward: boolean;
  phase: VoiceAutomationPhase;
  speech: boolean;
  rms: number;
};

export function pcmRms(pcm: Buffer): number {
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let offset = 0; offset < sampleCount; offset += 1) {
    const sample = pcm.readInt16LE(offset * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Keyboard-free voice session state machine.
 *
 * The VAD fallback deliberately treats the first short speech segment as a
 * wake candidate. A real offline wake-word model can replace that detector
 * later without changing the command capture, Fn, or PCM forwarding path.
 */
export class KeyboardlessVoiceAutomation {
  private readonly config: VoiceAutomationConfig;
  private phase: VoiceAutomationPhase = 'off';
  private speaking = false;
  private speechStartedAt = 0;
  private lastSpeechAt = 0;
  private waitingCommandUntil = 0;
  private cooldownUntil = 0;
  private preRoll: Buffer[] = [];
  private preRollDurationMs = 0;
  private mode: 'vad-fallback' | 'wake-word' = 'vad-fallback';

  constructor(config: Partial<VoiceAutomationConfig> = {}) {
    this.config = { ...DEFAULT_VOICE_AUTOMATION_CONFIG, ...config };
  }

  getPhase(): VoiceAutomationPhase {
    return this.phase;
  }

  getMode(): 'vad-fallback' | 'wake-word' {
    return this.mode;
  }

  setMode(mode: 'vad-fallback' | 'wake-word'): void {
    this.mode = mode;
  }

  enable(nowMs = Date.now()): void {
    this.phase = 'waiting_wake';
    this.speaking = false;
    this.waitingCommandUntil = nowMs + this.config.commandTimeoutMs;
    this.cooldownUntil = 0;
    this.clearPreRoll();
  }

  disable(): void {
    this.phase = 'off';
    this.speaking = false;
    this.clearPreRoll();
  }

  /**
   * Accept a wake event from a real on-device detector such as ESP-SR/WakeNet.
   * The wake-word audio is intentionally not forwarded to Doubao; only the
   * following command segment is captured.
   */
  triggerWake(nowMs = Date.now()): VoiceAutomationEvent | undefined {
    if (this.phase !== 'waiting_wake') return undefined;
    this.speaking = false;
    this.phase = 'waiting_command';
    this.waitingCommandUntil = nowMs + this.config.commandTimeoutMs;
    this.clearPreRoll();
    return { type: 'wake-detected', durationMs: 0, mode: 'wake-word' };
  }

  feed(pcm: Buffer, nowMs: number): VoiceAutomationFeed {
    const frameMs = Math.max(1, (pcm.length / 2 / this.config.sampleRate) * 1000);
    const rms = pcmRms(pcm);
    const commandPhase = this.phase === 'waiting_command' || this.phase === 'capturing';
    const speechThreshold = this.mode === 'wake-word' && commandPhase
      ? this.config.wakeWordCommandRmsThreshold
      : this.config.speechRmsThreshold;
    const speech = rms >= speechThreshold;
    const events: VoiceAutomationEvent[] = [];

    if (this.phase === 'off') {
      return { events, forward: false, phase: this.phase, speech, rms };
    }

    if (this.phase === 'cooldown' && nowMs >= this.cooldownUntil) {
      this.phase = 'waiting_wake';
      this.clearPreRoll();
    }

    if (this.phase === 'waiting_command' && nowMs >= this.waitingCommandUntil && !this.speaking) {
      this.phase = 'waiting_wake';
      this.clearPreRoll();
      events.push({ type: 'command-timeout' });
    }

    const wasWaitingCommand = this.phase === 'waiting_command';
    const preRollForCommand = wasWaitingCommand ? this.preRoll.slice() : [];

    if (speech) {
      if (!this.speaking) {
        this.speaking = true;
        this.speechStartedAt = nowMs;
        this.lastSpeechAt = nowMs;
        if (this.phase === 'waiting_command') {
          this.phase = 'capturing';
          events.push({ type: 'command-start', preRoll: preRollForCommand });
        }
      }
      this.lastSpeechAt = nowMs;
    } else if (this.speaking && nowMs - this.lastSpeechAt >= this.config.endSilenceMs) {
      const durationMs = Math.max(frameMs, this.lastSpeechAt - this.speechStartedAt + frameMs);
      this.speaking = false;
      if (this.phase === 'waiting_wake' && this.mode === 'vad-fallback') {
        if (durationMs >= this.config.minWakeSpeechMs && durationMs <= this.config.maxWakeSpeechMs) {
          this.phase = 'waiting_command';
          this.waitingCommandUntil = nowMs + this.config.commandTimeoutMs;
          this.clearPreRoll();
          events.push({ type: 'wake-detected', durationMs, mode: this.mode });
        }
      } else if (this.phase === 'capturing') {
        this.phase = 'cooldown';
        this.cooldownUntil = nowMs + this.config.cooldownMs;
        events.push({ type: 'command-end', reason: 'silence' });
      }
    }

    if (this.phase === 'capturing' && nowMs - this.speechStartedAt >= this.config.maxCaptureMs) {
      this.speaking = false;
      this.phase = 'cooldown';
      this.cooldownUntil = nowMs + this.config.cooldownMs;
      events.push({ type: 'command-end', reason: 'max-duration' });
    }

    if (this.phase === 'waiting_command') this.rememberPreRoll(pcm, frameMs);

    const forward = this.phase === 'capturing'
      || events.some((event) => event.type === 'command-start' || event.type === 'command-end');
    return { events, forward, phase: this.phase, speech, rms };
  }

  private rememberPreRoll(pcm: Buffer, frameMs: number): void {
    this.preRoll.push(Buffer.from(pcm));
    this.preRollDurationMs += frameMs;
    while (this.preRollDurationMs > this.config.preRollMs && this.preRoll.length > 1) {
      const removed = this.preRoll.shift();
      if (removed) this.preRollDurationMs -= (removed.length / 2 / this.config.sampleRate) * 1000;
    }
  }

  private clearPreRoll(): void {
    this.preRoll = [];
    this.preRollDurationMs = 0;
  }
}
