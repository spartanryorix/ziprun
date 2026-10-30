import { useState } from 'react';
import { Activity, Boxes, FileCode2, KeyRound, Layers, ListChecks, Play, Wand2 } from 'lucide-react';
import { healthScore, type Analysis, type Diagnostic } from '../lib/analyze';
import { formatBytes } from '../lib/files';
import { DiagRow } from './BottomPanel';

const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3b82f6', JavaScript: '#eab308', HTML: '#f97316', CSS: '#38bdf8', SCSS: '#ec4899', Vue: '#22c55e',
  Svelte: '#f43f5e', Python: '#60a5fa', Markdown: '#94a3b8', JSON: '#737373', Astro: '#a855f7', Less: '#6366f1',
};

interface Props {
  analysis: Analysis;
  diagnostics: Diagnostic[];
  modeLabel: string;
  env: Record<string, string>;
  onEnv(env: Record<string, string>): void;
  onOpenProblem(d: Diagnostic): void;
  onRunScript(name: string): void;
  onFixPrompt(): void;
  staticEntry: string | null;
  onStaticEntry(p: string): void;
}

export default function Insights({ analysis: a, diagnostics, modeLabel, env, onEnv, onOpenProblem, onRunScript, onFixPrompt, staticEntry, onStaticEntry }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>(env);
  const [showAll, setShowAll] = useState(false);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const score = healthScore(diagnostics);
  const color = score >= 85 ? 'var(--ok)' : score >= 60 ? 'var(--warn)' : 'var(--err)';
  const verdict = score >= 85 ? 'Looks healthy' : score >= 60 ? 'Needs a little attention' : 'Has problems to fix';
  const totalLangLines = a.languages.reduce((n, l) => n + l.lines, 0) || 1;
  const deps = Object.entries(a.deps);
  const devDeps = Object.entries(a.devDeps);
  const envNames = [...new Set([...a.envVars.map((v) => v.name), ...Object.keys(env)])];
  const shownDiags = showAll ? diagnostics : diagnostics.slice(0, 8);
  const dirty = JSON.stringify(draft) !== JSON.stringify(env);

  return (
    <div className="ins">
      <div className="ins-card">
        <div className="score">
          <svg className="score-ring" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--line-2)" strokeWidth="3" />
            <circle cx="18" cy="18" r="15.5" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round"
              strokeDasharray={`${(score / 100) * 97.4} 97.4`} transform="rotate(-90 18 18)" />
            <text x="18" y="22" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--text)">{score}</text>
          </svg>
          <div>
            <b>{verdict}</b>
            <p>{errors} error{errors === 1 ? '' : 's'} · {warnings} warning{warnings === 1 ? '' : 's'}</p>
          </div>
        </div>
        <button className="btn sm primary" style={{ marginTop: 10, width: '100%', justifyContent: 'center' }} onClick={onFixPrompt}>
          <Wand2 size={13} />{errors + warnings ? 'Fix with AI' : 'Improve with AI'}
        </button>
      </div>

      <div className="ins-card">
        <h4><Layers size={13} />Overview</h4>
        <div className="kv">
          <span>Type</span><span>{a.summary.split(' · ')[0]}</span>
          <span>Running as</span><span>{modeLabel}</span>
          <span>Files</span><span>{a.fileCount.toLocaleString()}</span>
          <span>Lines of code</span><span>{a.totalLines.toLocaleString()}</span>
          <span>Size</span><span>{formatBytes(a.totalSize)}</span>
          <span>Local command</span><span title={a.runCommand}><code style={{ fontSize: 11 }}>{a.runCommand}</code></span>
        </div>
        {a.stack.length > 0 && <div className="chips" style={{ marginTop: 10 }}>{a.stack.map((s) => <span key={s} className="chip accent">{s}</span>)}</div>}
      </div>

      {a.htmlFiles.length > 1 && (
        <div className="ins-card">
          <h4><FileCode2 size={13} />HTML entry (static mode)</h4>
          <select className="field" value={staticEntry || ''} onChange={(e) => onStaticEntry(e.target.value)}>
            {a.htmlFiles.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>
      )}

      {a.languages.length > 0 && (
        <div className="ins-card">
          <h4><FileCode2 size={13} />Languages</h4>
          <div className="lang-bar">
            {a.languages.map((l) => <div key={l.name} style={{ width: `${(l.lines / totalLangLines) * 100}%`, background: LANG_COLORS[l.name] || '#8b8b8b' }} title={l.name} />)}
          </div>
          <div className="lang-list">
            {a.languages.slice(0, 6).map((l) => (
              <div key={l.name}><i style={{ background: LANG_COLORS[l.name] || '#8b8b8b' }} /><span>{l.name}</span><span>{((l.lines / totalLangLines) * 100).toFixed(0)}% · {l.files} file{l.files > 1 ? 's' : ''}</span></div>
            ))}
          </div>
        </div>
      )}

      <div className="ins-card">
        <h4><ListChecks size={13} />Diagnostics</h4>
        {!diagnostics.length && <div className="muted">No issues found. Nice work!</div>}
        {shownDiags.map((d, i) => <DiagRow key={i} d={d} onClick={() => onOpenProblem(d)} />)}
        {diagnostics.length > 8 && <button className="btn sm ghost" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show less' : `Show all ${diagnostics.length}`}</button>}
      </div>

      {Object.keys(a.scripts).length > 0 && (
        <div className="ins-card">
          <h4><Play size={13} />npm scripts</h4>
          {Object.entries(a.scripts).map(([name, cmd]) => (
            <div key={name} className="script-row">
              <b>{name}</b>
              <code title={cmd}>{cmd}</code>
              <button className="btn sm" onClick={() => onRunScript(name)} title={`Run npm run ${name} in Node mode`}><Play size={11} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="ins-card">
        <h4><KeyRound size={13} />Environment</h4>
        {!envNames.length && <p className="hint">This project does not read any environment variables.</p>}
        {envNames.length > 0 && <p className="hint">Values go into <code>import.meta.env</code> / <code>process.env</code> and into the <code>.env</code> file in Node mode. They stay in this browser.</p>}
        {envNames.map((n) => {
          const info = a.envVars.find((v) => v.name === n);
          return (
            <div key={n} className="env-row">
              <label>{n}{info && !info.defined && !draft[n] && <span className="chip" style={{ color: 'var(--warn)' }}>missing</span>}</label>
              <input value={draft[n] ?? ''} placeholder="value" onChange={(e) => setDraft({ ...draft, [n]: e.target.value })} type={/KEY|SECRET|TOKEN|PASS/.test(n) ? 'password' : 'text'} />
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn sm" onClick={() => {
            const name = prompt('Variable name (e.g. VITE_API_URL)')?.trim();
            if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) setDraft({ ...draft, [name]: '' });
          }}>+ Add variable</button>
          {dirty && <button className="btn sm primary" onClick={() => onEnv(draft)}>Apply & restart</button>}
        </div>
      </div>

      {(deps.length > 0 || devDeps.length > 0) && (
        <div className="ins-card">
          <h4><Boxes size={13} />Dependencies ({deps.length} + {devDeps.length} dev)</h4>
          <div className="dep-list">
            {deps.map(([n, v]) => <div key={n}><span>{n}</span><span>{v}</span></div>)}
            {devDeps.map(([n, v]) => <div key={n} style={{ opacity: 0.6 }}><span>{n}</span><span>{v}</span></div>)}
          </div>
        </div>
      )}

      <div className="ins-card">
        <h4><Activity size={13} />How the modes work</h4>
        <p className="hint"><b>Static</b> serves your files as-is, like opening index.html with a local server.</p>
        <p className="hint"><b>Instant</b> compiles React/TS in your browser and loads npm packages from a CDN. It is fast, but an approximation.</p>
        <p className="hint" style={{ margin: 0 }}><b>Node</b> runs real <code>npm install</code> and <code>npm run dev</code> in an in-browser Node.js (WebContainers), the same as on your machine. Works in Chrome, Edge and Firefox.</p>
      </div>
    </div>
  );
}
