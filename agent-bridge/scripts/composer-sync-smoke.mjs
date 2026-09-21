#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const helper = new URL('../dist/macos-helper', import.meta.url).pathname;
await execFileAsync(helper, ['focus', 'Codex']);
await new Promise((resolve) => setTimeout(resolve, 800));

const targets = await fetch('http://127.0.0.1:9222/json/list').then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
if (!target) throw new Error('没有找到 Electron DevTools 页面');

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

const result = await evaluate('window.hakimiBridge.getState()');
const state = result.result?.value;
const draft = state?.inputDraft;
const pass = Boolean(
  draft
  && draft.status !== 'unavailable'
  && ['mac-accessibility', 'mac-ocr'].includes(draft.source),
);
console.log(JSON.stringify({
  connected: state?.connected,
  inputDraft: draft,
  pass,
}, null, 2));
socket.close();
if (!pass) process.exitCode = 1;
