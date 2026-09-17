import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentSnapshot } from './protocol';

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  discover(): Promise<boolean>;
  snapshot(): Promise<AgentSnapshot>;
}

function clampText(value: unknown, max = 180): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : undefined;
}

function projectFromPath(path?: string): { name?: string; path?: string } {
  if (!path) return {};
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return { name: clean.split('/').pop() || clean, path: clean };
}

function findRecentCodexFile(): { path?: string; mtime?: number } {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return {};
  let best: { path?: string; mtime?: number } = {};
  const walk = (directory: string, depth: number) => {
    if (depth > 5) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && /\.(jsonl|json)$/.test(entry.name)) {
        try {
          const mtime = statSync(full).mtimeMs;
          if (!best.mtime || mtime > best.mtime) best = { path: full, mtime };
        } catch {
          // A session can disappear while Codex rotates its files.
        }
      }
    }
  };
  walk(root, 0);
  return best;
}

function readRecentJsonl(path?: string): Record<string, unknown>[] {
  if (!path) return [];
  try {
    const lines = readFileSync(path, 'utf8').split('\n').slice(-80);
    return lines.flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === 'object' ? [value as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function textFromRecord(record: Record<string, unknown>): string | undefined {
  const candidates = [record.text, record.message, record.content, record.title, record.summary];
  for (const candidate of candidates) {
    const text = clampText(candidate);
    if (text) return text;
  }
  return undefined;
}

function stateFromRecord(record: Record<string, unknown>): AgentSnapshot['state'] | undefined {
  const raw = String(record.state ?? record.status ?? record.type ?? '').toLowerCase();
  if (/error|failed|failure/.test(raw)) return 'error';
  if (/wait|approval|confirm/.test(raw)) return 'waiting_user';
  if (/done|complete|finished|success/.test(raw)) return 'done';
  if (/work|run|tool|turn|think|command|edit/.test(raw)) return 'working';
  return undefined;
}

function processLooksAlive(): boolean {
  // This is intentionally a best-effort signal. The adapter never claims that
  // a session is active solely because a process exists.
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    execFileSync('pgrep', ['-x', 'Codex'], { stdio: 'ignore' });
    return true;
  } catch {
    // The macOS desktop app currently has a ChatGPT process name while its
    // Codex renderer runs as a child process. Treat the regular app process as
    // a discovery hint, then let the session log decide the actual state.
    try {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      execFileSync('pgrep', ['-x', 'ChatGPT'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly name = 'Codex';

  async discover(): Promise<boolean> {
    return processLooksAlive() || Boolean(findRecentCodexFile().path);
  }

  async snapshot(): Promise<AgentSnapshot> {
    const recent = findRecentCodexFile();
    const records = readRecentJsonl(recent.path);
    let state: AgentSnapshot['state'] = processLooksAlive() ? 'working' : 'idle';
    let summary: string | undefined;
    let title: string | undefined;
    let projectPath: string | undefined;
    let sessionId: string | undefined;

    for (const record of records) {
      state = stateFromRecord(record) ?? state;
      title ||= clampText(record.title ?? record.sessionTitle ?? record.name, 96);
      summary = textFromRecord(record) ?? summary;
      projectPath ||= clampText(record.cwd ?? record.workdir ?? record.projectPath, 220);
      sessionId ||= clampText(record.sessionId ?? record.id, 120);
    }

    const project = projectFromPath(projectPath);
    return {
      agentId: this.id,
      agentName: this.name,
      projectName: project.name,
      projectPath: project.path,
      sessionId,
      title,
      state,
      stage: state === 'working' ? 'observing session' : undefined,
      summary,
      lastLog: summary,
      updatedAt: Date.now(),
    };
  }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';

  async discover(): Promise<boolean> {
    try {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      execFileSync('pgrep', ['-f', 'claude'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<AgentSnapshot> {
    const active = await this.discover();
    return {
      agentId: this.id,
      agentName: this.name,
      state: active ? 'working' : 'idle',
      stage: active ? 'process detected' : undefined,
      updatedAt: Date.now(),
    };
  }
}

export class AgentRegistry {
  private readonly adapters: AgentAdapter[] = [new CodexAdapter(), new ClaudeCodeAdapter()];

  async snapshots(): Promise<AgentSnapshot[]> {
    const snapshots: AgentSnapshot[] = [];
    for (const adapter of this.adapters) {
      if (await adapter.discover()) snapshots.push(await adapter.snapshot());
    }
    if (snapshots.length === 0) {
      snapshots.push({
        agentId: 'bridge',
        agentName: 'Agent Bridge',
        state: 'disconnected',
        summary: '未发现运行中的 Agent',
        updatedAt: Date.now(),
      });
    }
    return snapshots;
  }
}
