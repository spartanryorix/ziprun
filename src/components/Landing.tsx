import { useEffect, useRef, useState } from 'react';
import {
  Activity, Bot, Bug, Code2, FileArchive, FolderOpen, Moon, Play, Smartphone, Sparkles, Sun, Terminal, Trash2, Upload, Wand2, Zap,
} from 'lucide-react';
import type { LoadedProject } from '../App';
import { LoadResult, formatBytes, loadFileList, loadZip } from '../lib/files';
import { DEMOS } from '../lib/demos';
import { RecentMeta, deleteProject, listRecents, loadProject } from '../lib/store';

interface Props {
  onOpen(p: LoadedProject): void;
  theme: 'dark' | 'light';
  onToggleTheme(): void;
}

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

async function readEntries(entry: any, prefix: string, out: { path: string; file: File }[]) {
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    if (['node_modules', '.git'].includes(entry.name)) return;
    const reader = entry.createReader();
    for (;;) {
      const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await readEntries(child, prefix + entry.name + '/', out);
    }
  }
}

export default function Landing({ onOpen, theme, onToggleTheme }: Props) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [recents, setRecents] = useState<RecentMeta[]>([]);
  const zipInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listRecents().then(setRecents);
  }, []);

  async function finish(name: string, load: Promise<LoadResult>) {
    setError('');
    setBusy(`Unpacking ${name}…`);
    try {
      const { files, skipped } = await load;
      if (!files.size) throw new Error('That upload has no files in it (or only node_modules / .git).');
      onOpen({ id: newId(), name: name.replace(/\.zip$/i, ''), files, skipped });
    } catch (e: any) {
      setError(e?.message?.includes('End of data') || e?.message?.includes('zip') ? 'That file is not a valid zip archive.' : e?.message || String(e));
      setBusy('');
    }
  }

  function handleFiles(list: FileList | File[]) {
    const arr = [...list];
    if (!arr.length) return;
    if (arr.length === 1 && /\.zip$/i.test(arr[0].name)) return finish(arr[0].name, loadZip(arr[0]));
    const withPaths = arr.map((f) => ({ path: (f as any).webkitRelativePath || f.name, file: f }));
    const root = withPaths[0].path.split('/')[0];
    return finish(withPaths.length > 1 && withPaths[0].path.includes('/') ? root : arr[0].name, loadFileList(withPaths));
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const items = [...e.dataTransfer.items];
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const files = [...e.dataTransfer.files];
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) return handleFiles(files);
    if (entries.some((en: any) => en.isDirectory)) {
      setBusy('Reading folder…');
      const out: { path: string; file: File }[] = [];
      for (const en of entries) await readEntries(en, '', out);
      const name = entries.length === 1 ? (entries[0] as any).name : 'project';
      return finish(name, loadFileList(out));
    }
    handleFiles(files);
  }

  async function openRecent(r: RecentMeta) {
    setBusy(`Opening ${r.name}…`);
    const p = await loadProject(r.id);
    if (!p) {
      setBusy('');
      setError('That project is no longer stored in this browser.');
      await deleteProject(r.id);
      setRecents(await listRecents());
      return;
    }
    onOpen({ id: r.id, name: p.name, files: p.files, skipped: {} });
  }

  return (
    <div className="landing" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="landing-inner">
        <div className="topbar">
          <div className="brand"><div className="brand-mark"><Play size={16} fill="#fff" /></div>ZipRun</div>
          <button className="icon-btn" onClick={onToggleTheme} title="Toggle theme">{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button>
        </div>

        <div className="hero">
          <div className="nv-badge"><Bot size={13} />AI Doctor powered by <b>NVIDIA Nemotron</b></div>
          <h1>Drop a zip.<br /><em>Watch it run.</em></h1>
          <p>Exported a project from ChatGPT, Claude, Codex or Cursor? Upload it here and see it running in seconds. No VS Code, no terminal, no localhost.</p>
        </div>

        <div className={'drop' + (over ? ' over' : '')} onClick={() => !busy && zipInput.current?.click()} role="button" tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && zipInput.current?.click()}>
          {busy ? (
            <div className="loading"><div className="spinner" style={{ width: 22, height: 22, margin: 0 }} />{busy}</div>
          ) : (
            <>
              <div className="drop-icon"><Upload size={26} /></div>
              <h2>Drop your project zip here</h2>
              <p>or a folder, or loose HTML/CSS/JS files. It runs right here in your browser.</p>
              <div className="drop-actions" onClick={(e) => e.stopPropagation()}>
                <button className="btn primary" onClick={() => zipInput.current?.click()}><FileArchive size={16} />Choose zip</button>
                <button className="btn" onClick={() => dirInput.current?.click()}><FolderOpen size={16} />Choose folder</button>
              </div>
            </>
          )}
          {error && <div className="err-box">{error}</div>}
          <input ref={zipInput} type="file" accept=".zip,.html,.htm,.css,.js,.jsx,.ts,.tsx,application/zip" multiple hidden
            onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ''; }} />
          <input ref={dirInput} type="file" hidden {...({ webkitdirectory: '', directory: '' } as any)}
            onChange={(e) => { if (e.target.files) handleFiles(e.target.files); e.target.value = ''; }} />
        </div>

        {recents.length > 0 && (
          <>
            <div className="section-title">Recent projects</div>
            <div className="cards">
              {recents.map((r) => (
                <div key={r.id} className="card" onClick={() => openRecent(r)}>
                  <h3><FileArchive size={16} />{r.name}</h3>
                  <p>{r.fileCount} files · {formatBytes(r.size)} · {new Date(r.updatedAt).toLocaleDateString()}</p>
                  <div className="chips">{r.stack.slice(0, 4).map((s) => <span key={s} className="chip">{s}</span>)}</div>
                  <button className="icon-btn x" title="Remove" onClick={async (e) => {
                    e.stopPropagation();
                    await deleteProject(r.id);
                    setRecents(await listRecents());
                  }}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="section-title">No zip handy? Try a demo</div>
        <div className="cards">
          {DEMOS.map((d) => (
            <div key={d.id} className="card" onClick={() => onOpen({ id: newId(), name: d.name, files: d.files(), skipped: {} })}>
              <h3><Sparkles size={16} />{d.name}</h3>
              <p>{d.description}</p>
            </div>
          ))}
        </div>

        <div className="section-title">What you get</div>
        <div className="features">
          <Feature icon={<Zap size={18} />} title="Instant preview" text="Static sites and React/TypeScript apps run immediately. Packages load from a CDN, so there is no npm install." />
          <Feature icon={<Terminal size={18} />} title="Real Node.js terminal" text="Next.js, Vue, Svelte or Express? Node mode runs npm install && npm run dev inside your browser, like VS Code." />
          <Feature icon={<Bug size={18} />} title="Console & network" text="See console logs, errors and every request the app makes. You can also run JavaScript inside the preview." />
          <Feature icon={<Activity size={18} />} title="Health check" text="Finds missing files, broken imports, leaked API keys, missing env vars and mobile issues, and gives the project a score." />
          <Feature icon={<Code2 size={18} />} title="Edit live" text="Change any file in the built-in editor. The preview reloads as you type, and CSS changes apply without a reload." />
          <Feature icon={<Smartphone size={18} />} title="Device preview" text="Check the layout on phone, tablet, laptop and desktop sizes, in portrait or landscape." />
          <Feature icon={<Wand2 size={18} />} title="AI Auto-fix agent" text="NVIDIA Nemotron reads the errors, edits the code, re-runs the app and repeats until it works. Every change is shown as a diff you can undo." />
          <Feature icon={<Sparkles size={18} />} title="Chat to change it" text="Ask “add dark mode” or “make it mobile friendly”, or get an AI UI/UX review of the live page." />
          <Feature icon={<FileArchive size={18} />} title="Download edits" text="Export your changed project as a fresh zip whenever you like." />
        </div>

        <p className="footer-note">Projects are unpacked and run locally in this tab. Files are only sent out when you use the AI Doctor, which sends the relevant files to the NVIDIA Nemotron model.</p>
      </div>
    </div>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="feature">
      {icon}
      <h4>{title}</h4>
      <p>{text}</p>
    </div>
  );
}
