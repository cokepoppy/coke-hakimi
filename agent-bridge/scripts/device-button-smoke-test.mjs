#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const portPath = process.argv[2] || '/dev/cu.usbmodem5CF71565391';
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

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const stateBefore = await call('window.hakimiBridge.getState()');
if (!stateBefore.connected) {
  await call(`window.hakimiBridge.connect(${JSON.stringify(portPath)})`);
  // After a fresh flash the display, ADC neutral calibration, and ES8311
  // startup run before the first control line is safe to send.
  await wait(3500);
} else {
  await wait(500);
}

await call(`(() => {
  if (window.__hakimiButtonEventsUnsub) window.__hakimiButtonEventsUnsub();
  if (window.__hakimiButtonActionsUnsub) window.__hakimiButtonActionsUnsub();
  if (window.__hakimiButtonRawUnsub) window.__hakimiButtonRawUnsub();
  window.__hakimiButtonEvents = [];
  window.__hakimiButtonActions = [];
  window.__hakimiButtonRaw = [];
  window.__hakimiButtonEventsUnsub = window.hakimiBridge.onDeviceMessage((message) => {
    if (message?.topic !== 'audio/pcm') window.__hakimiButtonEvents.push(message);
  });
  window.__hakimiButtonActionsUnsub = window.hakimiBridge.onAction((action) => {
    window.__hakimiButtonActions.push(action);
  });
  window.__hakimiButtonRawUnsub = window.hakimiBridge.onSerialLine((line) => {
    window.__hakimiButtonRaw.push(line);
  });
  return true;
})()`);

const testCases = [
  { control: 'SW1', durationMs: 850, event: 'button.sw1.hold', gesture: 'hold_start', actionType: 'voice-start' },
  { control: 'SW2', event: 'button.sw2.short_press', gesture: 'short_press', action: 'backspace:tap' },
  { control: 'SW3', event: 'button.sw3.short_press', gesture: 'short_press', action: 'enter:tap' },
  { control: 'ENCODER', event: 'button.encoder.short_press', gesture: 'short_press', action: 'enter:tap' },
  { control: 'JOY_LEFT', event: 'joystick.left', gesture: 'simulation', action: 'left:tap' },
  { control: 'JOY_RIGHT', event: 'joystick.right', gesture: 'simulation', action: 'right:tap' },
  { control: 'JOY_UP', event: 'joystick.up', gesture: 'simulation', action: 'up:tap' },
  { control: 'JOY_DOWN', event: 'joystick.down', gesture: 'simulation', action: 'down:tap' },
  { control: 'SW2', durationMs: 850, event: 'button.sw2.hold', gesture: 'hold_start', action: 'simulation command+tab' },
  { control: 'SW3', durationMs: 850, event: 'button.sw3.hold', gesture: 'hold_start', action: 'simulation command+shift+tab' },
];

const results = [];
for (const testCase of testCases) {
  const { control } = testCase;
  await call('window.__hakimiButtonEvents = []; window.__hakimiButtonActions = []; window.__hakimiButtonRaw = [];');
  const payload = { control, source: 'device-button-smoke-test' };
  if (testCase.durationMs) payload.durationMs = testCase.durationMs;
  await call(`window.hakimiBridge.send(${JSON.stringify({
    topic: 'input/simulate',
    payload,
  })})`);
  await wait(testCase.durationMs ? testCase.durationMs + 350 : 900);
  const events = await call('window.__hakimiButtonEvents');
  const actions = await call('window.__hakimiButtonActions');
  const raw = await call('window.__hakimiButtonRaw');
  const event = events.find((message) => message.topic === 'input/event'
    && message.payload?.event === testCase.event
    && message.payload?.gesture === testCase.gesture);
  const action = testCase.actionType === 'voice-start'
    ? actions.find((item) => item.type === 'voice' && item.phase === 'start' && item.detail === 'simulation fn:down')
    : actions.find((item) => item.type === 'input' && item.detail === testCase.action);
  results.push({
    control,
    expected: testCase,
    gpioLevels: events.filter((message) => message.topic === 'input/levels').map((message) => message.payload),
    event,
    action,
    panicLines: raw.filter((line) => /Guru|panic|Stack protection|abort\(\)/.test(line)),
  });
}

let cameraPath;
if (captureCamera) {
  cameraPath = `/tmp/hakimi-button-smoke-${Date.now()}.png`;
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

const finalState = await call('window.hakimiBridge.getState()');
const pass = Boolean(finalState.connected && results.every((result) => result.event
  && result.action
  && result.panicLines.length === 0));
console.log(JSON.stringify({ port: portPath, results, cameraPath, connected: finalState.connected, pass }, null, 2));
socket.close();
if (!pass) process.exitCode = 1;
