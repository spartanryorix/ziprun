import { transform } from 'sucrase';
import { init as lexerInit, parse as lexParse } from 'es-module-lexer/minimal';
import { FileMap, dirname, ext, normalize, parseJsonc, toText } from './files';

let lexerReady = false;
let lexerPromise: Promise<void> | null = null;
/** Load the (tiny, wasm) module lexer once. Call before analysing a project. */
export const ensureLexer = () => (lexerPromise ??= lexerInit().then(() => { lexerReady = true; }));

export const CODE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts'];
const TRY_EXTS = [...CODE_EXTS, '.json', '.vue', '.svelte', '.css'];

export const NODE_BUILTINS = new Set(['fs', 'path', 'os', 'http', 'https', 'url', 'crypto', 'stream', 'util',
  'events', 'child_process', 'net', 'tls', 'zlib', 'buffer', 'process', 'querystring', 'readline', 'assert',
  'dns', 'cluster', 'worker_threads', 'perf_hooks', 'module', 'vm', 'string_decoder', 'timers', 'tty', 'v8']);

export interface Resolver {
  /** Resolve a local import to a project file path, or null when it is a package import / missing. */
  resolve(from: string, spec: string): string | null;
  /** True when the specifier should be treated as a local file (relative, absolute or aliased). */
  isLocal(spec: string): boolean;
}

export function splitQuery(spec: string): [string, string] {
  const i = spec.indexOf('?');
  return i === -1 ? [spec, ''] : [spec.slice(0, i), spec.slice(i + 1)];
}

export function packageName(spec: string): string {
  const parts = spec.replace(/^node:/, '').split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Build a resolver that understands relative paths, `/src/x`, tsconfig `paths`/`baseUrl` and common `@/` aliases. */
export function createResolver(files: FileMap): Resolver {
  const aliases: [string, string][] = [];
  let baseUrl: string | null = null;

  for (const cfgName of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) {
    const raw = files.get(cfgName);
    if (!raw) continue;
    const cfg = parseJsonc(toText(raw));
    const co = cfg?.compilerOptions;
    if (!co) continue;
    const base = normalize(co.baseUrl || '.') ?? '';
    if (co.baseUrl && baseUrl === null) baseUrl = base;
    for (const [key, targets] of Object.entries<any>(co.paths || {})) {
      const target = Array.isArray(targets) ? targets[0] : null;
      if (typeof target !== 'string') continue;
      const from = key.replace(/\*$/, '');
      const to = normalize((base ? base + '/' : '') + target.replace(/\*$/, '')) ?? '';
      aliases.push([from, to + (from.endsWith('/') && to ? '/' : '')]);
    }
  }

  // vite.config aliases like  '@': path.resolve(__dirname, './src')
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) {
    const raw = files.get(name);
    if (!raw) continue;
    const re = /['"]?([@~#$][\w\-/]*)['"]?\s*:\s*(?:path\.)?(?:resolve|join)\([^)]*?['"]\.?\/?([\w.\-/]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(toText(raw)))) {
      const from = m[1].replace(/\/$/, '');
      aliases.push([from + '/', normalize(m[2]) + '/']);
      aliases.push([from, normalize(m[2]) ?? '']);
    }
  }

  const hasSrc = [...files.keys()].some((p) => p.startsWith('src/'));
  if (hasSrc) {
    if (!aliases.some(([a]) => a === '@/')) aliases.push(['@/', 'src/']);
    if (!aliases.some(([a]) => a === '~/')) aliases.push(['~/', 'src/']);
  }
  aliases.sort((a, b) => b[0].length - a[0].length);

  function aliasTarget(spec: string): string | null {
    for (const [from, to] of aliases) {
      if (from.endsWith('/') ? spec.startsWith(from) : spec === from) return to + spec.slice(from.length);
    }
    return null;
  }

  function lookup(base: string): string | null {
    if (files.has(base)) return base;
    for (const e of TRY_EXTS) if (files.has(base + e)) return base + e;
    // TS convention: import './x.js' that actually refers to x.ts
    const m = base.match(/^(.*)\.(m?js|jsx)$/);
    if (m) for (const e of ['.ts', '.tsx', '.mts']) if (files.has(m[1] + e)) return m[1] + e;
    for (const e of TRY_EXTS) if (files.has((base ? base + '/' : '') + 'index' + e)) return (base ? base + '/' : '') + 'index' + e;
    return null;
  }

  return {
    isLocal(spec) {
      const [s] = splitQuery(spec);
      if (s.startsWith('.') || s.startsWith('/')) return true;
      if (aliasTarget(s) !== null) return true;
      if (baseUrl !== null) return lookup(normalize((baseUrl ? baseUrl + '/' : '') + s) ?? '') !== null;
      return false;
    },
    resolve(from, spec) {
      const [s] = splitQuery(spec);
      let target: string | null;
      if (s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..') target = normalize(dirname(from) + '/' + s);
      else if (s.startsWith('/')) {
        target = normalize(s);
        if (target !== null && !lookup(target) && files.has('public/' + target)) return 'public/' + target;
      } else {
        const a = aliasTarget(s);
        if (a !== null) target = normalize(a);
        else if (baseUrl !== null) target = normalize((baseUrl ? baseUrl + '/' : '') + s);
        else target = null;
      }
      return target === null ? null : lookup(target);
    },
  };
}

/**
 * Find the imports of a source file. Transpiles with sucrase (which keeps line numbers) and lexes the
 * result, so code inside strings and template literals — e.g. a demo app embedded as text — is ignored.
 * Falls back to a regex scan for files sucrase cannot parse (Vue/Svelte) or before the lexer is ready.
 */
export function scanImports(code: string, path = 'file.tsx'): { spec: string; line: number }[] {
  if (lexerReady && /^(m?[jt]sx?|cjs|cts|mts)$/.test(ext(path))) {
    try {
      const e = ext(path);
      const transforms: ('typescript' | 'jsx')[] = /^(ts|mts|cts)$/.test(e) ? ['typescript'] : e === 'tsx' ? ['typescript', 'jsx'] : ['jsx'];
      const out = transform(code, { transforms, jsxRuntime: 'classic', production: true, disableESTransforms: true, preserveDynamicImport: true }).code;
      const [imports] = lexParse(out);
      return imports
        .filter((im) => im.n !== undefined && im.d !== -2)
        .map((im) => ({ spec: im.n!, line: out.slice(0, im.s).split('\n').length }));
    } catch {
      /* fall back to the regex scan below */
    }
  }
  return regexImports(code);
}

function regexImports(code: string): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = [];
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const re = /(?:^|[^\w$.])(?:import\s*(?:[\w$*{}\s,]+?\s*from\s*)?|export\s*(?:[\w$*{}\s,]+?)\s*from\s*|import\s*\(\s*|require\s*\(\s*)(['"])([^'"\n]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const before = stripped.lastIndexOf('\n', m.index);
    const lineStart = stripped.slice(before + 1, m.index + 1);
    if (/^\s*\/\//.test(lineStart)) continue;
    out.push({ spec: m[2], line: stripped.slice(0, m.index).split('\n').length + (stripped[m.index] === '\n' ? 1 : 0) });
  }
  return out;
}
