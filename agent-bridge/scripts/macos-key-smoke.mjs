#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const helper = fileURLToPath(new URL('../dist/macos-helper', import.meta.url));

async function invoke(...args) {
  const result = await execFileAsync(helper, args, { timeout: 3000 });
  return JSON.parse(result.stdout.trim());
}

let downState;
let upState;
try {
  await invoke('key', 'fn', 'down');
  downState = await invoke('modifier-state');
  await invoke('key', 'fn', 'up');
  upState = await invoke('modifier-state');
} finally {
  // Never leave the real machine with a synthetic modifier held when a smoke
  // assertion or helper invocation fails halfway through.
  await invoke('key', 'fn', 'up').catch(() => undefined);
}

const pass = downState?.fn === true && upState?.fn === false;
console.log(JSON.stringify({ downState, upState, pass }, null, 2));
if (!pass) process.exitCode = 1;
