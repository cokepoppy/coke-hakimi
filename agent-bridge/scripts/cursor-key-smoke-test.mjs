#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const targets = await fetch('http://127.0.0.1:9222/json/list').then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
if (!target) throw new Error('没有找到 Electron DevTools 页面');

await execFileAsync('osascript', [
  '-e',
  'tell application "System Events" to tell process "Electron" to set frontmost to true',
]);

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
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    .then((result) => {
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本执行失败');
      return result.result?.value;
    });
}

const setup = await evaluate(`(() => {
  document.getElementById('__hakimi_cursor_smoke__')?.remove();
  const textarea = document.createElement('textarea');
  textarea.id = '__hakimi_cursor_smoke__';
  textarea.value = 'AB\\nCD';
  textarea.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:80px;z-index:99999';
  document.body.append(textarea);
  window.focus();
  textarea.focus();
  textarea.setSelectionRange(4, 4);
  return { cursor: textarea.selectionStart, active: document.activeElement?.id };
})()`);

const results = [];
for (const test of [
  { key: 'left', before: 2, expected: 1 },
  { key: 'right', before: 1, expected: 2 },
  { key: 'up', before: 4, expected: 1 },
  { key: 'down', before: 1, expected: 4 },
]) {
  await evaluate(`document.getElementById('__hakimi_cursor_smoke__').setSelectionRange(${test.before}, ${test.before})`);
  const action = await evaluate(`window.hakimiBridge.key(${JSON.stringify(test.key)}, 'tap')`);
  await new Promise((resolve) => setTimeout(resolve, 220));
  const cursor = await evaluate('document.getElementById("__hakimi_cursor_smoke__").selectionStart');
  results.push({ ...test, action, cursor, pass: cursor === test.expected });
}

await evaluate('document.getElementById("__hakimi_cursor_smoke__")?.remove()');
socket.close();

const pass = setup.cursor === 4 && setup.active === '__hakimi_cursor_smoke__'
  && results.every((result) => result.pass && result.action?.ok);
console.log(JSON.stringify({ setup, results, pass }, null, 2));
if (!pass) process.exitCode = 1;
