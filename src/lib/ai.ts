/*
 * ZipRun AI client: talks to /api/ai (NVIDIA Nemotron via Nebius Token Factory or the NVIDIA API),
 * builds project context, and parses the file edits the model proposes.
 */
import { FileMap, isText, toText } from './files';
import type { Analysis, Diagnostic } from './analyze';

export interface AIStatus {
  configured: boolean;
  provider?: string;
  label?: string;
  models?: { code: string; fast: string };
  byo?: boolean;
  locked?: boolean;
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface FileEdit {
  path: string;
  content: string | null; // null = delete
}
export interface StreamResult {
  content: string;
  reasoning: string;
  model: string;
  provider: string;
  tokens: number;
}

const KEY_STORE = 'ziprun:ai-key';
const CODE_STORE = 'ziprun:ai-access';

export function getAccessCode(): string {
  try {
    return localStorage.getItem(CODE_STORE) || '';
  } catch {
    return '';
  }
}
export function setAccessCode(code: string) {
  try {
    if (code) localStorage.setItem(CODE_STORE, code);
    else localStorage.removeItem(CODE_STORE);
  } catch { /* storage unavailable */ }
}

export function getUserKey(): { key: string; provider: 'nvidia' | 'nebius' } | null {
  try {
    const raw = localStorage.getItem(KEY_STORE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
export function setUserKey(v: { key: string; provider: 'nvidia' | 'nebius' } | null) {
  try {
    if (v) localStorage.setItem(KEY_STORE, JSON.stringify(v));
    else localStorage.removeItem(KEY_STORE);
  } catch { /* storage unavailable */ }
}

function authHeaders(): Record<string, string> {
  const u = getUserKey();
  const code = getAccessCode();
  return { ...(u ? { 'x-ai-key': u.key, 'x-ai-provider': u.provider } : {}), ...(code ? { 'x-ai-access': code } : {}) };
}

export async function aiStatus(): Promise<AIStatus> {
  try {
    const res = await fetch('/api/ai', { headers: authHeaders() });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return { configured: false };
    return await res.json();
  } catch {
    return { configured: false };
  }
}

/** Stream a completion. `onDelta` receives the accumulated answer and reasoning so far. */
export async function streamChat(
  opts: { role: 'code' | 'fast'; messages: ChatMessage[]; thinking?: boolean; signal?: AbortSignal },
  onDelta: (content: string, reasoning: string) => void,
): Promise<StreamResult> {
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ role: opts.role, messages: opts.messages, thinking: opts.thinking }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let msg = `AI request failed (HTTP ${res.status}).`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch { /* not JSON */ }
    if (res.status === 404) msg = 'The AI endpoint (/api/ai) was not found. Deploy to Vercel or run `npm run dev` so the server function is available.';
    throw new Error(msg);
  }
  const model = res.headers.get('x-ziprun-model') || '';
  const provider = res.headers.get('x-ziprun-provider') || '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let tokens = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        if (j.error) throw new Error(j.error.message || String(j.error));
        if (j.usage?.total_tokens) tokens = j.usage.total_tokens;
        const delta = j.choices?.[0]?.delta || {};
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        else if (delta.reasoning) reasoning += delta.reasoning;
        if (delta.content) content += delta.content;
      } catch (e) {
        if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
      }
    }
    const split = splitThink(content);
    onDelta(split.content, reasoning + split.reasoning);
  }
  const split = splitThink(content);
  return { content: split.content, reasoning: reasoning + split.reasoning, model, provider, tokens };
}

/** Some models put their reasoning inside <think>…</think> in the main content. */
function splitThink(text: string): { content: string; reasoning: string } {
  const m = text.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
  if (!m) return { content: text, reasoning: '' };
  return { content: text.slice(m[0].length).trimStart(), reasoning: m[1] };
}

// ------------------------------------------------------------------ edits

const FILE_RE = /<<<FILE:\s*([^\n>]+?)\s*\n([\s\S]*?)\n?FILE>>>/g;
const DELETE_RE = /<<<DELETE:\s*([^\n>]+?)\s*>>>/g;

export function parseEdits(text: string): FileEdit[] {
  const edits = new Map<string, FileEdit>();
  let m: RegExpExecArray | null;
  FILE_RE.lastIndex = 0;
  while ((m = FILE_RE.exec(text))) {
    const path = cleanPath(m[1]);
    let body = m[2];
    const fenced = body.match(/^```[\w-]*\n([\s\S]*?)\n?```\s*$/);
    if (fenced) body = fenced[1];
    if (path) edits.set(path, { path, content: body.endsWith('\n') ? body : body + '\n' });
  }
  DELETE_RE.lastIndex = 0;
  while ((m = DELETE_RE.exec(text))) {
    const path = cleanPath(m[1]);
    if (path) edits.set(path, { path, content: null });
  }
  return [...edits.values()];
}

function cleanPath(p: string) {
  return p.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/^\.?\/+/, '');
}

/** Hide raw edit blocks from the chat transcript, leaving a short marker instead. */
export function stripEdits(text: string): string {
  return text
    .replace(FILE_RE, (_, p) => `\n[[edit:${cleanPath(p)}]]\n`)
    .replace(DELETE_RE, (_, p) => `\n[[delete:${cleanPath(p)}]]\n`)
    .replace(/<<<FILE:\s*([^\n>]+?)\s*\n[\s\S]*$/, (_, p) => `\n[[writing:${cleanPath(p)}]]\n`)
    .trim();
}

// ------------------------------------------------------------------ diff

export interface DiffLine {
  type: ' ' | '+' | '-';
  text: string;
}

/** Line diff (LCS) trimmed to changed regions with 3 lines of context. */
export function diffLines(before: string, after: string): { lines: DiffLine[]; added: number; removed: number } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  const ops: DiffLine[] = [];
  if (midA.length * midB.length > 4_000_000) {
    midA.forEach((t) => ops.push({ type: '-', text: t }));
    midB.forEach((t) => ops.push({ type: '+', text: t }));
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ type: ' ', text: midA[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ type: '-', text: midA[i++] });
      else ops.push({ type: '+', text: midB[j++] });
    }
    while (i < n) ops.push({ type: '-', text: midA[i++] });
    while (j < m) ops.push({ type: '+', text: midB[j++] });
  }
  const full: DiffLine[] = [
    ...a.slice(Math.max(0, start - 3), start).map((t) => ({ type: ' ' as const, text: t })),
    ...ops,
    ...a.slice(endA + 1, endA + 4).map((t) => ({ type: ' ' as const, text: t })),
  ];
  return { lines: full, added: ops.filter((o) => o.type === '+').length, removed: ops.filter((o) => o.type === '-').length };
}

// ------------------------------------------------------------------ prompts & context

const EDIT_FORMAT = `When you change files, output the COMPLETE new content of every changed or new file in exactly this format (no markdown fences around it):
<<<FILE: path/relative/to/project/root.ext
...the entire file content...
FILE>>>
To delete a file, output: <<<DELETE: path/to/file.ext>>>
Only output files you actually change. Never abbreviate file content with comments like "rest unchanged".`;

export const SYSTEM = {
  fix: `You are ZipRun Doctor, an expert full-stack engineer embedded in ZipRun, a tool that runs web projects (often generated by ChatGPT, Claude, Codex or Cursor) directly in the browser.
Your job: make the project run correctly with zero errors, with the smallest safe changes.
Rules:
- Fix root causes of every error and warning listed (missing files, broken imports, runtime exceptions, missing dependencies, case-sensitive paths, missing viewport tags…).
- If a referenced asset (image, icon) does not exist, either create a small SVG for it or remove the reference.
- Keep the existing design, stack and behaviour. Do not rewrite unrelated code. Never invent API keys; read secrets from environment variables instead.
- If a dependency is missing from package.json, add it with a sensible version.
Start with 1–3 short sentences explaining what was wrong, then output the file edits.
${EDIT_FORMAT}`,
  edit: `You are ZipRun Doctor, an expert front-end engineer and product designer embedded in ZipRun, which runs the user's web project live in their browser.
Answer questions about the project concisely. When the user asks for a change (feature, design, bug fix, refactor), implement it with high-quality, working code that matches the existing stack and style.
Start with a short explanation of what you did (or the answer), then output file edits if any.
${EDIT_FORMAT}`,
  review: `You are a senior product designer and accessibility expert. You are given the live DOM outline of a web app running in ZipRun plus its source.
Give a crisp UI/UX review: a score out of 10, then the 5 highest-impact improvements (visual hierarchy, spacing, typography, colour/contrast, responsiveness on mobile, accessibility, copy, empty/error states). Be specific about elements.
Then implement the improvements that are safe to make in code.
${EDIT_FORMAT}`,
  explain: `You are ZipRun Doctor. Explain this project to someone who did not write it (they may have generated it with AI and are not a developer).
Use short markdown sections: **What it is** (2 sentences), **How it works** (key files and data flow, bullet list), **Tech stack**, **How to run it locally**, **Risks & next steps** (3 bullets). Be concrete and brief. Do not output file edits.`,
};

export interface ContextInput {
  files: FileMap;
  analysis: Analysis;
  problems: Diagnostic[];
  logs: { level: string; text: string }[];
  failedRequests: string[];
  mode: string;
}

const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$|\.(min\.js|map)$/;

export function buildContext(c: ContextInput, budget = 90_000, focus: string[] = []): string {
  const { files, analysis: a } = c;
  const errors = c.logs.filter((l) => l.level === 'error' || l.level === 'warn').slice(-30);
  let out = `# Project: ${a.name}\nStack: ${a.stack.join(', ') || 'unknown'} · ${a.summary} · running in ${c.mode} mode\n\n`;
  const issues = c.problems.filter((d) => d.severity !== 'info');
  if (issues.length) {
    out += '## Detected problems\n';
    for (const d of issues) out += `- [${d.severity}] ${d.title}${d.file ? ` (${d.file}${d.line ? ':' + d.line : ''})` : ''}${d.detail ? ' — ' + d.detail : ''}\n`;
    out += '\n';
  }
  if (errors.length) out += '## Runtime console (errors/warnings)\n```\n' + errors.map((l) => `[${l.level}] ${l.text}`).join('\n').slice(0, 8000) + '\n```\n\n';
  if (c.failedRequests.length) out += '## Failed requests (404s)\n' + c.failedRequests.slice(0, 20).map((r) => '- ' + r).join('\n') + '\n\n';
  out += '## File tree\n```\n' + [...files.keys()].slice(0, 300).join('\n') + '\n```\n\n';

  // Rank files: problem files and focus files first, then entry points, then small source files.
  const mentioned = new Set<string>(focus);
  for (const d of c.problems) if (d.file) mentioned.add(d.file);
  for (const l of errors) {
    for (const m of l.text.matchAll(/\/?((?:[\w.-]+\/)*[\w.-]+\.(?:jsx?|tsx?|mjs|css|html|json|vue|svelte))/g)) {
      const p = m[1].replace(/^\//, '');
      if (files.has(p)) mentioned.add(p);
    }
  }
  const entry = ['package.json', 'index.html', 'src/main.jsx', 'src/main.tsx', 'src/index.jsx', 'src/index.tsx', 'src/index.js', 'src/App.jsx', 'src/App.tsx', 'App.jsx', 'App.tsx', 'vite.config.js', 'vite.config.ts'];
  const rest = [...files.keys()]
    .filter((p) => !SKIP.test(p) && isText(p, files.get(p)!) && !p.startsWith('public/'))
    .sort((x, y) => files.get(x)!.length - files.get(y)!.length);
  const order = [...mentioned, ...entry.filter((p) => files.has(p)), ...rest];
  const seen = new Set<string>();
  let used = out.length;
  out += '## Files\n';
  for (const p of order) {
    if (seen.has(p) || !files.has(p) || SKIP.test(p)) continue;
    seen.add(p);
    const d = files.get(p)!;
    if (!isText(p, d)) continue;
    let body = toText(d);
    if (body.length > 40_000) body = body.slice(0, 40_000) + '\n/* …truncated by ZipRun… */';
    const block = `\n### ${p}\n\`\`\`\n${body}\n\`\`\`\n`;
    if (used + block.length > budget) continue;
    used += block.length;
    out += block;
  }
  return out;
}

export function friendlyModel(id: string): string {
  const name = id.split('/').pop() || id;
  return name.replace(/[-_]/g, ' ').replace(/\b(\w)/g, (c) => c.toUpperCase()).replace(/ (\d+)b\b/gi, ' $1B');
}
