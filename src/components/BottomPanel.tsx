import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { AlertCircle, AlertTriangle, Ban, ChevronDown, ChevronRight, ChevronUp, Info } from 'lucide-react';
import type { Diagnostic } from '../lib/analyze';

export interface LogEntry {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'result' | 'system' | 'input';
  text: string;
  time: number;
  count: number;
}
export interface NetEntry {
  id: number;
  method: string;
  path: string;
  status: number;
  type: string;
  size: number;
  ms: number;
  kind: string;
}
export type BottomTab = 'console' | 'network' | 'terminal' | 'problems';

export interface TerminalHandle {
  write(data: string): void;
  clear(): void;
  size(): { cols: number; rows: number };
}

const Term = forwardRef<TerminalHandle, { onInput(d: string): void; onResize(cols: number, rows: number): void; visible: boolean }>(
  function Term({ onInput, onResize, visible }, ref) {
    const el = useRef<HTMLDivElement>(null);
    const term = useRef<XTerm | null>(null);
    const fit = useRef<FitAddon | null>(null);
    const pending = useRef<string[]>([]);
    const handlers = useRef({ onInput, onResize });
    handlers.current = { onInput, onResize };

    useImperativeHandle(ref, () => ({
      write: (d) => (term.current ? term.current.write(d) : pending.current.push(d)),
      clear: () => term.current?.clear(),
      size: () => ({ cols: term.current?.cols || 100, rows: term.current?.rows || 20 }),
    }));

    useEffect(() => {
      const t = new XTerm({
        convertEol: true, cursorBlink: true, fontSize: 12.5, fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        theme: { background: '#0b0d12', foreground: '#e6e8ee', cursor: '#9d85ff', selectionBackground: '#7c5cff55' },
      });
      const f = new FitAddon();
      t.loadAddon(f);
      t.open(el.current!);
      term.current = t;
      fit.current = f;
      pending.current.forEach((d) => t.write(d));
      pending.current = [];
      const sub = t.onData((d) => handlers.current.onInput(d));
      const ro = new ResizeObserver(() => {
        try {
          if (el.current && el.current.clientWidth > 0) {
            f.fit();
            handlers.current.onResize(t.cols, t.rows);
          }
        } catch { /* not visible yet */ }
      });
      ro.observe(el.current!);
      return () => { sub.dispose(); ro.disconnect(); t.dispose(); term.current = null; };
    }, []);

    useEffect(() => {
      if (visible) setTimeout(() => { try { fit.current?.fit(); } catch { /* ignore */ } }, 30);
    }, [visible]);

    return <div className="term" ref={el} />;
  },
);

interface Props {
  tab: BottomTab;
  setTab(t: BottomTab): void;
  open: boolean;
  setOpen(o: boolean): void;
  height: number;
  logs: LogEntry[];
  net: NetEntry[];
  problems: Diagnostic[];
  showTerminal: boolean;
  onClearLogs(): void;
  onClearNet(): void;
  onEval(code: string): void;
  onOpenProblem(d: Diagnostic): void;
  terminalRef: React.Ref<TerminalHandle>;
  onTermInput(d: string): void;
  onTermResize(cols: number, rows: number): void;
}

const LEVELS = ['all', 'error', 'warn', 'log'] as const;

export default function BottomPanel(p: Props) {
  const [filter, setFilter] = useState<(typeof LEVELS)[number]>('all');
  const [cmd, setCmd] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hIndex, setHIndex] = useState(-1);
  const logEnd = useRef<HTMLDivElement>(null);
  const errors = p.logs.filter((l) => l.level === 'error').reduce((n, l) => n + l.count, 0);
  const warns = p.logs.filter((l) => l.level === 'warn').reduce((n, l) => n + l.count, 0);
  const probErr = p.problems.filter((d) => d.severity === 'error').length;
  const failed = p.net.filter((n) => n.status >= 400).length;

  useEffect(() => {
    if (p.tab === 'console') logEnd.current?.scrollIntoView({ block: 'end' });
  }, [p.logs, p.tab, p.open]);

  const shown = p.logs.filter((l) => filter === 'all' || l.level === filter || (filter === 'log' && ['log', 'info', 'debug', 'result', 'input'].includes(l.level)));

  const tabBtn = (t: BottomTab, label: string, badge?: React.ReactNode) => (
    <button className={'bt' + (p.tab === t && p.open ? ' on' : '')} onClick={() => { p.setTab(t); p.setOpen(true); }}>{label}{badge}</button>
  );

  return (
    <div className="bottom" style={{ height: p.open ? p.height : 35 }}>
      <div className="bottom-tabs">
        {tabBtn('console', 'Console', <>{errors > 0 && <span className="count err">{errors}</span>}{warns > 0 && <span className="count warn">{warns}</span>}</>)}
        {tabBtn('network', 'Network', failed > 0 ? <span className="count err">{failed}</span> : p.net.length > 0 ? <span className="count">{p.net.length}</span> : null)}
        {p.showTerminal && tabBtn('terminal', 'Terminal')}
        {tabBtn('problems', 'Problems', p.problems.length > 0 ? <span className={'count' + (probErr ? ' err' : '')}>{p.problems.length}</span> : null)}
        <div className="filter-row">
          {p.open && p.tab === 'console' && (
            <>
              <div className="seg hide-sm">
                {LEVELS.map((l) => <button key={l} className={filter === l ? 'on' : ''} onClick={() => setFilter(l)}>{l}</button>)}
              </div>
              <button className="icon-btn" title="Clear console" onClick={p.onClearLogs}><Ban size={14} /></button>
            </>
          )}
          {p.open && p.tab === 'network' && <button className="icon-btn" title="Clear" onClick={p.onClearNet}><Ban size={14} /></button>}
          <button className="icon-btn" title={p.open ? 'Collapse' : 'Expand'} onClick={() => p.setOpen(!p.open)}>{p.open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
        </div>
      </div>
      {(
        <div style={{ flex: 1, minHeight: 0, display: p.open ? 'flex' : 'none', flexDirection: 'column' }}>
          {p.tab === 'console' && (
            <>
              <div className="bottom-body">
                {!shown.length && <div className="empty">Console output from the running app will appear here. Type JavaScript below to run it inside the preview.</div>}
                {shown.map((l) => (
                  <div key={l.id} className={'log ' + l.level}>
                    <span className="t">{l.level === 'input' ? '›' : l.level === 'result' ? '‹' : new Date(l.time).toLocaleTimeString([], { hour12: false })}</span>
                    <span className="m">{l.text}</span>
                    {l.count > 1 && <span className="n">{l.count}</span>}
                  </div>
                ))}
                <div ref={logEnd} />
              </div>
              <form className="repl" onSubmit={(e) => {
                e.preventDefault();
                if (!cmd.trim()) return;
                p.onEval(cmd);
                setHistory((h) => [cmd, ...h].slice(0, 50));
                setHIndex(-1);
                setCmd('');
              }}>
                <ChevronRight size={14} color="var(--accent-2)" />
                <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="Run JavaScript in the preview, e.g. document.title" spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp' && history.length) { e.preventDefault(); const i = Math.min(hIndex + 1, history.length - 1); setHIndex(i); setCmd(history[i]); }
                    if (e.key === 'ArrowDown') { e.preventDefault(); const i = hIndex - 1; setHIndex(Math.max(i, -1)); setCmd(i >= 0 ? history[i] : ''); }
                  }} />
              </form>
            </>
          )}
          {p.tab === 'network' && (
            <div className="bottom-body">
              {!p.net.length ? <div className="empty">Requests the app makes to its own files show up here, with status, type, size and timing.</div> : (
                <table className="net-table">
                  <thead><tr><th>Status</th><th>Path</th><th className="hide-sm">Type</th><th>Size</th><th>Time</th></tr></thead>
                  <tbody>
                    {p.net.map((n) => (
                      <tr key={n.id} className={n.status >= 400 ? 'bad' : ''}>
                        <td>{n.status}</td>
                        <td className="p" title={n.path}>{n.path}</td>
                        <td className="hide-sm">{n.kind || n.type.split(';')[0]}</td>
                        <td>{n.size ? (n.size > 1024 ? (n.size / 1024).toFixed(1) + ' KB' : n.size + ' B') : '—'}</td>
                        <td>{n.ms} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          {p.tab === 'problems' && (
            <div className="bottom-body" style={{ fontFamily: 'inherit', padding: 6 }}>
              {!p.problems.length && <div className="empty">No problems detected. 🎉</div>}
              {p.problems.map((d, i) => <DiagRow key={i} d={d} onClick={() => p.onOpenProblem(d)} />)}
            </div>
          )}
          {p.showTerminal && (
            <div style={{ flex: 1, minHeight: 0, display: p.tab === 'terminal' ? 'block' : 'none' }}>
              <Term ref={p.terminalRef} onInput={p.onTermInput} onResize={p.onTermResize} visible={p.tab === 'terminal'} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DiagRow({ d, onClick }: { d: Diagnostic; onClick?(): void }) {
  const Icon = d.severity === 'error' ? AlertCircle : d.severity === 'warning' ? AlertTriangle : Info;
  return (
    <div className={'diag' + (d.file && onClick ? ' clickable' : '')} onClick={d.file ? onClick : undefined}>
      <Icon size={15} className={'sev-' + d.severity} />
      <div style={{ minWidth: 0 }}>
        <div className="d-title">{d.title}</div>
        {d.detail && <div className="d-detail">{d.detail}</div>}
        {d.file && <div className="d-file">{d.file}{d.line ? ':' + d.line : ''}</div>}
      </div>
    </div>
  );
}
