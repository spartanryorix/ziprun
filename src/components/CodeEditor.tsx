import { useEffect, useMemo, useRef } from 'react';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { ext } from '../lib/files';

function langFor(path: string) {
  switch (ext(path)) {
    case 'js': case 'mjs': case 'cjs': return [javascript({ jsx: true })];
    case 'jsx': return [javascript({ jsx: true })];
    case 'ts': case 'mts': case 'cts': return [javascript({ typescript: true })];
    case 'tsx': return [javascript({ typescript: true, jsx: true })];
    case 'html': case 'htm': case 'vue': case 'svelte': case 'astro': case 'svg': return [html()];
    case 'css': case 'scss': case 'less': return [css()];
    case 'json': case 'jsonc': case 'webmanifest': return [json()];
    case 'md': case 'mdx': return [markdown()];
    case 'py': return [python()];
    default: return [];
  }
}

interface Props {
  path: string;
  value: string;
  theme: 'dark' | 'light';
  gotoLine?: { line: number; nonce: number } | null;
  onChange(value: string): void;
}

export default function CodeEditor({ path, value, theme, gotoLine, onChange }: Props) {
  const view = useRef<EditorView | null>(null);
  const extensions = useMemo(() => [...langFor(path), EditorView.lineWrapping], [path]);

  useEffect(() => {
    const v = view.current;
    if (!v || !gotoLine) return;
    const n = Math.min(Math.max(1, gotoLine.line), v.state.doc.lines);
    const line = v.state.doc.line(n);
    v.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    v.focus();
  }, [gotoLine]);

  return (
    <CodeMirror
      key={path}
      value={value}
      height="100%"
      style={{ height: '100%' }}
      theme={theme === 'dark' ? vscodeDark : vscodeLight}
      extensions={extensions}
      onChange={onChange}
      onCreateEditor={(v) => {
        view.current = v;
        if (gotoLine) setTimeout(() => {
          const n = Math.min(Math.max(1, gotoLine.line), v.state.doc.lines);
          const line = v.state.doc.line(n);
          v.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
        }, 0);
      }}
      basicSetup={{ foldGutter: true, highlightActiveLine: true, tabSize: 2 }}
    />
  );
}
