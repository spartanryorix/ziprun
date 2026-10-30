import { Fragment, useEffect, useRef, useState } from 'react';
import {
  Bot, Brain, Check, ChevronDown, ChevronRight, Copy, Cpu, FileCode2, KeyRound, Loader2, Palette, Send, Settings, Sparkles,
  Square, Undo2, Wand2, X, BookOpen, CircleCheck, CircleAlert,
} from 'lucide-react';
import {
  AIStatus, ChatMessage, ContextInput, FileEdit, SYSTEM, buildContext, diffLines, friendlyModel, getAccessCode, getUserKey, parseEdits, setAccessCode,
  setUserKey, stripEdits, streamChat,
} from '../lib/ai';
import { healthScore } from '../lib/analyze';

type EditState = FileEdit & { before: string | null; status: 'pending' | 'applied' | 'rejected' };
interface Step {
  label: string;
  state: 'running' | 'done' | 'error';
}
interface Msg {
  id: number;
  role: 'user' | 'assistant';
  kind?: 'fix' | 'edit' | 'review' | 'explain';
  text: string;
  reasoning?: string;
  edits?: EditState[];
  model?: string;
  provider?: string;
  tokens?: number;
  error?: string;
  steps?: Step[];
  streaming?: boolean;
  score?: { before: number; after?: number };
}

interface Props {
  status: AIStatus | null;
  onStatusChange(): void;
  getContext(): ContextInput;
  getFile(path: string): string | null;
  applyEdits(edits: FileEdit[]): Promise<void>;
  getOutline(): Promise<string>;
  takeSnapshot(): void;
  canUndo: boolean;
  onUndo(): void;
  autoFixNonce: number;
  onOpenFile(path: string): void;
  onCopyPrompt(): void;
}

const runtimeErrors = (c: ContextInput) => c.logs.filter((l) => l.level === 'error').length;
const issueCount = (c: ContextInput) => c.problems.filter((d) => d.severity !== 'info').length + runtimeErrors(c) + c.failedRequests.length;
const scoreOf = (c: ContextInput) => healthScore(c.problems, Math.min(runtimeErrors(c), 4));

export default function AIPanel(p: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const lastNonce = useRef(p.autoFixNonce);
  const configured = !!p.status?.configured && !p.status.locked;

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);

  useEffect(() => {
    if (p.autoFixNonce !== lastNonce.current) {
      lastNonce.current = p.autoFixNonce;
      if (configured && !busy) autoFix();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.autoFixNonce, configured]);

  const update = (id: number, patch: Partial<Msg> | ((m: Msg) => Partial<Msg>)) =>
    setMsgs((list) => list.map((m) => (m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)));
  const push = (m: Omit<Msg, 'id'>) => {
    const id = ++idRef.current;
    setMsgs((list) => [...list, { ...m, id }]);
    return id;
  };
  const withBefore = (edits: FileEdit[], status: EditState['status']): EditState[] =>
    edits.map((e) => ({ ...e, before: p.getFile(e.path), status }));

  async function run(kind: Msg['kind'], fn: (id: number, signal: AbortSignal) => Promise<void>, userText?: string) {
    if (busy) return;
    if (userText) push({ role: 'user', text: userText });
    const id = push({ role: 'assistant', kind, text: '', streaming: true });
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    try {
      await fn(id, ctrl.signal);
    } catch (e: any) {
      update(id, { error: ctrl.signal.aborted ? 'Stopped.' : e?.message || String(e) });
    } finally {
      update(id, (m) => ({ streaming: false, steps: m.steps?.map((s) => (s.state === 'running' ? { ...s, state: 'error' } : s)) }));
      setBusy(false);
      abort.current = null;
    }
  }

  async function ask(id: number, signal: AbortSignal, role: 'code' | 'fast', messages: ChatMessage[], thinking = true) {
    const res = await streamChat({ role, messages, signal, thinking }, (content, reasoning) => update(id, { text: content, reasoning }));
    update(id, (m) => ({ text: res.content, reasoning: res.reasoning, model: res.model, provider: res.provider, tokens: (m.tokens || 0) + res.tokens }));
    return res;
  }

  // ---------------------------------------------------------------- agent: auto-fix loop
  function autoFix() {
    run('fix', async (id, signal) => {
      const first = p.getContext();
      const before = scoreOf(first);
      update(id, { score: { before }, steps: [] });
      if (issueCount(first) === 0) {
        update(id, { text: 'No errors or warnings detected. Your project already runs cleanly! 🎉 Try **Review UI** for design improvements.', score: { before, after: before } });
        return;
      }
      p.takeSnapshot();
      const all: EditState[] = [];
      for (let pass = 1; pass <= 3; pass++) {
        const ctx = p.getContext();
        const n = issueCount(ctx);
        if (pass > 1 && n === 0) break;
        const stepLabel = `Pass ${pass}: analysing ${n} problem${n === 1 ? '' : 's'}`;
        update(id, (m) => ({ steps: [...(m.steps || []), { label: stepLabel, state: 'running' }] }));
        const res = await ask(id, signal, 'code', [
          { role: 'system', content: SYSTEM.fix },
          { role: 'user', content: buildContext(ctx) + '\n\nFix every detected problem so the app runs with zero errors.' },
        ]);
        const edits = parseEdits(res.content);
        const setStep = (label: string, state: Step['state']) =>
          update(id, (m) => ({ steps: m.steps!.map((s, i) => (i === m.steps!.length - 1 ? { label, state } : s)) }));
        if (!edits.length) {
          setStep(`Pass ${pass}: no code changes proposed`, 'done');
          break;
        }
        const states = withBefore(edits, 'applied');
        all.push(...states.filter((s) => !all.some((a) => a.path === s.path)));
        update(id, { edits: [...all] });
        setStep(`Pass ${pass}: applying ${edits.length} file change${edits.length === 1 ? '' : 's'} and re-running…`, 'running');
        await p.applyEdits(edits);
        const after = p.getContext();
        const left = issueCount(after);
        setStep(`Pass ${pass}: edited ${edits.map((e) => e.path.split('/').pop()).join(', ')} → ${left ? `${left} problem${left === 1 ? '' : 's'} left` : 'all clear'}`, 'done');
        update(id, { score: { before, after: scoreOf(after) } });
        if (!left) break;
      }
      const final = p.getContext();
      update(id, { score: { before, after: scoreOf(final) } });
    });
  }

  function explain() {
    run('explain', async (id, signal) => {
      await ask(id, signal, 'fast', [
        { role: 'system', content: SYSTEM.explain },
        { role: 'user', content: buildContext(p.getContext(), 50_000) },
      ], false);
    }, 'Explain this project');
  }

  function review() {
    run('review', async (id, signal) => {
      update(id, { steps: [{ label: 'Reading the live page layout…', state: 'running' }] });
      const outline = await p.getOutline();
      update(id, { steps: [{ label: outline ? 'Captured the rendered page structure' : 'Preview not ready — reviewing source only', state: 'done' }] });
      const res = await ask(id, signal, 'code', [
        { role: 'system', content: SYSTEM.review },
        { role: 'user', content: (outline ? '## Live DOM outline (rendered in the preview)\n```\n' + outline + '\n```\n\n' : '') + buildContext(p.getContext(), 70_000) },
      ]);
      const edits = parseEdits(res.content);
      if (edits.length) update(id, { edits: withBefore(edits, 'pending') });
    }, 'Review the UI & UX');
  }

  function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const history: ChatMessage[] = msgs
      .filter((m) => m.text && !m.error)
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.role === 'assistant' ? stripEdits(m.text).slice(0, 4000) : m.text }));
    run('edit', async (id, signal) => {
      const res = await ask(id, signal, 'code', [
        { role: 'system', content: SYSTEM.edit },
        { role: 'user', content: buildContext(p.getContext(), 80_000) + '\n\n(The project context above is current.)' },
        { role: 'assistant', content: 'Understood. I have the full project context.' },
        ...history,
        { role: 'user', content: text },
      ]);
      const edits = parseEdits(res.content);
      if (edits.length) update(id, { edits: withBefore(edits, 'pending') });
    }, text);
  }

  async function applyOne(msgId: number, paths: string[]) {
    const m = msgs.find((x) => x.id === msgId);
    if (!m?.edits) return;
    const chosen = m.edits.filter((e) => paths.includes(e.path) && e.status === 'pending');
    if (!chosen.length) return;
    p.takeSnapshot();
    update(msgId, { edits: m.edits.map((e) => (paths.includes(e.path) && e.status === 'pending' ? { ...e, status: 'applied' } : e)) });
    await p.applyEdits(chosen);
  }
  const reject = (msgId: number, path: string) =>
    update(msgId, (m) => ({ edits: m.edits?.map((e) => (e.path === path ? { ...e, status: 'rejected' } : e)) }));

  const modelLabel = p.status?.models ? friendlyModel(p.status.models.code) : '';

  return (
    <div className="ai">
      <div className="ai-head">
        <div className="ai-title"><Bot size={16} />ZipRun Doctor</div>
        <button className="icon-btn" title="AI settings" onClick={() => setShowSettings((s) => !s)}><Settings size={15} /></button>
      </div>
      <div className="ai-model">
        <Cpu size={12} />
        {configured ? <span>{modelLabel} · {p.status!.label}{p.status!.byo ? ' (your key)' : ''}</span> : <span>{p.status?.locked ? 'AI locked: enter the access code' : 'AI not configured'}</span>}
      </div>

      {(showSettings || (p.status && !configured)) && <KeySettings status={p.status} onSaved={() => { setShowSettings(false); p.onStatusChange(); }} />}

      <div className="ai-actions">
        <button className="ai-action primary" disabled={!configured || busy} onClick={autoFix}>
          <Wand2 size={15} /><div><b>Auto-fix</b><span>Agent fixes errors, re-runs, repeats</span></div>
        </button>
        <button className="ai-action" disabled={!configured || busy} onClick={review}>
          <Palette size={15} /><div><b>Review UI</b><span>Design & accessibility pass</span></div>
        </button>
        <button className="ai-action" disabled={!configured || busy} onClick={explain}>
          <BookOpen size={15} /><div><b>Explain</b><span>What this project does</span></div>
        </button>
      </div>
      {p.canUndo && !busy && <button className="btn sm" style={{ margin: '0 12px 8px' }} onClick={p.onUndo}><Undo2 size={13} />Undo all AI changes</button>}

      <div className="ai-log">
        {!msgs.length && (
          <div className="ai-empty">
            <Sparkles size={22} color="var(--accent-2)" />
            <p>Ask anything about this project, or describe a change:</p>
            {['Make it look more modern', 'Add a dark mode toggle', 'Make the layout mobile friendly', 'Why is the page blank?'].map((s) => (
              <button key={s} className="chip" disabled={!configured} onClick={() => setInput(s)}>{s}</button>
            ))}
          </div>
        )}
        {msgs.map((m) => (m.role === 'user'
          ? <div key={m.id} className="ai-msg user">{m.text}</div>
          : <AssistantMsg key={m.id} m={m} onApply={(paths) => applyOne(m.id, paths)} onReject={(path) => reject(m.id, path)} onOpen={p.onOpenFile} />))}
        <div ref={end} />
      </div>

      <form className="ai-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder={configured ? 'Ask or describe a change…' : 'Add an API key to chat'} rows={2} disabled={!configured}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {busy
          ? <button type="button" className="icon-btn active" title="Stop" onClick={() => abort.current?.abort()}><Square size={14} /></button>
          : <button type="submit" className="icon-btn active" title="Send" disabled={!input.trim() || !configured}><Send size={14} /></button>}
      </form>
      <button className="ai-copy" onClick={p.onCopyPrompt}><Copy size={11} />Copy a prompt for ChatGPT/Claude instead</button>
    </div>
  );
}

function KeySettings({ status, onSaved }: { status: AIStatus | null; onSaved(): void }) {
  const existing = getUserKey();
  const [code, setCode] = useState(getAccessCode());
  const [key, setKey] = useState(existing?.key || '');
  const [provider, setProvider] = useState<'nvidia' | 'nebius'>(existing?.provider || 'nebius');
  return (
    <div className="ins-card" style={{ margin: '0 12px 10px' }}>
      {(status?.locked || getAccessCode()) && (
        <>
          <h4><KeyRound size={13} />Access code</h4>
          <p className="hint">The owner protects this site’s AI credit with an access code.</p>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <input className="field" type="password" placeholder="Access code" value={code} onChange={(e) => setCode(e.target.value)} />
            <button className="btn sm primary" disabled={!code.trim()} onClick={() => { setAccessCode(code.trim()); onSaved(); }}>Unlock</button>
          </div>
        </>
      )}
      <h4><KeyRound size={13} />{status?.locked ? 'Or use your own API key' : 'API key'}</h4>
      {!status?.configured && <p className="hint">This deployment has no server key. The owner can add <code>NEBIUS_API_KEY</code> or <code>NVIDIA_API_KEY</code> in Vercel → Settings → Environment Variables, or you can use your own key below.</p>}
      <select className="field" value={provider} onChange={(e) => setProvider(e.target.value as 'nvidia' | 'nebius')} style={{ marginBottom: 6 }}>
        <option value="nebius">Nebius Token Factory</option>
        <option value="nvidia">NVIDIA API (build.nvidia.com)</option>
      </select>
      <input className="field" type="password" placeholder="Paste your API key" value={key} onChange={(e) => setKey(e.target.value)} />
      <p className="hint" style={{ marginTop: 6 }}>Stored only in this browser and sent only to ZipRun’s own server function to call the model.</p>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn sm primary" disabled={!key.trim()} onClick={() => { setUserKey({ key: key.trim(), provider }); onSaved(); }}>Save key</button>
        {existing && <button className="btn sm" onClick={() => { setUserKey(null); setKey(''); onSaved(); }}>Remove</button>}
      </div>
    </div>
  );
}

function AssistantMsg({ m, onApply, onReject, onOpen }: { m: Msg; onApply(paths: string[]): void; onReject(path: string): void; onOpen(p: string): void }) {
  const [showThink, setShowThink] = useState(false);
  const pending = m.edits?.filter((e) => e.status === 'pending') || [];
  const text = stripEdits(m.text);
  return (
    <div className="ai-msg bot">
      {m.score && (
        <div className="ai-score">
          <span>Health</span><b className={scoreClass(m.score.before)}>{m.score.before}</b>
          {m.score.after !== undefined && <><span>→</span><b className={scoreClass(m.score.after)}>{m.score.after}</b></>}
        </div>
      )}
      {m.steps && m.steps.length > 0 && (
        <div className="ai-steps">
          {m.steps.map((s, i) => (
            <div key={i} className={'ai-step ' + s.state}>
              {s.state === 'running' ? <Loader2 size={13} className="spin" /> : s.state === 'done' ? <CircleCheck size={13} /> : <CircleAlert size={13} />}
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      )}
      {m.reasoning && (
        <div className="ai-think">
          <button onClick={() => setShowThink(!showThink)}>
            {showThink ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Brain size={12} />
            {m.streaming && !m.text ? 'Thinking…' : 'Reasoning'}
          </button>
          {showThink && <pre>{m.reasoning}</pre>}
        </div>
      )}
      {text ? <Markdown text={text} onOpen={onOpen} /> : m.streaming && !m.reasoning ? <div className="muted"><Loader2 size={13} className="spin" /> Working…</div> : null}
      {m.edits && m.edits.length > 0 && (
        <div className="ai-edits">
          {m.edits.map((e) => <EditCard key={e.path} e={e} onApply={() => onApply([e.path])} onReject={() => onReject(e.path)} onOpen={() => onOpen(e.path)} />)}
          {pending.length > 1 && <button className="btn sm primary" onClick={() => onApply(pending.map((e) => e.path))}><Check size={13} />Apply all {pending.length} changes</button>}
        </div>
      )}
      {m.error && <div className="ai-error"><X size={13} />{m.error}</div>}
      {m.model && !m.streaming && <div className="ai-meta">{friendlyModel(m.model)}{m.provider ? ' · ' + m.provider : ''}{m.tokens ? ` · ${m.tokens.toLocaleString()} tokens` : ''}</div>}
    </div>
  );
}

function scoreClass(n: number) {
  return n >= 85 ? 'good' : n >= 60 ? 'mid' : 'bad';
}

function EditCard({ e, onApply, onReject, onOpen }: { e: EditState; onApply(): void; onReject(): void; onOpen(): void }) {
  const [open, setOpen] = useState(false);
  const diff = e.content === null ? null : diffLines(e.before ?? '', e.content);
  return (
    <div className={'edit-card ' + e.status}>
      <div className="edit-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <FileCode2 size={13} />
        <span className="edit-path" title={e.path}>{e.path}</span>
        {e.content === null ? <span className="tag del">deleted</span> : e.before === null ? <span className="tag add">new</span> : null}
        {diff && <span className="edit-stat"><i className="add">+{diff.added}</i> <i className="del">−{diff.removed}</i></span>}
        {e.status === 'pending' ? (
          <span className="edit-btns" onClick={(ev) => ev.stopPropagation()}>
            <button className="btn sm primary" onClick={onApply}>Apply</button>
            <button className="icon-btn" title="Reject" onClick={onReject}><X size={13} /></button>
          </span>
        ) : (
          <span className={'tag ' + (e.status === 'applied' ? 'add' : 'del')}>{e.status}</span>
        )}
      </div>
      {open && (
        <div className="diff">
          {diff ? diff.lines.slice(0, 600).map((l, i) => <div key={i} className={'dl ' + (l.type === '+' ? 'a' : l.type === '-' ? 'r' : '')}><span>{l.type}</span>{l.text || ' '}</div>) : <div className="dl r">File will be deleted</div>}
          {e.status !== 'rejected' && e.content !== null && <button className="btn sm" style={{ margin: 6 }} onClick={onOpen}>Open in editor</button>}
        </div>
      )}
    </div>
  );
}

/** Tiny markdown renderer: headings, bullets, code fences, inline code, bold, and edit markers. */
function Markdown({ text, onOpen }: { text: string; onOpen(p: string): void }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split('\n');
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{inline(l, onOpen)}</li>)}</ul>);
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      blocks.push(<pre key={blocks.length} className="ai-code">{code.join('\n')}</pre>);
      continue;
    }
    const marker = line.match(/^\[\[(edit|delete|writing):(.+)\]\]$/);
    if (marker) {
      flush();
      blocks.push(
        <div key={blocks.length} className="ai-marker" onClick={() => marker[1] !== 'delete' && onOpen(marker[2])}>
          {marker[1] === 'writing' ? <Loader2 size={12} className="spin" /> : <FileCode2 size={12} />}
          {marker[1] === 'edit' ? 'Edited' : marker[1] === 'delete' ? 'Deleted' : 'Writing'} <code>{marker[2]}</code>
        </div>,
      );
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) { list.push(bullet[1]); continue; }
    flush();
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) blocks.push(<h5 key={blocks.length}>{inline(h[1], onOpen)}</h5>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line, onOpen)}</p>);
  }
  flush();
  return <div className="md">{blocks}</div>;
}

function inline(s: string, onOpen: (p: string) => void): React.ReactNode {
  const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      const code = part.slice(1, -1);
      const looksLikeFile = /^[\w./-]+\.\w{1,5}$/.test(code);
      return <code key={i} className={looksLikeFile ? 'link' : ''} onClick={looksLikeFile ? () => onOpen(code) : undefined}>{code}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) return <b key={i}>{part.slice(2, -2)}</b>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}
