#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const portPath = process.argv[2] || '/dev/cu.usbmodem5CF71565391';
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
  if (result.result?.subtype === 'error') throw new Error(result.result.description || '页面脚本执行失败');
  return result.result?.value;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const before = await call('window.hakimiBridge.getState()');
if (!before.connected) {
  await call(`window.hakimiBridge.connect(${JSON.stringify(portPath)})`);
  await wait(2200);
}

await call(`(() => {
  for (const key of ['__hakimiFnEventsUnsub', '__hakimiFnActionsUnsub']) {
    if (window[key]) window[key]();
  }
  window.__hakimiFnEvents = [];
  window.__hakimiFnActions = [];
  window.__hakimiFnEventsUnsub = window.hakimiBridge.onDeviceMessage((message) => {
    if (message?.topic === 'input/event') window.__hakimiFnEvents.push({ message, atMs: performance.now() });
  });
  window.__hakimiFnActionsUnsub = window.hakimiBridge.onAction((action) => {
    window.__hakimiFnActions.push({ action, atMs: performance.now() });
  });
  return true;
})()`);

// This uses the firmware's live simulation path, which emits source=device and
// therefore exercises the same production bridge handler as a physical SW1.
await call(`window.hakimiBridge.send(${JSON.stringify({
  topic: 'input/simulate',
  payload: {
    control: 'SW1',
    durationMs: 4500,
    live: 1,
    source: 'fn-activation-smoke',
  },
})})`);

// Focus activation includes the Codex application hand-off. Give it enough
// time before sampling the held-Fn state so this assertion does not race the
// 500 ms activation delay.
await wait(1800);
const mid = await call('window.hakimiBridge.getState()');
const screenshot = `/tmp/hakimi-fn-active-${Date.now()}.png`;
try {
  await execFileAsync('screencapture', ['-x', screenshot]);
} catch {
  // Screen capture is optional evidence on a locked/headless desktop.
}
await wait(3200);
const result = await call(`(async () => ({
  state: await window.hakimiBridge.getState(),
  events: window.__hakimiFnEvents,
  actions: window.__hakimiFnActions,
}))()`);

const startRecord = result.events.find((record) => record.message.payload?.control === 'SW1'
  && record.message.payload?.gesture === 'hold_start');
const endRecord = result.events.find((record) => record.message.payload?.control === 'SW1'
  && record.message.payload?.gesture === 'hold_end');
const voiceStartRecord = result.actions.find((record) => record.action.type === 'voice' && record.action.phase === 'start');
const voiceEndRecord = result.actions.find((record) => record.action.type === 'voice' && record.action.phase === 'end');
const start = startRecord?.message;
const end = endRecord?.message;
const voiceStart = voiceStartRecord?.action;
const voiceEnd = voiceEndRecord?.action;
const pass = Boolean(
  result.state.connected
  && mid.audioForwarding
  && start?.payload?.source === 'device'
  && end?.payload?.source === 'device'
  && voiceStart
  && voiceEnd,
);

console.log(JSON.stringify({
  pass,
  screenshot,
  mid: {
    connected: mid.connected,
    audioForwarding: mid.audioForwarding,
    audioFramesReceived: mid.audioFramesReceived,
    audioFramesForwarded: mid.audioFramesForwarded,
  },
  sw1: { start, end },
  voice: { start: voiceStart, end: voiceEnd },
  latencyMs: {
    eventToVoiceStart: startRecord && voiceStartRecord
      ? Math.round(voiceStartRecord.atMs - startRecord.atMs)
      : null,
    eventToVoiceEnd: startRecord && voiceEndRecord
      ? Math.round(voiceEndRecord.atMs - startRecord.atMs)
      : null,
  },
  final: {
    connected: result.state.connected,
    audioForwarding: result.state.audioForwarding,
    audioFramesReceived: result.state.audioFramesReceived,
    audioFramesForwarded: result.state.audioFramesForwarded,
    lastError: result.state.lastError,
  },
}, null, 2));

socket.close();
if (!pass) process.exitCode = 1;
