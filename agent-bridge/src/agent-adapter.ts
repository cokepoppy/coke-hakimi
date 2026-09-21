import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentSnapshot } from './protocol';

type JsonRecord = Record<string, unknown>;

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  discover(): Promise<boolean>;
  snapshot(): Promise<AgentSnapshot>;
}

function clampText(value: unknown, max = 220): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, '')
    .replace(/```[\s\S]*?```/g, '[code omitted]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, max) : undefined;
}

function compactText(value: unknown, max = 180): string | undefined {
  const clean = clampText(value, Number.MAX_SAFE_INTEGER);
  if (!clean) return undefined;
  if (clean.length <= max) return clean;
  const head = Math.max(32, Math.floor(max * 0.55));
  const tail = Math.max(24, max - head - 5);
  return `${clean.slice(0, head)} ... ${clean.slice(-tail)}`;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function recordPayload(record: JsonRecord): JsonRecord {
  return asRecord(record.payload) || record;
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
    const lines = readFileSync(path, 'utf8').split('\n').slice(-240);
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

function assistantContentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const type = String(record.type || '').toLowerCase();
    if (type && !['text', 'output_text', 'input_text'].includes(type)) continue;
    if (typeof record.text === 'string') parts.push(record.text);
  }
  return parts.join('\n');
}

function stateFromCodexRecord(record: JsonRecord): AgentSnapshot['state'] | undefined {
  const payload = recordPayload(record);
  const type = String(payload.type || '').toLowerCase();
  const status = String(payload.status || payload.state || '').toLowerCase();
  const raw = `${type} ${status}`;
  if (/task_complete|turn_complete|turn_completed|success|finished/.test(raw)) return 'done';
  if (/abort|error|failed|failure/.test(raw)) return 'error';
  if (/wait|approval|confirm|request_user_input/.test(raw)) return 'waiting_user';
  if (type === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer') return 'done';
  if (/turn_started|task_started|function_call|reasoning|tool/.test(raw)) return 'working';
  return undefined;
}

function textFromCodexRecord(record: JsonRecord): { text?: string; final: boolean } {
  const payload = recordPayload(record);
  const type = String(payload.type || '').toLowerCase();
  if (type === 'task_complete' && typeof payload.last_agent_message === 'string') {
    return { text: payload.last_agent_message, final: true };
  }
  if (type !== 'message' || payload.role !== 'assistant') return { final: false };
  return {
    text: assistantContentText(payload.content),
    final: payload.phase === 'final_answer',
  };
}

type CodexSessionData = {
  state?: AgentSnapshot['state'];
  summary?: string;
  title?: string;
  projectPath?: string;
  sessionId?: string;
};

function extractCodexSessionData(records: JsonRecord[]): CodexSessionData {
  let state: AgentSnapshot['state'] | undefined;
  let latestAssistant: string | undefined;
  let latestFinal: string | undefined;
  let title: string | undefined;
  let projectPath: string | undefined;
  let sessionId: string | undefined;

  for (const record of records) {
    const payload = recordPayload(record);
    state = stateFromCodexRecord(record) ?? state;
    if (typeof payload.title === 'string') title = payload.title;
    if (typeof payload.sessionTitle === 'string') title = payload.sessionTitle;
    if (typeof payload.cwd === 'string') projectPath = payload.cwd;
    if (typeof payload.workdir === 'string') projectPath = payload.workdir;
    if (typeof payload.thread_id === 'string') sessionId = payload.thread_id;
    if (typeof payload.session_id === 'string') sessionId = payload.session_id;

    const output = textFromCodexRecord(record);
    if (output.text) {
      latestAssistant = output.text;
      if (output.final) latestFinal = output.text;
    }
  }

  const selectedText = state === 'done'
    ? latestFinal || latestAssistant
    : latestAssistant || latestFinal;
  return {
    state,
    summary: compactText(selectedText),
    title: clampText(title, 96),
    projectPath: clampText(projectPath, 220),
    sessionId: clampText(sessionId, 120),
  };
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
    const data = extractCodexSessionData(records);
    const state: AgentSnapshot['state'] = data.state || (processLooksAlive() ? 'working' : 'idle');

    const project = projectFromPath(data.projectPath);
    return {
      agentId: this.id,
      agentName: this.name,
      projectName: project.name,
      projectPath: project.path,
      sessionId: data.sessionId,
      title: data.title,
      state,
      // The device already has a dedicated status area.  Do not turn the
      // terminal's presentation label into part of the user-facing answer.
      stage: data.summary && state !== 'done' ? 'latest output' : undefined,
      summary: data.summary,
      lastLog: data.summary,
      updatedAt: recent.mtime || Date.now(),
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
