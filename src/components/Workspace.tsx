import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Bot, Code2, Download, FolderTree, Gauge, Moon, Package, Play, RefreshCw, Server, Sun, Wand2, X, Zap, Eye, Copy, ExternalLink,
} from 'lucide-react';
import type { LoadedProject } from '../App';
import { Analysis, Diagnostic, Mode, analyze } from '../lib/analyze';
import { FileMap, basename, exportZip, ext, isImage, isText, mimeOf, toBytes, toText } from '../lib/files';
import { QuickEngine, readEnvFile } from '../lib/quick';
import { NodeEngine, buildStatic, nodeSupported, staticPath } from '../lib/engines';
import { publishSite, removeFile, writeFiles } from '../lib/preview';
import { saveProject } from '../lib/store';
import { buildFixPrompt } from '../lib/report';
import FileTree, { FileIcon } from './FileTree';
import CodeEditor from './CodeEditor';
import PreviewPane from './PreviewPane';
import BottomPanel, { BottomTab, LogEntry, NetEntry, TerminalHandle } from './BottomPanel';
import Insights from './Insights';
import AIPanel from './AIPanel';
import { AIStatus, ContextInput, FileEdit, aiStatus } from '../lib/ai';

interface Props {
  project: LoadedProject;
  onClose(): void;
  theme: 'dark' | 'light';
  onToggleTheme(): void;
}

type Status = { state: 'idle' | 'busy' | 'ok' | 'err'; text: string };
const MODE_LABEL: Record<Mode, string> = { static: 'Static', quick: 'Instant', node: 'Node' };
const RESTART_FILES = /^(index\.html|public\/index\.html|package\.json|tsconfig(\.\w+)?\.json|jsconfig\.json|vite\.config\.\w+|tailwind\.config\.\w+)$/;

function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

function useDrag(onMove: (dx: number, dy: number) => void) {
  const [drag, setDrag] = useState(false);
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    let x = e.clientX;
    let y = e.clientY;
    setDrag(true);
    document.body.style.userSelect = 'none';
    const frames = document.querySelectorAll('iframe');
    frames.forEach((f) => (f.style.pointerEvents = 'none'));
    const move = (ev: PointerEvent) => {
      onMove(ev.clientX - x, ev.clientY - y);
      x = ev.clientX;
      y = ev.clientY;
    };
    const up = () => {
      setDrag(false);
      document.body.style.userSelect = '';
      frames.forEach((f) => (f.style.pointerEvents = ''));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { drag, start };
}

function initialMode(a: Analysis): Mode {
  if (a.recommended === 'node' && !nodeSupported().ok && a.supported.includes('quick')) return 'quick';
  return a.recommended;
}

export default function Workspace({ project, onClose, theme, onToggleTheme }: Props) {
  const files = useRef<FileMap>(new Map(project.files)).current;
  const originals = useRef<FileMap>(new Map(project.files)).current;
  const [, setVersion] = useState(0);
  const [analysis, setAnalysis] = useState<Analysis>(() => analyze(files, project.name));
  const [run, setRun] = useState<{ mode: Mode; nonce: number; command?: string }>(() => ({ mode: initialMode(analysis), nonce: 0 }));
  const mode = run.mode;
  const [env, setEnv] = useState<Record<string, string>>(() => readEnvFile(files));
  const [staticEntry, setStaticEntry] = useState<string | null>(analysis.staticEntry);
  const [buildDiags, setBuildDiags] = useState<Diagnostic[]>([]);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [gotoLine, setGotoLine] = useState<{ line: number; nonce: number } | null>(null);
  const [modified, setModified] = useState<Set<string>>(new Set());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [net, setNet] = useState<NetEntry[]>([]);
  const [src, setSrc] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [path, setPath] = useState('/');
  const [status, setStatus] = useState<Status>({ state: 'idle', text: '' });
  const [nodeUrl, setNodeUrl] = useState<string | null>(null);
  const [nodeBlocked, setNodeBlocked] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<'files' | 'insights' | 'ai'>('insights');
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomTab, setBottomTab] = useState<BottomTab>('console');
  const [bottomH, setBottomH] = useState(210);
  const [sideW, setSideW] = useState(280);
  const [editorW, setEditorW] = useState(() => Math.round(window.innerWidth * 0.36));
  const [mobileView, setMobileView] = useState<'side' | 'code' | 'preview'>('preview');
  const [fixPrompt, setFixPrompt] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [errToast, setErrToast] = useState<string | null>(null);
  const small = useMedia('(max-width: 900px)');

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const quickRef = useRef<QuickEngine | null>(null);
  const nodeRef = useRef<NodeEngine | null>(null);
  const termRef = useRef<TerminalHandle>(null);
  const staticRoot = useRef('');
  const runId = useRef(0);
  const logId = useRef(0);
  const [ai, setAi] = useState<AIStatus | null>(null);
  const [autoFixNonce, setAutoFixNonce] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const aiSnapshot = useRef<FileMap | null>(null);
  const settleRef = useRef<(() => void) | null>(null);
  const outlineWaiters = useRef(new Map<string, (t: string) => void>());
  const logsRef = useRef<LogEntry[]>([]);
  const netRef = useRef<NetEntry[]>([]);
  const buildDiagsRef = useRef<Diagnostic[]>([]);
  const timers = useRef<Record<string, number>>({});
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2200);
  };

  const addLog = useCallback((level: LogEntry['level'], text: string) => {
    setLogs((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.level === level && last.text === text) {
        return [...prev.slice(0, -1), { ...last, count: last.count + 1, time: Date.now() }];
      }
      const next = [...prev, { id: ++logId.current, level, text, time: Date.now(), count: 1 }];
      return next.length > 1500 ? next.slice(-1200) : next;
    });
  }, []);

  // ---------------------------------------------------------------- messages from the preview
  useEffect(() => {
    const handle = (d: any, prefix: string) => {
      if (!d || !d.__ziprun) return;
      if (d.type === 'console') {
        const level = ['log', 'info', 'warn', 'error', 'debug', 'result'].includes(d.level) ? d.level : 'log';
        addLog(level, prefix + d.text);
        if (d.uncaught || level === 'error') setErrToast(String(d.text));
      } else if (d.type === 'location' && !prefix) {
        setPath(d.path || '/');
      } else if (d.type === 'ready' && !prefix) {
        setStatus((s) => (s.state === 'busy' ? s : { state: 'ok', text: d.loadMs ? `Loaded in ${d.loadMs} ms` : 'Running' }));
        const settle = settleRef.current;
        if (settle) setTimeout(settle, 1800); // give late runtime errors a moment to arrive
      } else if (d.type === 'outline' && !prefix) {
        const waiter = outlineWaiters.current.get(d.id);
        if (waiter) { outlineWaiters.current.delete(d.id); waiter(String(d.text || '')); }
      }
    };
    const onMsg = (e: MessageEvent) => {
      if (!e.data?.__ziprun) return;
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
      handle(e.data, '');
    };
    window.addEventListener('message', onMsg);
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('ziprun-preview');
      bc.onmessage = (e) => handle(e.data, '[new tab] ');
    } catch { /* unsupported */ }
    const onSw = (e: MessageEvent) => {
      if (e.data?.type !== 'zr-net') return;
      setNet((prev) => {
        const next = [...prev, { id: ++logId.current, ...e.data.entry }];
        return next.length > 800 ? next.slice(-600) : next;
      });
    };
    navigator.serviceWorker?.addEventListener('message', onSw);
    return () => {
      window.removeEventListener('message', onMsg);
      bc?.close();
      navigator.serviceWorker?.removeEventListener('message', onSw);
    };
  }, [addLog]);

  // ---------------------------------------------------------------- running
  useEffect(() => {
    const id = ++runId.current;
    const m = run.mode;
    const a = analysis;
    let cancelled = false;
    const alive = () => !cancelled && id === runId.current;

    (async () => {
      setLogs([]);
      setNet([]);
      setErrToast(null);
      setBuildDiags([]);
      setSrc(null);
      setNodeUrl(null);
      setNodeBlocked(null);
      setPath('/');
      const skipped = Object.entries(project.skipped).map(([d, n]) => `${d} (${n} files)`);
      if (skipped.length) addLog('system', `Skipped ${skipped.join(', ')}. Dependencies are installed or loaded automatically.`);
      setStatus({ state: 'busy', text: m === 'node' ? 'Booting Node.js…' : 'Building preview…' });
      try {
        if (m === 'static') {
          const { served, entry, root } = buildStatic(files, a, staticEntry || undefined);
          staticRoot.current = root;
          const entryHtml = files.get((root ? root + '/' : '') + entry);
          const spa = !!entryHtml && /id=["'](root|app|__next)["']/.test(toText(entryHtml)) && /<script[^>]+type=["']module["']/.test(toText(entryHtml));
          await publishSite({ id: project.id, entry, spa, tailwind: false }, served);
          if (!alive()) return;
          const start = entry === 'index.html' ? '/' : '/' + entry;
          setPath(start);
          setSrc(start);
          setFrameKey((k) => k + 1);
          setStatus({ state: 'ok', text: `Serving ${served.size} static files` + (root ? ` from ${root}/` : '') });
        } else if (m === 'quick') {
          const engine = new QuickEngine(files, a, env);
          quickRef.current = engine;
          const b = await engine.build();
          if (!alive()) return;
          setBuildDiags(b.diagnostics);
          await publishSite({ id: project.id, entry: b.entry, spa: true, tailwind: !!a.tailwind }, b.served);
          if (!alive()) return;
          setSrc('/');
          setFrameKey((k) => k + 1);
          setStatus({ state: b.diagnostics.some((d) => d.severity === 'error') ? 'err' : 'ok', text: `Instant build: ${b.served.size} files compiled in-browser` });
          addLog('system', 'Instant mode: packages load from esm.sh. For an exact match with your machine, switch to Node mode.');
        } else {
          const sup = nodeSupported();
          if (!sup.ok) {
            setNodeBlocked(sup.reason!);
            setStatus({ state: 'err', text: 'Node mode unavailable in this browser' });
            return;
          }
          setBottomTab('terminal');
          setBottomOpen(true);
          const bridge = await (await fetch('/__ziprun__/bridge.js')).text();
          const nodeFiles = new Map(files);
          const keys = Object.keys(env);
          if (keys.length) {
            const existing = files.get('.env') ? toText(files.get('.env')!).split('\n') : [];
            const kept = existing.filter((l) => !keys.some((k) => new RegExp(`^\\s*${k}\\s*=`).test(l)));
            nodeFiles.set('.env', toBytes([...kept, ...keys.map((k) => `${k}=${env[k]}`)].join('\n').trim() + '\n'));
          }
          const engine = new NodeEngine({
            onOutput: (d) => termRef.current?.write(d),
            onServer: (port, url) => {
              if (!alive()) return;
              setNodeUrl(url);
              setSrc(url);
              setFrameKey((k) => k + 1);
              setStatus({ state: 'ok', text: `Dev server running on port ${port}` });
              if (window.innerWidth > 900) setBottomTab('console');
            },
            onPort: (port, type) => alive() && addLog('system', `Port ${port} ${type === 'open' ? 'opened' : 'closed'}`),
            onStatus: (text) => alive() && setStatus({ state: 'busy', text }),
            onError: (msg) => alive() && addLog('error', 'WebContainer: ' + msg),
          });
          nodeRef.current?.dispose();
          nodeRef.current = engine;
          termRef.current?.clear();
          termRef.current?.write('\x1b[38;5;141m❯ ZipRun\x1b[0m starting an in-browser Node.js environment (WebContainers)…\r\n');
          const command = run.command ?? a.runCommand;
          await engine.start(nodeFiles, command, termRef.current?.size() ?? { cols: 100, rows: 18 }, bridge);
          if (!alive()) return;
          setStatus({ state: 'busy', text: `Running: ${command}` });
        }
      } catch (err: any) {
        if (!alive()) return;
        const msg = err?.message || String(err);
        settleRef.current?.();
        setStatus({ state: 'err', text: msg });
        addLog('error', 'ZipRun: ' + msg);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  useEffect(() => () => nodeRef.current?.dispose(), []);

  const restart = (m: Mode = mode, command?: string) => setRun((r) => ({ mode: m, nonce: r.nonce + 1, command }));

  // ---------------------------------------------------------------- persistence & re-analysis
  const persist = useCallback(() => {
    const a = analyze(files, project.name);
    setAnalysis(a);
    saveProject({ id: project.id, name: project.name, updatedAt: Date.now(), fileCount: files.size, size: a.totalSize, stack: a.stack }, files);
  }, [files, project.id, project.name]);

  useEffect(() => {
    persist();
  }, [persist]);

  const debounce = (key: string, ms: number, fn: () => void) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = window.setTimeout(fn, ms);
  };

  // ---------------------------------------------------------------- preview commands
  const sendCmd = (cmd: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ __ziprunCmd: true, ...cmd }, '*');
  };
  const reloadFrame = () => {
    const w = iframeRef.current?.contentWindow;
    try {
      if (w && modeRef.current !== 'node') w.location.reload();
      else sendCmd({ cmd: 'reload' });
    } catch {
      setFrameKey((k) => k + 1);
    }
  };

  const applyEdit = async (p: string) => {
    const m = modeRef.current;
    const data = files.get(p);
    try {
      if (m === 'node') {
        if (data) await nodeRef.current?.writeFile(p, data);
        else await nodeRef.current?.deleteFile(p);
        return;
      }
      if (m === 'static') {
        const rel = staticPath(staticRoot.current, p);
        if (rel === null) return;
        if (data) await writeFiles(project.id, [[rel, { data, type: mimeOf(p) }]]);
        else await removeFile(project.id, rel);
        if (data && ext(p) === 'css') sendCmd({ cmd: 'css', path: '/' + rel });
        else reloadFrame();
        return;
      }
      if (RESTART_FILES.test(p) || !quickRef.current) return restart('quick');
      if (data) {
        const out = quickRef.current.serveFile(p);
        await writeFiles(project.id, out);
      } else await removeFile(project.id, p);
      if (data && ext(p) === 'css') sendCmd({ cmd: 'css', path: '/' + p });
      else reloadFrame();
    } catch (e: any) {
      addLog('error', 'ZipRun: could not apply edit — ' + (e?.message || e));
    }
  };

  // ---------------------------------------------------------------- files & editor
  const openFile = (p: string, line?: number) => {
    if (!files.has(p)) return;
    setTabs((t) => (t.includes(p) ? t : [...t, p]));
    setActive(p);
    if (line) setGotoLine({ line, nonce: Date.now() });
    if (small) setMobileView('code');
  };
  const closeTab = (p: string) => {
    setTabs((t) => {
      const next = t.filter((x) => x !== p);
      if (active === p) setActive(next[next.length - 1] || null);
      return next;
    });
  };
  const onEdit = (p: string, value: string) => {
    files.set(p, toBytes(value));
    setModified((s) => {
      const orig = originals.get(p);
      const changed = !orig || toText(orig) !== value;
      if (changed === s.has(p)) return s;
      const n = new Set(s);
      if (changed) n.add(p);
      else n.delete(p);
      return n;
    });
    debounce('edit:' + p, 450, () => applyEdit(p));
    debounce('persist', 1500, persist);
  };
  const createFile = () => {
    const name = prompt('New file path (e.g. src/components/Button.jsx)')?.trim().replace(/^\/+/, '');
    if (!name) return;
    if (files.has(name)) return openFile(name);
    files.set(name, new Uint8Array());
    setModified((s) => new Set(s).add(name));
    setVersion((v) => v + 1);
    openFile(name);
    applyEdit(name);
    debounce('persist', 300, persist);
  };
  const deleteFile = (p: string) => {
    if (!confirm(`Delete ${p}?`)) return;
    files.delete(p);
    closeTab(p);
    setVersion((v) => v + 1);
    applyEdit(p);
    debounce('persist', 300, persist);
  };

  const download = async () => {
    let out = files;
    if (mode === 'node' && nodeRef.current) {
      const snap = await nodeRef.current.snapshot().catch(() => null);
      if (snap && snap.size) out = snap;
    }
    const blob = await exportZip(out, project.name || 'project');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (project.name || 'project') + (modified.size ? '-edited' : '') + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    flash('Zip downloaded');
  };

  const problems = useMemo(() => {
    const seen = new Set<string>();
    return [...buildDiags, ...analysis.diagnostics].filter((d) => {
      const k = d.title + d.file;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [analysis, buildDiags]);
  const problemMap = useMemo(() => {
    const m = new Map<string, Diagnostic['severity']>();
    for (const d of problems) if (d.file && (d.severity !== 'info') && !m.has(d.file)) m.set(d.file, d.severity);
    return m;
  }, [problems]);

  const openFix = () => setFixPrompt(buildFixPrompt(files, { ...analysis, diagnostics: problems }, logs, MODE_LABEL[mode]));

  // ---------------------------------------------------------------- AI Doctor
  logsRef.current = logs;
  netRef.current = net;
  buildDiagsRef.current = buildDiags;
  const refreshAi = useCallback(() => { aiStatus().then(setAi); }, []);
  useEffect(refreshAi, [refreshAi]);

  const getContext = (): ContextInput => {
    const a = analyze(files, project.name);
    const seen = new Set<string>();
    const probs = [...buildDiagsRef.current, ...a.diagnostics].filter((d) => {
      const k = d.title + d.file;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return {
      files, analysis: a, problems: probs, mode: MODE_LABEL[modeRef.current],
      logs: logsRef.current.filter((l) => l.level === 'error' || l.level === 'warn').map((l) => ({ level: l.level, text: l.text })),
      failedRequests: netRef.current.filter((n) => n.status >= 400).map((n) => `${n.status} ${n.path}`),
    };
  };
  const recomputeModified = () => {
    const n = new Set<string>();
    for (const [p, d] of files) {
      const o = originals.get(p);
      if (!o || o.length !== d.length || toText(o) !== toText(d)) n.add(p);
    }
    setModified(n);
  };
  const applyEdits = async (edits: FileEdit[]) => {
    for (const e of edits) {
      if (e.content === null) { files.delete(e.path); closeTab(e.path); }
      else files.set(e.path, toBytes(e.content));
    }
    recomputeModified();
    setVersion((v) => v + 1);
    persist();
    if (modeRef.current === 'node' && nodeRef.current?.wc) {
      for (const e of edits) await applyEdit(e.path);
      await new Promise((r) => setTimeout(r, 5000));
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => { settleRef.current = null; resolve(); };
      settleRef.current = done;
      restart();
      setTimeout(done, 15000);
    });
  };
  const takeSnapshot = () => {
    if (aiSnapshot.current) return;
    aiSnapshot.current = new Map(files);
    setCanUndo(true);
  };
  const undoAi = () => {
    const snap = aiSnapshot.current;
    if (!snap) return;
    files.clear();
    snap.forEach((v, k) => files.set(k, v));
    aiSnapshot.current = null;
    setCanUndo(false);
    setTabs((t) => t.filter((x) => files.has(x)));
    if (active && !files.has(active)) setActive(null);
    recomputeModified();
    setVersion((v) => v + 1);
    persist();
    restart();
    flash('AI changes undone');
  };
  const getOutline = () => new Promise<string>((resolve) => {
    const id = Math.random().toString(36).slice(2);
    outlineWaiters.current.set(id, resolve);
    sendCmd({ cmd: 'outline', id });
    setTimeout(() => {
      if (outlineWaiters.current.delete(id)) resolve('');
    }, 3000);
  });
  const openAi = () => {
    setLeftTab('ai');
    setSideW((w) => Math.max(w, 360));
    if (small) setMobileView('side');
  };
  const triggerFix = () => {
    if (!ai?.configured) return openFix();
    openAi();
    setAutoFixNonce((n) => n + 1);
  };

  const onRunScript = (name: string) => {
    if (mode === 'node' && nodeRef.current?.shell) {
      nodeRef.current.write('\x03');
      setTimeout(() => nodeRef.current?.write(`npm run ${name}\n`), 150);
      setBottomTab('terminal');
      setBottomOpen(true);
    } else restart('node', `npm install && npm run ${name}`);
  };

  const navigate = (p: string) => {
    if (mode === 'node' && nodeUrl) {
      setSrc(nodeUrl.replace(/\/$/, '') + p);
      setFrameKey((k) => k + 1);
    } else sendCmd({ cmd: 'navigate', path: p });
  };
  const openTab = () => {
    if (mode === 'node') nodeUrl && window.open(nodeUrl.replace(/\/$/, '') + path, '_blank');
    else window.open('/__preview__' + (path.startsWith('/') ? path : '/' + path), '_blank');
  };

  // ---------------------------------------------------------------- layout
  const sideDrag = useDrag((dx) => setSideW((w) => Math.min(520, Math.max(200, w + dx))));
  const editorDrag = useDrag((dx) => setEditorW((w) => Math.min(window.innerWidth - sideW - 260, Math.max(240, w + dx))));
  const bottomDrag = useDrag((_, dy) => setBottomH((h) => Math.min(window.innerHeight - 160, Math.max(90, h - dy))));

  const activeData = active ? files.get(active) : undefined;
  const host = mode === 'node' ? (nodeUrl ? new URL(nodeUrl).host.split('.')[0].slice(0, 10) + '…' : 'localhost') : 'localhost:5173';
  const modes: { m: Mode; icon: React.ReactNode; title: string; disabled: boolean }[] = [
    { m: 'static', icon: <Eye size={13} />, title: 'Serve files as-is (HTML/CSS/JS)', disabled: !analysis.htmlFiles.length },
    { m: 'quick', icon: <Zap size={13} />, title: 'Instant: compile React/TS in the browser, packages from CDN', disabled: ['framework', 'python', 'node-server'].includes(analysis.kind) },
    { m: 'node', icon: <Server size={13} />, title: 'Node: real npm install + dev server (like VS Code terminal)', disabled: false },
  ];

  const overlay = (() => {
    if (nodeBlocked) {
      return (
        <div className="overlay"><div className="box">
          <AlertCircle size={34} color="var(--warn)" />
          <h3>Node mode isn’t available here</h3>
          <p>{nodeBlocked}</p>
          {analysis.supported.includes('quick') && <button className="btn primary" onClick={() => restart('quick')}><Zap size={15} />Use Instant mode</button>}
        </div></div>
      );
    }
    if (analysis.kind === 'python' && !analysis.htmlFiles.length) {
      return (
        <div className="overlay"><div className="box">
          <Package size={34} color="var(--info)" />
          <h3>Python can’t run in the browser</h3>
          <p>This looks like a Python project. You can browse and edit the code, check the diagnostics, and download it again. To run it, use Python on your machine or a host like Render or Railway.</p>
          <button className="btn" onClick={() => setLeftTab('files')}><FolderTree size={15} />Browse files</button>
        </div></div>
      );
    }
    if (status.state === 'busy' && !src) {
      return (
        <div className="overlay"><div className="box">
          <div className="spinner" />
          <h3>{status.text}</h3>
          {mode === 'node' && <p>The first run downloads packages from npm, which usually takes 15–60 seconds. Watch the Terminal tab for progress.</p>}
        </div></div>
      );
    }
    if (status.state === 'err' && !src) {
      return (
        <div className="overlay"><div className="box">
          <AlertCircle size={34} color="var(--err)" />
          <h3>Couldn’t start the preview</h3>
          <p>{status.text}</p>
          <button className="btn" onClick={() => restart()}><RefreshCw size={15} />Try again</button>
        </div></div>
      );
    }
    return null;
  })();

  const errorToast = errToast && (
    <div className="err-toast" onClick={() => { setBottomTab('console'); setBottomOpen(true); }}>
      <AlertCircle size={16} color="var(--err)" style={{ flex: 'none', marginTop: 1 }} />
      <pre>{errToast}</pre>
      <button className="btn sm primary" onClick={(e) => { e.stopPropagation(); triggerFix(); }}><Wand2 size={12} />{ai?.configured ? 'Auto-fix' : 'Fix'}</button>
      <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={(e) => { e.stopPropagation(); setErrToast(null); }}><X size={13} /></button>
    </div>
  );

  const showEditor = !!active && (!small || mobileView === 'code');
  const vis = (v: typeof mobileView) => (small && mobileView !== v ? ' m-hidden' : '');

  return (
    <div className="ws">
      <div className="ws-top">
        <div className="brand" onClick={onClose} title="Back to start"><div className="brand-mark"><Play size={12} fill="#fff" /></div><span className="hide-sm">ZipRun</span></div>
        <div className="sep" />
        <span className="proj-name" title={analysis.summary}>{analysis.name}</span>
        <div className="chips hide-sm" style={{ marginTop: 0 }}>{analysis.stack.slice(0, 3).map((s) => <span key={s} className="chip">{s}</span>)}</div>
        <div className="sep hide-sm" />
        <div className="seg">
          {modes.map(({ m, icon, title, disabled }) => (
            <button key={m} className={mode === m ? 'on' : ''} title={title} disabled={disabled} onClick={() => restart(m)}>
              {icon}<span className="lbl">{MODE_LABEL[m]}</span>
            </button>
          ))}
        </div>
        <span className="status-pill hide-sm" title={status.text}>
          <span className={'dot ' + (status.state === 'ok' ? 'ok' : status.state === 'busy' ? 'busy' : status.state === 'err' ? 'err' : '')} />
          {status.text}
        </span>
        <div className="spacer" />
        <button className="btn sm" onClick={() => restart()} title="Restart preview"><RefreshCw size={13} /><span className="hide-sm">Restart</span></button>
        <button className="btn sm primary hide-sm" onClick={triggerFix} title={ai?.configured ? 'Let the NVIDIA Nemotron agent fix every problem' : 'Build a prompt for ChatGPT / Claude'}><Wand2 size={13} />{ai?.configured ? 'AI Auto-fix' : 'Fix with AI'}</button>
        <button className="icon-btn" onClick={download} title="Download project as zip"><Download size={16} /></button>
        <button className="icon-btn hide-sm" onClick={onToggleTheme} title="Toggle theme">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
        <button className="icon-btn" onClick={onClose} title="Close project"><X size={16} /></button>
      </div>

      <div className="ws-body">
        <aside className={'side' + vis('side')} style={{ width: small ? undefined : sideW }}>
          <div className="side-tabs">
            <button className={leftTab === 'files' ? 'on' : ''} onClick={() => setLeftTab('files')}><FolderTree size={14} />Files</button>
            <button className={leftTab === 'insights' ? 'on' : ''} onClick={() => setLeftTab('insights')}>
              <Gauge size={14} />Insights{problems.filter((d) => d.severity === 'error').length > 0 && <span className="count err">{problems.filter((d) => d.severity === 'error').length}</span>}
            </button>
            <button className={leftTab === 'ai' ? 'on' : ''} onClick={openAi}><Bot size={14} />AI</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: leftTab === 'ai' ? 'flex' : 'none', flexDirection: 'column' }}>
            <AIPanel status={ai} onStatusChange={refreshAi} getContext={getContext} getFile={(p) => (files.has(p) ? toText(files.get(p)!) : null)}
              applyEdits={applyEdits} getOutline={getOutline} takeSnapshot={takeSnapshot} canUndo={canUndo} onUndo={undoAi}
              autoFixNonce={autoFixNonce} onOpenFile={(p) => openFile(p)} onCopyPrompt={openFix} />
          </div>
          <div className="side-scroll" style={{ display: leftTab === 'ai' ? 'none' : undefined }}>
            {leftTab === 'files' ? (
              <FileTree paths={[...files.keys()]} selected={active} modified={modified} problems={problemMap} onOpen={(p) => openFile(p)} onCreate={createFile} onDelete={deleteFile} />
            ) : (
              <Insights key={JSON.stringify(env)} analysis={analysis} diagnostics={problems} modeLabel={MODE_LABEL[mode]} env={env}
                onEnv={(e) => { setEnv(e); restart(); }} onOpenProblem={(d) => d.file && openFile(d.file, d.line)}
                onRunScript={onRunScript} onFixPrompt={triggerFix} staticEntry={staticEntry}
                onStaticEntry={(p) => { setStaticEntry(p); setTimeout(() => restart('static'), 0); }} />
            )}
          </div>
        </aside>
        {!small && <div className={'splitter' + (sideDrag.drag ? ' drag' : '')} onPointerDown={sideDrag.start} />}

        <div className={'main' + (small && mobileView === 'side' ? ' m-hidden' : '')}>
          <div className="main-row">
            {showEditor && (
              <div className="editor-col" style={{ width: small ? undefined : editorW }}>
                <div className="tabs">
                  {tabs.map((t) => (
                    <div key={t} className={'tab' + (t === active ? ' on' : '')} onClick={() => setActive(t)} title={t}>
                      <FileIcon path={t} />{basename(t)}
                      {modified.has(t) && <span className="mod" />}
                      <span className="close" onClick={(e) => { e.stopPropagation(); closeTab(t); }}><X size={12} /></span>
                    </div>
                  ))}
                </div>
                <div className="editor-wrap">
                  {active && activeData && isText(active, activeData) ? (
                    <CodeEditor path={active} value={toText(activeData)} theme={theme} gotoLine={gotoLine} onChange={(v) => onEdit(active, v)} />
                  ) : active && activeData && isImage(active) ? (
                    <ImageView data={activeData} path={active} />
                  ) : (
                    <div className="empty-editor">Binary file ({activeData?.length.toLocaleString()} bytes). It can’t be edited here.</div>
                  )}
                </div>
              </div>
            )}
            {showEditor && !small && <div className={'splitter' + (editorDrag.drag ? ' drag' : '')} onPointerDown={editorDrag.start} />}
            <div className={'preview-wrap' + (small && mobileView !== 'preview' ? ' m-hidden' : '')}>
              <PreviewPane ref={iframeRef} src={src} frameKey={frameKey} host={host} path={path} overlay={overlay} toast={errorToast}
                onNavigate={navigate} onCommand={(c) => (c === 'reload' ? reloadFrame() : sendCmd({ cmd: c }))} onOpenTab={openTab} />
            </div>
          </div>
          {!small && bottomOpen && <div className={'hsplitter' + (bottomDrag.drag ? ' drag' : '')} onPointerDown={bottomDrag.start} />}
          <BottomPanel tab={bottomTab} setTab={setBottomTab} open={bottomOpen} setOpen={setBottomOpen} height={small ? 220 : bottomH}
            logs={logs} net={net} problems={problems} showTerminal={mode === 'node'}
            onClearLogs={() => setLogs([])} onClearNet={() => setNet([])}
            onEval={(code) => { addLog('input', code); sendCmd({ cmd: 'eval', code }); }}
            onOpenProblem={(d) => d.file && openFile(d.file, d.line)}
            terminalRef={termRef} onTermInput={(d) => nodeRef.current?.write(d)} onTermResize={(c, r) => nodeRef.current?.resize(c, r)} />
        </div>
      </div>

      <nav className="mobile-nav">
        <button className={mobileView === 'side' ? 'on' : ''} onClick={() => setMobileView('side')}><FolderTree size={18} />Files</button>
        <button className={mobileView === 'code' ? 'on' : ''} onClick={() => setMobileView('code')} disabled={!active}><Code2 size={18} />Code</button>
        <button className={mobileView === 'preview' ? 'on' : ''} onClick={() => setMobileView('preview')}><Eye size={18} />Preview</button>
      </nav>

      {fixPrompt !== null && (
        <div className="modal-back" onClick={() => setFixPrompt(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header><Wand2 size={16} color="var(--accent-2)" /><h3>Fix with AI</h3><button className="icon-btn" onClick={() => setFixPrompt(null)}><X size={16} /></button></header>
            <div className="body">
              <p className="hint">This prompt includes the detected problems, console errors, file tree and relevant files. Paste it into ChatGPT, Claude, Codex or Cursor, then upload the fixed project here again.</p>
              <textarea value={fixPrompt} onChange={(e) => setFixPrompt(e.target.value)} spellCheck={false} />
            </div>
            <footer>
              <button className="btn" onClick={() => window.open('https://chatgpt.com/?q=' + encodeURIComponent(fixPrompt.slice(0, 6000)), '_blank')}><ExternalLink size={14} />Open in ChatGPT</button>
              <button className="btn" onClick={() => window.open('https://claude.ai/new?q=' + encodeURIComponent(fixPrompt.slice(0, 6000)), '_blank')}><ExternalLink size={14} />Open in Claude</button>
              <button className="btn primary" onClick={async () => {
                try { await navigator.clipboard.writeText(fixPrompt); flash('Prompt copied to clipboard'); } catch { flash('Select the text and copy it manually'); }
              }}><Copy size={14} />Copy prompt</button>
            </footer>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function ImageView({ data, path }: { data: Uint8Array; path: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([data as BlobPart], { type: mimeOf(path) })), [data, path]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <div className="img-view"><img src={url} alt={path} /></div>;
}
