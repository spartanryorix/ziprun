/*
 * Instant engine: runs React / TypeScript / ES-module projects with no npm install.
 * Source files are transpiled in the browser (sucrase), local imports are resolved like
 * Vite would resolve them, and npm packages are loaded from the esm.sh CDN.
 */
import { transform } from 'sucrase';
import { parse as lexParse } from 'es-module-lexer/minimal';
import { FileMap, basename, ext, mimeOf, toText } from './files';
import { CODE_EXTS, NODE_BUILTINS, createResolver, ensureLexer, packageName, splitQuery } from './resolve';
import type { Analysis, Diagnostic } from './analyze';

export interface ServedFile {
  data: Uint8Array | string;
  type: string;
}
export type Served = Map<string, ServedFile>;

export interface QuickBuild {
  served: Served;
  diagnostics: Diagnostic[];
  entry: string;
}

const DEFAULTS: Record<string, string> = { react: '18', 'react-dom': '18' };
const ENTRY_CANDIDATES = ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx',
  'src/index.ts', 'src/index.js', 'main.tsx', 'main.jsx', 'index.tsx', 'index.jsx', 'src/client.tsx'];
const APP_CANDIDATES = ['src/App.tsx', 'src/App.jsx', 'src/app.tsx', 'src/app.jsx', 'App.tsx', 'App.jsx', 'app.tsx', 'app.jsx', 'src/App.js', 'App.js'];
export const VIRTUAL_ENTRY = '__zr_entry__/main.jsx';


/** "^18.2.0" → "18", "~4.17.1" → "4.17", "^0.3.2" → "0.3", "1.2.3" → "1.2.3", "latest" → "" */
export function esmVersion(range: string | undefined): string {
  if (!range) return '';
  const r = range.trim();
  if (/^(latest|\*|x|next)$/i.test(r) || /[:/]/.test(r)) return '';
  const m = r.match(/(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(-[\w.]+)?/);
  if (!m) return '';
  const [, major, minor, patch, pre] = m;
  if (r.startsWith('^')) return major === '0' && minor ? `0.${minor}` : major;
  if (r.startsWith('~')) return minor && /\d/.test(minor) ? `${major}.${minor}` : major;
  if (/^[<>]/.test(r)) return '';
  if (minor && patch && /\d/.test(minor) && /\d/.test(patch)) return `${major}.${minor}.${patch}${pre || ''}`;
  return minor && /\d/.test(minor) ? `${major}.${minor}` : major;
}

export class QuickEngine {
  private resolver;
  private versions: Record<string, string> = {};
  private depsParam = '';
  private diagnostics: Diagnostic[] = [];
  private entry = 'index.html';
  private autoMount: string | null = null;

  constructor(private files: FileMap, private analysis: Analysis, private env: Record<string, string>) {
    this.resolver = createResolver(files);
    const all = { ...analysis.devDeps, ...analysis.deps };
    for (const [n, v] of Object.entries(all)) this.versions[n] = esmVersion(v);
    for (const [n, v] of Object.entries(DEFAULTS)) if (!(n in all)) this.versions[n] = v;
    // Pin shared singletons so every CDN package uses the same React instance.
    const singletons = ['react', 'react-dom', 'preact', 'react-router', 'react-router-dom', '@emotion/react', 'styled-components'];
    this.depsParam = singletons
      .filter((n) => n in all || n in DEFAULTS)
      .filter((n) => !(n in DEFAULTS) || !all.preact || n === 'preact')
      .map((n) => (this.versions[n] ? `${n}@${this.versions[n]}` : n))
      .join(',');
  }

  async build(): Promise<QuickBuild> {
    await ensureLexer();
    this.diagnostics = [];
    const served: Served = new Map();
    const htmlEntry = this.findHtml();

    // public/ is served at the root, like Vite and Create React App.
    for (const [p, d] of this.files) {
      if (p.startsWith('public/')) served.set(p.slice(7), { data: d, type: mimeOf(p) });
    }
    for (const [p] of this.files) {
      for (const [url, file] of this.serveFile(p)) served.set(url, file);
    }
    if (this.autoMount) {
      const code = this.compile(VIRTUAL_ENTRY, this.autoMountSource(this.autoMount));
      served.set(VIRTUAL_ENTRY, { data: code, type: 'text/javascript; charset=utf-8' });
    }
    served.set(this.entry, { data: this.html(htmlEntry), type: 'text/html; charset=utf-8' });
    return { served, diagnostics: this.diagnostics, entry: this.entry };
  }

  /** Output for a single source file — used for incremental updates while editing. */
  serveFile(path: string): [string, ServedFile][] {
    const data = this.files.get(path);
    if (!data) return [];
    if (path.startsWith('public/')) return [[path.slice(7), { data, type: mimeOf(path) }]];
    if (path === this.htmlSource()) return [[this.entry, { data: this.html(path), type: 'text/html; charset=utf-8' }]];
    const e = '.' + ext(path);
    if (CODE_EXTS.includes(e) && !/\.d\.ts$/.test(path) && !isConfigFile(path)) {
      return [[path, { data: this.compile(path, toText(data)), type: 'text/javascript; charset=utf-8' }]];
    }
    return [[path, { data, type: mimeOf(path) }]];
  }

  private htmlSource(): string | null {
    if (this.files.has('index.html')) return 'index.html';
    if (this.files.has('public/index.html')) return 'public/index.html';
    return null;
  }

  private findHtml(): string | null {
    const src = this.htmlSource();
    const hasModuleEntry = src === 'index.html' && /<script[^>]+type=["']module["'][^>]*src=/i.test(toText(this.files.get(src)!));
    const has = (p: string) => this.files.has(p);
    this.autoMount = hasModuleEntry || ENTRY_CANDIDATES.some(has) ? null : APP_CANDIDATES.find(has) || this.guessComponent();
    return src;
  }

  /** Single-file exports from ChatGPT/Claude often contain just one component file. */
  private guessComponent(): string | null {
    const comps = [...this.files.keys()].filter((p) => /\.(jsx|tsx)$/.test(p) && /export\s+default/.test(toText(this.files.get(p)!)));
    return comps.length ? comps.sort((a, b) => a.split('/').length - b.split('/').length)[0] : null;
  }

  private autoMountSource(app: string): string {
    const preact = 'preact' in this.analysis.deps && !('react' in this.analysis.deps);
    if (preact) return `import { render, h } from 'preact';\nimport App from '/${app}';\nrender(h(App), document.getElementById('root'));`;
    return `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from '/${app}';\n` +
      `const el = document.getElementById('root') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'root' }));\n` +
      `createRoot(el).render(React.createElement(React.StrictMode, null, React.createElement(App)));`;
  }

  private entryScript(): string | null {
    if (this.autoMount) return '/' + VIRTUAL_ENTRY;
    const e = ENTRY_CANDIDATES.find((p) => this.files.has(p));
    return e ? '/' + e : null;
  }

  private html(src: string | null): string {
    let html = src ? toText(this.files.get(src)!) : '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="UTF-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n<title>Preview</title>\n</head>\n<body>\n<div id="root"></div>\n</body>\n</html>';
    html = html.replace(/%PUBLIC_URL%/g, '').replace(/%BASE_URL%/g, '/');
    html = html.replace(/%(VITE_[A-Z0-9_]+)%/g, (_, k) => this.env[k] ?? '');
    const needsScript = !/<script[^>]+type=["']module["'][^>]*src=/i.test(html) || src === 'public/index.html';
    const entry = this.entryScript();
    if (needsScript && entry) {
      const tag = `<script type="module" src="${entry}"></script>`;
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '\n</body>') : html + tag;
      if (!/id=["'](root|app)["']/.test(html)) html = html.replace(/<body[^>]*>/i, (m) => m + '<div id="root"></div>');
    }
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + this.prelude()) : this.prelude() + html;
  }

  private prelude(): string {
    const viteEnv: Record<string, unknown> = { MODE: 'development', DEV: true, PROD: false, SSR: false, BASE_URL: '/' };
    const procEnv: Record<string, unknown> = { NODE_ENV: 'development', PUBLIC_URL: '' };
    for (const [k, v] of Object.entries(this.env)) {
      if (k.startsWith('VITE_')) viteEnv[k] = v;
      procEnv[k] = v;
    }
    let out = `<script>window.process=window.process||{env:${JSON.stringify(procEnv)},browser:true,version:'',versions:{},nextTick:function(f){setTimeout(f)},cwd:function(){return '/'}};window.global=window.global||window;window.__ZR_ENV__=${JSON.stringify(viteEnv)};</script>`;
    if (this.analysis.tailwind === 4) out += '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>';
    else if (this.analysis.tailwind === 3) out += '<script src="https://cdn.tailwindcss.com"></script>' + this.tailwindConfig();
    return out;
  }

  private tailwindConfig(): string {
    const name = [...this.files.keys()].find((p) => /^tailwind\.config\.(js|cjs|mjs|ts)$/.test(p));
    if (!name) return '';
    try {
      let code = transform(toText(this.files.get(name)!), { transforms: name.endsWith('.ts') ? ['typescript', 'imports'] : ['imports'] }).code;
      code = code.replace(/import\s*\(/g, '(async()=>({}))(');
      return `<script>try{(function(){var module={exports:{}},exports=module.exports,require=function(){var f=function(){return {}};f.default=f;return f};${code};var c=module.exports&&module.exports.default||module.exports;if(c&&typeof c==='object'){delete c.content;c.plugins=[];tailwind.config=c}})()}catch(e){console.warn('ZipRun: could not apply tailwind.config',e)}</script>`;
    } catch {
      return '';
    }
  }

  compile(path: string, source: string): string {
    const e = ext(path);
    const transforms: ('typescript' | 'jsx' | 'flow')[] = e === 'ts' || e === 'mts' ? ['typescript'] : e === 'tsx' ? ['typescript', 'jsx'] : ['jsx'];
    let code: string;
    try {
      const jsxImportSource = this.analysis.deps.preact && !this.analysis.deps.react ? 'preact' : undefined;
      code = transform(source, {
        transforms, filePath: path, jsxRuntime: 'automatic', production: true, disableESTransforms: true,
        preserveDynamicImport: true, jsxImportSource,
      }).code;
    } catch (err: any) {
      const msg = String(err?.message || err);
      const line = Number(msg.match(/\((\d+):\d+\)/)?.[1]) || undefined;
      this.diagnostics.push({ severity: 'error', title: `Syntax error in ${basename(path)}`, detail: msg, file: path, line });
      return `throw new SyntaxError(${JSON.stringify(`${path}: ${msg}`)});`;
    }
    code = code.replace(/\bimport\.meta\.env\b/g, 'window.__ZR_ENV__');
    return this.rewriteImports(path, code);
  }

  private rewriteImports(from: string, code: string): string {
    let imports: readonly any[];
    try {
      [imports] = lexParse(code);
    } catch {
      return code;
    }
    let out = '';
    let last = 0;
    for (const im of imports) {
      if (im.n === undefined || im.d === -2) continue;
      const mapped = this.mapSpecifier(from, im.n);
      if (mapped === null || mapped === im.n) continue;
      const original = code.slice(im.s, im.e);
      const quoted = /^['"`]/.test(original);
      out += code.slice(last, im.s) + (quoted ? JSON.stringify(mapped) : mapped);
      last = im.e;
    }
    return out + code.slice(last);
  }

  private mapSpecifier(from: string, spec: string): string | null {
    if (/^(https?:|data:|blob:)/.test(spec)) return spec;
    const [bare, query] = splitQuery(spec);
    if (this.resolver.isLocal(bare)) {
      const target = this.resolver.resolve(from, bare);
      if (!target) {
        this.diagnostics.push({ severity: 'error', title: `Cannot resolve "${spec}"`, detail: `Imported from ${from}`, file: from });
        return spec;
      }
      const url = '/' + (target.startsWith('public/') ? target.slice(7) : target);
      const e = ext(target);
      if (query.includes('raw')) return url + '?raw';
      if (query.includes('url')) return url + '?asset';
      if (CODE_EXTS.includes('.' + e)) return url;
      if (e === 'css' || e === 'scss' || e === 'sass' || e === 'less') return url + '?module';
      if (e === 'json') return url + '?json';
      return url + '?asset';
    }
    return this.cdnUrl(bare, query);
  }

  private cdnUrl(spec: string, query: string): string {
    const name = packageName(spec);
    const builtin = NODE_BUILTINS.has(name) || spec.startsWith('node:');
    if (builtin) return `https://esm.sh/node/${name}`;
    const sub = spec.slice(name.length);
    const ver = this.versions[name];
    const base = `https://esm.sh/${name}${ver ? '@' + ver : ''}${sub}`;
    if (/\.(css|scss)$/.test(sub)) return `/__zr_virtual__/css?href=${encodeURIComponent(base)}`;
    const params = ['dev'];
    const deps = this.depsParam.split(',').filter((d) => d && !d.startsWith(name + '@') && d !== name);
    if (deps.length) params.push('deps=' + deps.join(','));
    if (query.includes('raw')) params.push('raw');
    return base + '?' + params.join('&');
  }
}

function isConfigFile(path: string) {
  return /^(vite|vitest|webpack|rollup|postcss|tailwind|eslint|babel|jest|prettier|next|playwright)\.config\./.test(path);
}

export function readEnvFile(files: FileMap): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    const raw = files.get(name);
    if (!raw) continue;
    for (const line of toText(raw).split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return env;
}
