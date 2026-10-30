import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, File, FileCode2, FileImage, FileJson, FilePlus, FileText, Folder, FolderOpen, Search, Trash2 } from 'lucide-react';
import { ext } from '../lib/files';
import type { Severity } from '../lib/analyze';

interface Node {
  name: string;
  path: string;
  children?: Node[];
}

function buildTree(paths: string[]): Node[] {
  const root: Node = { name: '', path: '', children: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const isFile = i === parts.length - 1;
      let child = node.children!.find((c) => c.name === part && !!c.children === !isFile);
      if (!child) {
        child = { name: part, path, children: isFile ? undefined : [] };
        node.children!.push(child);
      }
      node = child;
    });
  }
  const sort = (n: Node[]) => {
    n.sort((a, b) => (!!b.children === !!a.children ? a.name.localeCompare(b.name) : a.children ? -1 : 1));
    n.forEach((c) => c.children && sort(c.children));
  };
  sort(root.children!);
  return root.children!;
}

const COLORS: Record<string, string> = {
  ts: '#3b82f6', tsx: '#3b82f6', js: '#eab308', jsx: '#eab308', mjs: '#eab308', html: '#f97316', css: '#38bdf8',
  scss: '#ec4899', json: '#a3a3a3', md: '#94a3b8', vue: '#22c55e', svelte: '#f43f5e', py: '#60a5fa',
};

export function FileIcon({ path }: { path: string }) {
  const e = ext(path);
  const color = COLORS[e] || 'var(--text-3)';
  const props = { size: 15, color, className: 'fi' };
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif'].includes(e)) return <FileImage {...props} color="#a78bfa" />;
  if (e === 'json') return <FileJson {...props} />;
  if (['md', 'txt'].includes(e)) return <FileText {...props} />;
  if (COLORS[e]) return <FileCode2 {...props} />;
  return <File {...props} />;
}

interface Props {
  paths: string[];
  selected: string | null;
  modified: Set<string>;
  problems: Map<string, Severity>;
  onOpen(path: string): void;
  onCreate(): void;
  onDelete(path: string): void;
}

export default function FileTree({ paths, selected, modified, problems, onOpen, onCreate, onDelete }: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    // Collapse big folders by default so the tree is scannable.
    const counts = new Map<string, number>();
    for (const p of paths) {
      const top = p.split('/')[0];
      if (p.includes('/')) counts.set(top, (counts.get(top) || 0) + 1);
    }
    return new Set([...counts].filter(([, n]) => n > 40).map(([d]) => d));
  });
  const filtered = useMemo(() => (query ? paths.filter((p) => p.toLowerCase().includes(query.toLowerCase())) : paths), [paths, query]);
  const tree = useMemo(() => buildTree(filtered), [filtered]);

  const toggle = (p: string) => setCollapsed((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });

  const render = (nodes: Node[], depth: number): React.ReactNode =>
    nodes.map((n) => {
      const pad = { paddingLeft: 10 + depth * 14 };
      if (n.children) {
        const open = query ? true : !collapsed.has(n.path);
        return (
          <div key={'d:' + n.path}>
            <div className="tree-row" style={pad} onClick={() => toggle(n.path)}>
              {open ? <ChevronDown size={14} className="fi" /> : <ChevronRight size={14} className="fi" />}
              {open ? <FolderOpen size={15} className="fi" color="#8b9bb4" /> : <Folder size={15} className="fi" color="#8b9bb4" />}
              <span className="name">{n.name}</span>
            </div>
            {open && render(n.children, depth + 1)}
          </div>
        );
      }
      const sev = problems.get(n.path);
      return (
        <div key={n.path} className={'tree-row' + (selected === n.path ? ' sel' : '')} style={{ paddingLeft: 24 + depth * 14 }} onClick={() => onOpen(n.path)} title={n.path}>
          <FileIcon path={n.path} />
          <span className="name">{n.name}</span>
          {modified.has(n.path) && <span className="badge" style={{ color: 'var(--accent-2)' }}>M</span>}
          {sev && <span className={'badge sev-' + sev}>●</span>}
          <button className="row-act" title="Delete file" onClick={(e) => { e.stopPropagation(); onDelete(n.path); }}><Trash2 size={12} /></button>
        </div>
      );
    });

  return (
    <div>
      <div className="tree-search">
        <Search size={14} color="var(--text-3)" />
        <input placeholder="Search files" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="tree-head">
        <span style={{ flex: 1 }}>{paths.length} files</span>
        <button className="icon-btn" style={{ width: 24, height: 24 }} title="New file" onClick={onCreate}><FilePlus size={14} /></button>
      </div>
      {render(tree, 0)}
      {!filtered.length && <div className="empty">No files match “{query}”.</div>}
    </div>
  );
}
