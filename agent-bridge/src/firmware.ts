import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ChipIdentity } from './protocol';

const execFileAsync = promisify(execFile);

function classify(revision: number): ChipIdentity['family'] {
  if (revision >= 300 && revision < 400) return 'v3';
  if (revision > 0 && revision < 200) return 'v1';
  return 'unknown';
}

export async function identifyP4Chip(portPath: string): Promise<ChipIdentity> {
  // PlatformIO already ships a compatible esptool in its own Python
  // environment. Prefer it so a clean macOS machine does not need a separate
  // global `pip install esptool`; fall back to python3 for other setups.
  const pythonCandidates = [
    join(homedir(), '.platformio', 'penv', 'bin', 'python'),
    'python3',
  ].filter((candidate, index, all) =>
    (index === 1 || existsSync(candidate)) && all.indexOf(candidate) === index,
  );
  let raw = '';
  let lastError: unknown;
  for (const python of pythonCandidates) {
    try {
      const result = await execFileAsync(
        python,
        ['-m', 'esptool', '--no-stub', '--chip', 'esp32p4', '--port', portPath, 'chip-id'],
        { timeout: 15000, env: process.env },
      );
      raw = `${result.stdout}\n${result.stderr}`.trim();
      break;
    } catch (error) {
      lastError = error;
      const failed = error as { stdout?: string; stderr?: string };
      const output = `${failed.stdout || ''}\n${failed.stderr || ''}`.trim();
      if (/ESP32-P4|revision\s+v\d/i.test(output)) {
        raw = output;
        break;
      }
    }
  }
  if (!raw) throw lastError instanceof Error ? lastError : new Error('esptool 未找到或无法读取芯片');
  const revisionMatch = raw.match(/revision\s+v(\d+)(?:\.(\d+))?/i);
  const revision = revisionMatch
    ? Number(revisionMatch[1]) * 100 + Number(revisionMatch[2] || 0)
    : 0;
  const mac = raw.match(/MAC:\s*([0-9a-f:]{17})/i)?.[1]?.toLowerCase();
  return {
    chip: /ESP32-P4/i.test(raw) ? 'ESP32-P4' : 'unknown',
    revisionText: revisionMatch ? `v${revisionMatch[1]}.${revisionMatch[2] || '0'}` : 'unknown',
    revision,
    family: classify(revision),
    mac,
    raw: raw.slice(0, 2000),
  };
}
