#!/usr/bin/env node

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

await call(`window.hakimiBridge.connect(${JSON.stringify(portPath)})`);
await call(`window.hakimiBridge.send(${JSON.stringify({
  topic: 'speech/text',
  payload: {
    sessionId: 'automated-display-smoke',
    title: '自动显示测试',
    body: 'Agent 输出自动化测试：中文、English、123',
    status: 'working',
  },
})})`);
await new Promise((resolve) => setTimeout(resolve, 250));
await call(`window.hakimiBridge.send(${JSON.stringify({
  topic: 'ui/input-draft',
  payload: {
    text: '输入框同步自动化测试：请继续',
    cursor: 10,
    source: 'automated-smoke',
    status: 'draft',
  },
})})`);
let queryAck;
for (let round = 0; round < 4 && !queryAck; round += 1) {
  const beforeQuery = await call('window.hakimiBridge.getState()');
  const beforeQueryTs = beforeQuery.lastDeviceEvent?.payload?.tsMs;
  await call(`window.hakimiBridge.send(${JSON.stringify({ topic: 'display/query', payload: { source: 'automated-smoke' } })})`);
  for (let attempt = 0; attempt < 12 && !queryAck; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const candidate = await call('window.hakimiBridge.getState()');
    const event = candidate.lastDeviceEvent;
    if (event?.topic === 'control/ack'
        && event.payload?.for === 'display/query'
        && event.payload?.tsMs !== beforeQueryTs
        && event.payload?.display?.inputDraftBytes > 0) queryAck = event.payload;
  }
  if (!queryAck) await new Promise((resolve) => setTimeout(resolve, 100));
}
const state = await call('window.hakimiBridge.getState()');
const ack = queryAck;
const display = ack?.display;
// The payloads above are synthetic assertions, not user content. Do not
// leave the smoke-test draft visible after the test; normal app updates come
// from the real macOS Accessibility composer watcher.
await call(`window.hakimiBridge.send(${JSON.stringify({
  topic: 'ui/input-draft',
  payload: {
    text: '',
    cursor: 0,
    revision: 0,
    source: 'automated-smoke-reset',
    status: 'ready',
  },
})})`);
await new Promise((resolve) => setTimeout(resolve, 120));
console.log(JSON.stringify({
  connected: state.connected,
  port: state.port?.path,
  lastDeviceEvent: state.lastDeviceEvent,
  displayCache: display,
  pass: Boolean(state.connected && display?.agentMessageBytes > 0 && display?.inputDraftBytes > 0
    && display?.agentLabelBytes > 0 && display?.draftLabelBytes > 0
    && display?.agentInkPixels > 0 && display?.draftInkPixels > 0),
}, null, 2));
if (!state.connected || !display || display.agentMessageBytes <= 0 || display.inputDraftBytes <= 0
  || display.agentLabelBytes <= 0 || display.draftLabelBytes <= 0
  || display.agentInkPixels <= 0 || display.draftInkPixels <= 0) process.exitCode = 1;
socket.close();
