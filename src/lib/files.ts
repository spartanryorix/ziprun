import JSZip from 'jszip';

/** Project files keyed by POSIX path relative to the project root (no leading slash). */
export type FileMap = Map<string, Uint8Array>;

const enc = new TextEncoder();
const dec = new TextDecoder();

export const toBytes = (s: string) => enc.encode(s);
export const toText = (b: Uint8Array) => dec.decode(b);

export const ext = (path: string) => {
  const name = path.split('/').pop() || '';
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};
export const basename = (path: string) => path.split('/').pop() || path;
export const dirname = (path: string) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** Resolve `.` and `..` segments. Returns null when the path escapes the root. */
export function normalize(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8', jsx: 'text/javascript; charset=utf-8', ts: 'text/javascript; charset=utf-8',
  tsx: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json',
  webmanifest: 'application/manifest+json', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  xml: 'application/xml', csv: 'text/csv; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ico: 'image/x-icon', bmp: 'image/bmp', mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', eot: 'application/vnd.ms-fontobject', wasm: 'application/wasm', pdf: 'application/pdf',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json',
};
export const mimeOf = (path: string) => MIME[ext(path)] || 'application/octet-stream';

const TEXT_EXT = new Set([
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'json', 'jsonc', 'map', 'md', 'mdx', 'txt', 'xml', 'svg', 'csv', 'yml', 'yaml', 'toml', 'ini', 'env',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs', 'sh', 'bat', 'ps1',
  'vue', 'svelte', 'astro', 'graphql', 'gql', 'prisma', 'sql', 'webmanifest', 'lock', 'gitignore',
  'npmrc', 'nvmrc', 'editorconfig', 'prettierrc', 'eslintrc', 'babelrc', 'hbs', 'ejs', 'pug', 'njk', 'liquid',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'svg']);
export const isImage = (path: string) => IMAGE_EXT.has(ext(path));

export function isText(path: string, data: Uint8Array): boolean {
  const e = ext(path);
  if (TEXT_EXT.has(e)) return true;
  const name = basename(path);
  if (!e || name.startsWith('.')) {
    // No extension (Dockerfile, LICENSE, .env.local …): sniff for NUL bytes.
    const n = Math.min(data.length, 4000);
    for (let i = 0; i < n; i++) if (data[i] === 0) return false;
    return true;
  }
  return false;
}

export const LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  mjs: 'JavaScript', cjs: 'JavaScript', html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'SCSS',
  less: 'Less', vue: 'Vue', svelte: 'Svelte', astro: 'Astro', py: 'Python', md: 'Markdown', mdx: 'Markdown',
  json: 'JSON', php: 'PHP', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', sql: 'SQL', sh: 'Shell',
};

const IGNORE_DIRS = ['node_modules', '.git', '__MACOSX', '.next', '.nuxt', '.svelte-kit', '.vercel', '.turbo',
  '.cache', '.parcel-cache', '__pycache__', '.venv', 'venv', '.idea', '.angular', '.expo'];
const IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export interface LoadResult {
  files: FileMap;
  skipped: Record<string, number>;
}

function shouldSkip(path: string, skipped: Record<string, number>): boolean {
  const parts = path.split('/');
  for (const p of parts.slice(0, -1)) {
    if (IGNORE_DIRS.includes(p)) {
      skipped[p] = (skipped[p] || 0) + 1;
      return true;
    }
  }
  const name = parts[parts.length - 1];
  if (IGNORE_FILES.has(name) || name.startsWith('._')) return true;
  return false;
}

/** If every file lives under one top-level folder (typical for zips), drop that folder. */
export function stripCommonRoot(files: FileMap): FileMap {
  let current = files;
  for (;;) {
    const paths = [...current.keys()];
    if (!paths.length) return current;
    const first = paths[0].split('/')[0];
    if (!paths.every((p) => p.startsWith(first + '/'))) return current;
    const next: FileMap = new Map();
    for (const [p, d] of current) next.set(p.slice(first.length + 1), d);
    current = next;
  }
}

export async function loadZip(blob: Blob): Promise<LoadResult> {
  const zip = await JSZip.loadAsync(blob);
  const files: FileMap = new Map();
  const skipped: Record<string, number> = {};
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  await Promise.all(
    entries.map(async (entry) => {
      const path = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!path || shouldSkip(path, skipped)) return;
      files.set(path, await entry.async('uint8array'));
    }),
  );
  return { files: stripCommonRoot(sortMap(files)), skipped };
}

export async function loadFileList(list: { path: string; file: File }[]): Promise<LoadResult> {
  const files: FileMap = new Map();
  const skipped: Record<string, number> = {};
  for (const { path, file } of list) {
    const p = path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!p || shouldSkip(p, skipped)) continue;
    files.set(p, new Uint8Array(await file.arrayBuffer()));
  }
  return { files: stripCommonRoot(sortMap(files)), skipped };
}

function sortMap(files: FileMap): FileMap {
  return new Map([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export async function exportZip(files: FileMap, rootName: string): Promise<Blob> {
  const zip = new JSZip();
  const folder = zip.folder(rootName) || zip;
  for (const [p, d] of files) folder.file(p, d);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** Lenient JSON parse that tolerates comments and trailing commas (tsconfig.json style). */
export function parseJsonc(text: string): any {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}
