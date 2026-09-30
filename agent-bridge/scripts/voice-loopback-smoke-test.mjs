#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const requestedPort = process.argv.slice(2).find((argument) => argument.startsWith('/dev/') || argument.startsWith('COM'));
const portPath = requestedPort || '/dev/cu.usbmodem5CF71565391';
const phrase = process.env.HAKIMI_TEST_PHRASE || '哈基米语音自动化测试';
const holdMs = Number(process.env.HAKIMI_TEST_HOLD_MS || 2400);
const waitAfterPlaybackMs = Number(process.env.HAKIMI_TEST_SETTLE_MS || 4500);
const captureCamera = process.argv.includes('--camera');

const targets = await fetch('http://127.0.0.1:9222/json/list').then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
if (!target) throw new Error('没有找到 Electron DevTools 页面；请用 --remote-debugging-port=9222 启动桥接端');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

function evaluate(expression) {
  const id = nextId++;
  socket.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function call(expression) {
  const result = await evaluate(expression);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本执行失败');
  return result.result?.value;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stateBefore = await call('window.hakimiBridge.getState()');
if (!stateBefore.connected) {
  await call(`window.hakimiBridge.connect(${JSON.stringify(portPath)})`);
  await wait(3500);
}

await call(`(() => {
  for (const key of [
    '__hakimiVoiceEventsUnsub', '__hakimiVoiceActionsUnsub',
    '__hakimiVoiceMeterUnsub', '__hakimiVoiceDraftUnsub',
    '__hakimiVoiceRawUnsub', '__hakimiVoiceAudioRawUnsub',
  ]) if (window[key]) window[key]();
  window.__hakimiVoiceEvents = [];
  window.__hakimiVoiceActions = [];
  window.__hakimiVoiceMeters = [];
  window.__hakimiVoiceDrafts = [];
  window.__hakimiVoiceRaw = [];
  window.__hakimiVoiceAudioRaw = [];
  window.__hakimiVoiceEventsUnsub = window.hakimiBridge.onDeviceMessage((message) => {
    if (message?.topic !== 'audio/pcm') window.__hakimiVoiceEvents.push(message);
  });
  window.__hakimiVoiceActionsUnsub = window.hakimiBridge.onAction((action) => {
    window.__hakimiVoiceActions.push(action);
  });
  window.__hakimiVoiceMeterUnsub = window.hakimiBridge.onAudioMeter((meter) => {
    window.__hakimiVoiceMeters.push(meter);
  });
  window.__hakimiVoiceDraftUnsub = window.hakimiBridge.onInputDraft((draft) => {
    window.__hakimiVoiceDrafts.push(draft);
  });
  window.__hakimiVoiceRawUnsub = window.hakimiBridge.onSerialLine((line) => {
    window.__hakimiVoiceRaw.push(line);
  });
  if (window.hakimiBridge.onSerialAudioLine) {
    window.__hakimiVoiceAudioRawUnsub = window.hakimiBridge.onSerialAudioLine((line) => {
      window.__hakimiVoiceAudioRaw.push(line);
    });
  }
  return true;
})()`);

const baseline = await call('window.hakimiBridge.getState()');
const startedAt = Date.now();

// `live: 1` makes firmware drive the real SW1 GPIO sampler.  The resulting
// input events carry source=device, so Electron exercises the production Fn /
// CoreAudio path instead of the dry-run simulation path.
await call(`window.hakimiBridge.send(${JSON.stringify({
  topic: 'input/simulate',
  payload: {
    control: 'SW1',
    durationMs: holdMs,
    live: 1,
    source: 'voice-loopback-smoke-test',
  },
})})`);

// Give the firmware sampler time to debounce and emit hold_start, then play
// through the Mac's normal output.  The physical Hakimi microphone is expected
// to hear this output and send the captured PCM to BlackHole via Electron.
await wait(950);
const audioPath = `/tmp/hakimi-voice-loopback-${Date.now()}.aiff`;
await execFileAsync('say', ['-v', 'Tingting', '-o', audioPath, phrase]);
const playbackStartedAt = Date.now();
await execFileAsync('afplay', [audioPath]);
const playbackFinishedAt = Date.now();

// Wait through the simulated release and give Doubao time to endpoint and
// commit the recognized text.  Text is a separate gate from transport: a
// failed acoustic coupling must not hide a successful GPIO/PCM/Fn proof.
await wait(Math.max(0, holdMs + 400 - (Date.now() - startedAt)));
await wait(waitAfterPlaybackMs);
await call(`window.hakimiBridge.send(${JSON.stringify({
  topic: 'display/query',
  payload: { source: 'voice-loopback-smoke-test' },
})})`);
await wait(500);

let cameraPath;
if (captureCamera) {
  cameraPath = `/tmp/hakimi-voice-loopback-${Date.now()}.png`;
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
      '-pixel_format', 'uyvy422', '-framerate', '30', '-video_size', '1920x1440',
      '-i', '1:none', '-frames:v', '1', '-vf', 'hflip,vflip', '-y', cameraPath,
    ]);
  } catch (error) {
    cameraPath = undefined;
    console.error(`摄像头取证失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const [finalState, events, actions, meters, drafts, raw, audioRaw] = await Promise.all([
  call('window.hakimiBridge.getState()'),
  call('window.__hakimiVoiceEvents'),
  call('window.__hakimiVoiceActions'),
  call('window.__hakimiVoiceMeters'),
  call('window.__hakimiVoiceDrafts'),
  call('window.__hakimiVoiceRaw'),
  call('window.__hakimiVoiceAudioRaw'),
]);

const inputEvents = events.filter((message) => message.topic === 'input/event');
const sw1Start = inputEvents.find((message) => message.payload?.control === 'SW1'
  && message.payload?.gesture === 'hold_start');
const sw1End = inputEvents.find((message) => message.payload?.control === 'SW1'
  && message.payload?.gesture === 'hold_end');
const voiceStart = actions.find((action) => action.type === 'voice' && action.phase === 'start');
const voiceEnd = actions.find((action) => action.type === 'voice' && action.phase === 'end');
const panicLines = [...raw, ...audioRaw].filter((line) => /Guru|panic|Stack protection|abort\(\)/i.test(line));
const receivedDelta = finalState.audioFramesReceived - baseline.audioFramesReceived;
const forwardedDelta = finalState.audioFramesForwarded - baseline.audioFramesForwarded;
const droppedDelta = finalState.audioFramesDropped - baseline.audioFramesDropped;
const latestDraft = drafts.at(-1) || finalState.inputDraft;

const transportPass = Boolean(
  finalState.connected
  && sw1Start?.payload?.source === 'device'
  && sw1End?.payload?.source === 'device'
  && voiceStart
  && voiceEnd
  && receivedDelta > 0
  && forwardedDelta > 0
  && droppedDelta === 0
  && panicLines.length === 0
  && finalState.audioInputs.some((item) => /blackhole/i.test(item.name) && item.isDefaultInput),
);

console.log(JSON.stringify({
  port: portPath,
  phrase,
  holdMs,
  audioPath,
  cameraPath,
  playbackStartedAt,
  playbackFinishedAt,
  doubaoInputEvidence: finalState.audioInputs.filter((item) => /blackhole/i.test(item.name)),
  transportPass,
  textGate: {
    recognizedDraft: latestDraft?.text || '',
    draftSource: latestDraft?.source,
    draftStatus: latestDraft?.status,
    note: '中文结果依赖扬声器到 Hakimi MIC 的物理声学耦合，以及豆包端点检测；与 GPIO/PCM/Fn 传输链路分开判定。',
  },
  deltas: { received: receivedDelta, forwarded: forwardedDelta, dropped: droppedDelta },
  sw1: { start: sw1Start, end: sw1End },
  voiceActions: { start: voiceStart, end: voiceEnd },
  latestMeter: meters.at(-1),
  displayAck: events.find((message) => message.topic === 'control/ack'
    && message.payload?.for === 'display/query'),
  panicLines,
  finalState: {
    connected: finalState.connected,
    audioForwarding: finalState.audioForwarding,
    audioFramesReceived: finalState.audioFramesReceived,
    audioFramesForwarded: finalState.audioFramesForwarded,
    audioFramesDropped: finalState.audioFramesDropped,
    lastError: finalState.lastError,
  },
}, null, 2));

socket.close();
if (!transportPass) process.exitCode = 1;
