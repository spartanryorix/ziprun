import { FileMap, LANG, basename, dirname, ext, isText, normalize, parseJsonc, toText } from './files';
import { CODE_EXTS, NODE_BUILTINS, createResolver, packageName, scanImports, splitQuery } from './resolve';

export type Mode = 'static' | 'quick' | 'node';
export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  title: string;
  detail?: string;
  file?: string;
  line?: number;
}

export interface Analysis {
  name: string;
  stack: string[];
  kind: 'static' | 'react' | 'vanilla-module' | 'framework' | 'node-server' | 'python' | 'unknown';
  framework: string;
  recommended: Mode;
  supported: Mode[];
  htmlFiles: string[];
  staticEntry: string | null;
  pkg: any | null;
  scripts: Record<string, string>;
  deps: Record<string, string>;
  devDeps: Record<string, string>;
  languages: { name: string; lines: number; files: number }[];
  totalLines: number;
  totalSize: number;
  fileCount: number;
  envVars: { name: string; defined: boolean; files: string[] }[];
  diagnostics: Diagnostic[];
  score: number;
  tailwind: 0 | 3 | 4;
  runCommand: string;
  summary: string;
}

const FRAMEWORKS: [string, string, Mode[]][] = [
  // [dependency, label, supported modes besides node]
  ['next', 'Next.js', []],
  ['nuxt', 'Nuxt', []],
  ['@remix-run/react', 'Remix', []],
  ['@sveltejs/kit', 'SvelteKit', []],
  ['astro', 'Astro', []],
  ['@angular/core', 'Angular', []],
  ['svelte', 'Svelte', []],
  ['vue', 'Vue', []],
  ['solid-js', 'Solid', []],
  ['preact', 'Preact', ['quick']],
  ['react', 'React', ['quick']],
];
const SERVERS = ['express', 'fastify', 'koa', 'hono', '@hapi/hapi', '@nestjs/core', 'socket.io', 'http-server'];

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, 'OpenAI API key'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/sk_live_[A-Za-z0-9]{20,}/, 'Stripe secret key'],
  [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, 'Private key'],
];

function cleanDeps(obj: any): Record<string, string> {
  return obj && typeof obj === 'object' ? obj : {};
}

/** 0–100: errors cost 15, warnings 5, infos 1 (max 5). Runtime errors can be passed as extra errors. */
export function healthScore(diags: Diagnostic[], runtimeErrors = 0): number {
  const errors = diags.filter((d) => d.severity === 'error').length + runtimeErrors;
  const warnings = diags.filter((d) => d.severity === 'warning').length;
  const infos = diags.filter((d) => d.severity === 'info').length;
  return Math.max(0, Math.min(100, 100 - errors * 15 - warnings * 5 - Math.min(infos, 5)));
}

export function analyze(files: FileMap, projectName: string): Analysis {
  const diags: Diagnostic[] = [];
  const paths = [...files.keys()];
  const has = (p: string) => files.has(p);
  const text = (p: string) => (files.has(p) ? toText(files.get(p)!) : '');

  const pkg = has('package.json') ? parseJsonc(text('package.json')) : null;
  if (has('package.json') && !pkg) diags.push({ severity: 'error', title: 'package.json is not valid JSON', file: 'package.json' });
  const deps = cleanDeps(pkg?.dependencies);
  const devDeps = cleanDeps(pkg?.devDependencies);
  const allDeps = { ...devDeps, ...deps, ...cleanDeps(pkg?.peerDependencies) };
  const scripts = cleanDeps(pkg?.scripts);

  // ---- languages & size
  const langMap = new Map<string, { lines: number; files: number }>();
  let totalLines = 0;
  let totalSize = 0;
  const textFiles: string[] = [];
  for (const [p, d] of files) {
    totalSize += d.length;
    if (!isText(p, d)) continue;
    textFiles.push(p);
    const lang = LANG[ext(p)];
    if (!lang || p.endsWith('package-lock.json') || p.endsWith('.lock')) continue;
    const lines = toText(d).split('\n').length;
    totalLines += lines;
    const e = langMap.get(lang) || { lines: 0, files: 0 };
    e.lines += lines;
    e.files += 1;
    langMap.set(lang, e);
  }
  const languages = [...langMap.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.lines - a.lines);

  // ---- stack detection
  const stack: string[] = [];
  let framework = '';
  let frameworkModes: Mode[] = [];
  for (const [dep, label, modes] of FRAMEWORKS) {
    if (allDeps[dep]) {
      if (!framework) { framework = label; frameworkModes = modes; }
      stack.push(label);
    }
  }
  const codeFiles = paths.filter((p) => CODE_EXTS.some((e) => p.endsWith(e)));
  const usesJsx = codeFiles.some((p) => /\.(jsx|tsx)$/.test(p));
  const importsReact = !pkg && codeFiles.some((p) => /from\s+['"]react['"]/.test(text(p)));
  if (!framework && importsReact) { framework = 'React'; frameworkModes = ['quick']; stack.push('React'); }
  if (allDeps.vite) stack.push('Vite');
  if (allDeps['react-scripts']) stack.push('Create React App');
  if (allDeps.typescript || paths.some((p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts'))) stack.push('TypeScript');
  let tailwind: 0 | 3 | 4 = 0;
  const twVer = allDeps.tailwindcss || allDeps['@tailwindcss/vite'] || allDeps['@tailwindcss/postcss'];
  if (twVer) tailwind = /^[\^~]?4|latest/.test(twVer) || allDeps['@tailwindcss/vite'] ? 4 : 3;
  else if (paths.some((p) => /^tailwind\.config\.(js|cjs|mjs|ts)$/.test(p))) tailwind = 3;
  else if (!pkg && codeFiles.some((p) => /className=["'][^"']*\b(flex|grid|px-\d|bg-\w+-\d{3})/.test(text(p)))) tailwind = 3;
  if (tailwind) stack.push('Tailwind CSS');
  const server = SERVERS.find((s) => allDeps[s]);
  if (server) stack.push(server === 'express' ? 'Express' : server);
  const pyFiles = paths.filter((p) => p.endsWith('.py'));
  const isPython = pyFiles.length > 0 && (has('requirements.txt') || has('pyproject.toml') || pyFiles.length >= 1) && !pkg;
  if (pyFiles.length) stack.push('Python');
  const pyHint = ['flask', 'django', 'fastapi', 'streamlit'].find((f) => pyFiles.some((p) => new RegExp(`import ${f}|from ${f}`).test(text(p))));
  if (pyHint) stack.push(pyHint[0].toUpperCase() + pyHint.slice(1));

  const htmlFiles = paths.filter((p) => /\.html?$/.test(p) && !p.startsWith('node_modules/'));
  if (htmlFiles.length && !framework) stack.unshift('HTML/CSS/JS');

  // Static entry: prefer index.html at root, then built output folders.
  const builtRoots = ['dist', 'build', 'out', 'public', 'docs', 'site', 'www', 'src'];
  let staticEntry: string | null = null;
  if (has('index.html')) staticEntry = 'index.html';
  else {
    for (const r of builtRoots) if (has(r + '/index.html')) { staticEntry = r + '/index.html'; break; }
    if (!staticEntry) staticEntry = htmlFiles.find((p) => basename(p) === 'index.html') || htmlFiles[0] || null;
  }

  // ---- kind & modes
  let kind: Analysis['kind'] = 'unknown';
  let supported: Mode[] = [];
  let recommended: Mode = 'static';
  const hasBuildStep = !!pkg && (scripts.dev || scripts.start || scripts.build);
  const rootHtml = has('index.html') ? text('index.html') : '';
  const viteStyleEntry = /<script[^>]+type=["']module["'][^>]+src=["'][^"']+\.(tsx|ts|jsx)["']/.test(rootHtml);

  if (framework && frameworkModes.length === 0) {
    kind = 'framework';
    supported = ['node'];
    recommended = 'node';
  } else if (framework === 'React' || framework === 'Preact' || usesJsx) {
    kind = 'react';
    supported = ['quick', 'node'];
    recommended = 'quick';
    if (!pkg) supported = ['quick'];
  } else if (pkg && server && !htmlFiles.length) {
    kind = 'node-server';
    supported = ['node'];
    recommended = 'node';
  } else if (pkg && (viteStyleEntry || allDeps.vite || paths.some((p) => /^src\/.*\.ts$/.test(p)))) {
    kind = 'vanilla-module';
    supported = ['quick', 'node'];
    recommended = 'quick';
    if (staticEntry && !viteStyleEntry) supported.push('static');
  } else if (htmlFiles.length) {
    kind = 'static';
    supported = pkg ? ['static', 'node'] : ['static'];
    recommended = 'static';
  } else if (isPython) {
    kind = 'python';
    supported = htmlFiles.length ? ['static'] : [];
    recommended = 'static';
  } else if (pkg) {
    kind = 'node-server';
    supported = ['node'];
    recommended = 'node';
  }
  if (pkg && server && htmlFiles.length && !supported.includes('node')) supported.push('node');
  if (staticEntry && !supported.includes('static') && kind !== 'react') supported.push('static');

  const runScript = ['dev', 'start', 'serve', 'preview'].find((s) => scripts[s]);
  const serverFile = ['server.js', 'index.js', 'app.js', 'main.js', 'server.mjs', 'index.mjs'].find(has);
  const runCommand = pkg
    ? `npm install && ${runScript ? `npm run ${runScript}` : serverFile ? `node ${serverFile}` : 'npm start'}`
    : serverFile && kind === 'node-server' ? `node ${serverFile}` : 'npx -y serve .';

  // ---- diagnostics
  const resolver = createResolver(files);
  const lowerIndex = new Map(paths.map((p) => [p.toLowerCase(), p]));
  const missingPkgs = new Map<string, string>();

  for (const html of htmlFiles) {
    const src = text(html);
    const base = dirname(html);
    const webRoot = staticEntry ? dirname(staticEntry) : '';
    const re = /\b(?:src|href)\s*=\s*["']([^"'#?]+)[^"']*["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const ref = m[1].trim();
      if (!ref || /^(https?:|\/\/|data:|mailto:|tel:|javascript:|blob:|about:)/i.test(ref) || /[{}%$<>]/.test(ref)) continue;
      const tagStart = src.lastIndexOf('<', m.index);
      const tag = src.slice(tagStart, m.index).toLowerCase();
      if (tag.startsWith('<a ') && !/\.[a-z0-9]{2,5}$/i.test(ref)) continue; // routes like href="/about"
      const target = ref.startsWith('/') ? normalize((webRoot ? webRoot + '/' : '') + ref) : normalize(base + '/' + ref);
      if (target === null) continue;
      const candidates = [target, target + '/index.html', 'public/' + target.replace(new RegExp('^' + webRoot + '/?'), '')];
      if (candidates.some((c) => files.has(c)) || (target === '' && files.has('index.html'))) continue;
      const line = src.slice(0, m.index).split('\n').length;
      const ci = candidates.map((c) => lowerIndex.get(c.toLowerCase())).find(Boolean);
      if (ci) {
        diags.push({ severity: 'warning', title: `Case mismatch: "${ref}" vs "${ci}"`, detail: 'Works on Windows/macOS but breaks on Linux hosting (Vercel, Netlify, GitHub Pages). Rename the file or fix the reference.', file: html, line });
      } else if (!(viteStyleEntry && ref.startsWith('/src/') && resolver.resolve(html, ref))) {
        diags.push({ severity: 'error', title: `Missing file "${ref}"`, detail: `Referenced in ${html} but not found in the project.`, file: html, line });
      }
    }
    if (!/<meta[^>]+name=["']viewport["']/i.test(src) && /<html|<head/i.test(src)) {
      diags.push({ severity: 'warning', title: 'No viewport meta tag', detail: 'The page will look zoomed-out on phones. Add <meta name="viewport" content="width=device-width, initial-scale=1">.', file: html });
    }
    if (!/<title>[^<]+<\/title>/i.test(src) && /<head/i.test(src)) {
      diags.push({ severity: 'info', title: 'Missing <title>', detail: 'Browser tabs and search results will show the URL instead of a name.', file: html });
    }
    const imgs = src.match(/<img\b[^>]*>/gi) || [];
    const noAlt = imgs.filter((t) => !/\balt\s*=/.test(t)).length;
    if (noAlt) diags.push({ severity: 'info', title: `${noAlt} image${noAlt > 1 ? 's' : ''} without alt text`, detail: 'Screen readers cannot describe these images.', file: html });
  }

  const envUsed = new Map<string, Set<string>>();
  let todoCount = 0;
  for (const p of textFiles) {
    if (p.endsWith('package-lock.json') || p.endsWith('.lock') || p.endsWith('.min.js') || p.endsWith('.map')) continue;
    const src = text(p);
    const isCode = CODE_EXTS.some((e) => p.endsWith(e)) || p.endsWith('.vue') || p.endsWith('.svelte');
    const isConfig = /(^|\/)(vite|webpack|next|nuxt|svelte|astro|tailwind|postcss|eslint|babel|jest|vitest|playwright)\.config\./.test(p) || basename(p).startsWith('.');

    // secrets
    if (!basename(p).startsWith('.env')) {
      for (const [re, label] of SECRET_PATTERNS) {
        const m = src.match(re);
        if (m && m.index !== undefined) {
          diags.push({ severity: 'warning', title: `Hard-coded ${label}`, detail: `Found "${m[0].slice(0, 8)}…" in source. Anyone who sees this code (or the deployed site) can use it. Move it to an environment variable.`, file: p, line: src.slice(0, m.index).split('\n').length });
          break;
        }
      }
    }
    if (/\bTODO\b|\bFIXME\b/.test(src)) todoCount += (src.match(/\bTODO\b|\bFIXME\b/g) || []).length;
    if (!isCode) continue;

    // env vars
    const envRe = /(?:import\.meta\.env|process\.env)\.([A-Z_][A-Z0-9_]*)/g;
    let em: RegExpExecArray | null;
    while ((em = envRe.exec(src))) {
      const n = em[1];
      if (['NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL', 'PORT', 'PUBLIC_URL'].includes(n)) continue;
      if (!envUsed.has(n)) envUsed.set(n, new Set());
      envUsed.get(n)!.add(p);
    }

    const lh = src.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
    if (lh && !isConfig && lh.index !== undefined) {
      diags.push({ severity: 'warning', title: `Calls a local backend on port ${lh[1]}`, detail: `The frontend talks to ${lh[0]}. That server is not part of a static preview — run the backend in Node mode or point it at a deployed API.`, file: p, line: src.slice(0, lh.index).split('\n').length });
    }
    const abs = src.match(/['"`](?:[A-Z]:\\\\|\/Users\/|\/home\/|file:\/\/)[^'"`]*['"`]/);
    if (abs && abs.index !== undefined) {
      diags.push({ severity: 'warning', title: 'Absolute path to your computer', detail: `${abs[0]} only exists on the machine that generated this code.`, file: p, line: src.slice(0, abs.index).split('\n').length });
    }

    if (isConfig) continue;
    for (const { spec, line } of scanImports(src, p)) {
      const [s] = splitQuery(spec);
      if (/^(https?:|data:|virtual:|\/\/)/.test(s) || s.startsWith('astro:') || s.startsWith('$app') || s.startsWith('$lib')) continue;
      if (resolver.isLocal(s)) {
        if (!resolver.resolve(p, s) && !s.startsWith('/')) {
          diags.push({ severity: 'error', title: `Cannot resolve import "${s}"`, detail: `${p} imports a file that is not in the project.`, file: p, line });
        }
      } else if (pkg || kind === 'react') {
        const name = packageName(s);
        if (NODE_BUILTINS.has(name) || s.startsWith('node:')) continue;
        if (!allDeps[name] && name && !name.startsWith('@types/') && !missingPkgs.has(name)) missingPkgs.set(name, p);
      }
    }
  }
  if (pkg) {
    for (const [name, p] of missingPkgs) {
      diags.push({ severity: 'warning', title: `"${name}" is imported but not in package.json`, detail: `npm install will not install it. Add it with: npm install ${name}`, file: p });
    }
  } else if (missingPkgs.size && kind === 'react') {
    diags.push({ severity: 'info', title: 'No package.json', detail: `Packages (${[...missingPkgs.keys()].slice(0, 8).join(', ')}) are loaded automatically from the esm.sh CDN at their latest versions.` });
  }

  const envDefined = new Set<string>();
  for (const name of ['.env', '.env.local', '.env.development', '.env.example', '.env.sample']) {
    if (!has(name)) continue;
    for (const line of text(name).split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && (name.includes('example') || name.includes('sample') ? true : m[2].trim() !== '')) {
        envDefined.add(m[1]);
        if ((name.includes('example') || name.includes('sample')) && !envUsed.has(m[1])) envUsed.set(m[1], new Set([name]));
      }
    }
  }
  if (has('.env') || has('.env.local')) diags.push({ severity: 'info', title: 'Contains a .env file', detail: 'Make sure it does not contain real secrets before sharing or committing this project.', file: has('.env') ? '.env' : '.env.local' });
  const envVars = [...envUsed.entries()].map(([name, set]) => ({ name, defined: envDefined.has(name) && !!(has('.env') || has('.env.local')), files: [...set] }));
  const undefinedEnv = envVars.filter((v) => !v.defined);
  if (undefinedEnv.length) {
    diags.push({ severity: 'warning', title: `${undefinedEnv.length} environment variable${undefinedEnv.length > 1 ? 's' : ''} without a value`, detail: `${undefinedEnv.map((v) => v.name).join(', ')}. Set them in the Insights → Environment section so the preview gets real values.` });
  }

  if (pkg && kind !== 'static' && !runScript && !serverFile) diags.push({ severity: 'warning', title: 'No "dev" or "start" script in package.json', detail: 'ZipRun cannot guess how to start this project in Node mode. Add a "dev" script.', file: 'package.json' });
  if (!htmlFiles.length && kind !== 'node-server' && kind !== 'framework' && kind !== 'python' && !codeFiles.length) diags.push({ severity: 'error', title: 'Nothing to run', detail: 'No HTML entry point or JavaScript/TypeScript source was found in this zip.' });
  if (kind === 'python') diags.push({ severity: 'info', title: `Python project${pyHint ? ` (${pyHint})` : ''}`, detail: 'Python servers cannot run inside the browser. You can still browse the code, and any HTML templates/static files are previewable.' });
  if (paths.some((p) => /\.(scss|sass|less)$/.test(p)) && recommended === 'quick') diags.push({ severity: 'info', title: 'Uses Sass/Less', detail: 'Instant mode skips Sass/Less compilation; switch to Node mode for exact styling.' });
  const big = [...files.entries()].filter(([, d]) => d.length > 5 * 1024 * 1024);
  for (const [p, d] of big) diags.push({ severity: 'info', title: 'Large file', detail: `${p} is ${(d.length / 1024 / 1024).toFixed(1)} MB and will slow down loading.`, file: p });
  if (todoCount) diags.push({ severity: 'info', title: `${todoCount} TODO/FIXME comment${todoCount > 1 ? 's' : ''}`, detail: 'Unfinished work left in the code.' });

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  diags.sort((a, b) => order[a.severity] - order[b.severity]);
  const score = healthScore(diags);

  const name = (pkg?.name && String(pkg.name)) || projectName;
  const kindLabel: Record<Analysis['kind'], string> = {
    static: 'static website', react: 'React app', 'vanilla-module': 'JavaScript/TypeScript app',
    framework: `${framework} app`, 'node-server': 'Node.js server', python: 'Python project', unknown: 'project',
  };
  const summary = `${kindLabel[kind]} · ${files.size} files · ${totalLines.toLocaleString()} lines`;

  return {
    name, stack: [...new Set(stack)], kind, framework, recommended, supported: [...new Set(supported)], htmlFiles,
    staticEntry, pkg, scripts, deps, devDeps, languages, totalLines, totalSize, fileCount: files.size,
    envVars, diagnostics: diags, score, tailwind, runCommand, summary,
  };
}
