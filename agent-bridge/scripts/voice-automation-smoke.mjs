#!/usr/bin/env node

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'hakimi-voice-smoke-'));
const bundle = join(directory, 'voice-automation.mjs');
await build({
  entryPoints: ['src/voice-automation.ts'],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
});

const { KeyboardlessVoiceAutomation } = await import(pathToFileURL(bundle).href);
const config = {
  speechRmsThreshold: 500,
  endSilenceMs: 100,
  minWakeSpeechMs: 60,
  maxWakeSpeechMs: 500,
  commandTimeoutMs: 300,
  maxCaptureMs: 800,
  cooldownMs: 80,
  preRollMs: 60,
};
const session = new KeyboardlessVoiceAutomation(config);
const frameMs = 20;
const silence = Buffer.alloc(640);
const speech = Buffer.alloc(640);
for (let offset = 0; offset < speech.length; offset += 2) speech.writeInt16LE(5000, offset);
let now = 0;
const events = [];
const forwardedFrames = [];
const feed = (frame) => {
  const result = session.feed(frame, now);
  events.push(...result.events.map((event) => event.type));
  if (result.forward) forwardedFrames.push({ phase: result.phase, now });
  now += frameMs;
  return result;
};

session.enable(now);
for (let index = 0; index < 5; index += 1) feed(speech);
for (let index = 0; index < 6; index += 1) feed(silence);
const afterWake = session.getPhase();
for (let index = 0; index < 5; index += 1) feed(speech);
for (let index = 0; index < 6; index += 1) feed(silence);
const afterCommand = session.getPhase();
for (let index = 0; index < 20; index += 1) feed(silence);
const afterTimeout = session.getPhase();

// Hardware WakeNet mode must ignore a voice-shaped frame until the board sends
// an explicit audio/wake event, then reuse the same command VAD/capture path.
const wakeWordSession = new KeyboardlessVoiceAutomation(config);
wakeWordSession.setMode('wake-word');
wakeWordSession.enable(0);
const ignoredVoice = wakeWordSession.feed(speech, 0);
const wakeEvent = wakeWordSession.triggerWake(20);
const capturedAfterWake = wakeWordSession.feed(speech, 20);

const hardwareWakePass = !ignoredVoice.events.some((event) => event.type === 'wake-detected')
  && wakeEvent?.type === 'wake-detected'
  && wakeEvent.mode === 'wake-word'
  && wakeWordSession.getPhase() === 'capturing'
  && capturedAfterWake.forward;

const pass = events.includes('wake-detected')
  && events.includes('command-start')
  && events.includes('command-end')
  && afterWake === 'waiting_command'
  && afterCommand === 'cooldown'
  && afterTimeout === 'waiting_wake'
  && forwardedFrames.length > 0
  && hardwareWakePass;
console.log(JSON.stringify({
  events,
  afterWake,
  afterCommand,
  afterTimeout,
  forwardedFrameCount: forwardedFrames.length,
  hardwareWakePass,
  pass,
}, null, 2));
await rm(directory, { recursive: true, force: true });
if (!pass) process.exitCode = 1;
