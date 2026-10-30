/*
 * ZipRun preview service worker.
 *
 * The app writes the files of the loaded project into Cache Storage. Any request
 * that comes from the preview <iframe> (a "nested" window client) is answered from
 * that cache, so the uploaded project behaves exactly like it would on localhost:
 * root-absolute URLs (/style.css), client-side routers (/about) and fetch() calls
 * to local JSON files all just work.
 */
const CACHE = 'ziprun-vfs';
const ACTIVE_KEY = '/__ziprun__/active.json';
const TAB_PREFIX = '/__preview__';
const VIRTUAL = '/__zr_virtual__/';

let active = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'zr-activate') {
    active = data.config;
    if (event.source) event.source.postMessage({ type: 'zr-activated', nonce: data.nonce });
  }
});

async function getActive() {
  if (active) return active;
  const cache = await caches.open(CACHE);
  const res = await cache.match(ACTIVE_KEY);
  active = res ? await res.json() : null;
  return active;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js' || url.pathname.startsWith('/__ziprun__/')) return;

  const frameNav = req.mode === 'navigate' && req.destination === 'iframe';
  const tabPreview = url.pathname === TAB_PREFIX || url.pathname.startsWith(TAB_PREFIX + '/');
  // Top-level navigation to the ZipRun app itself: let the network handle it.
  if (req.mode === 'navigate' && !frameNav && !tabPreview) return;

  event.respondWith(route(event, url, frameNav, tabPreview));
});

async function route(event, url, frameNav, tabPreview) {
  let inPreview = frameNav || tabPreview;
  if (!inPreview && event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) {
      const clientPath = new URL(client.url).pathname;
      if (client.frameType === 'nested') inPreview = true;
      else if (clientPath === TAB_PREFIX || clientPath.startsWith(TAB_PREFIX + '/')) inPreview = true;
    }
  }
  if (!inPreview) return fetch(event.request);

  const started = Date.now();
  let path = url.pathname;
  if (path === TAB_PREFIX || path.startsWith(TAB_PREFIX + '/')) path = path.slice(TAB_PREFIX.length) || '/';
  let res;
  try {
    res = await serve(event.request, url, path);
  } catch (err) {
    res = new Response('ZipRun preview error: ' + (err && err.message), { status: 500 });
  }
  report({
    method: event.request.method,
    path: path + url.search,
    status: res.status,
    type: res.headers.get('content-type') || '',
    size: Number(res.headers.get('x-zr-size') || 0),
    ms: Date.now() - started,
    kind: event.request.destination || 'fetch',
  });
  return res;
}

async function report(entry) {
  const all = await self.clients.matchAll({ type: 'window' });
  for (const c of all) {
    if (c.frameType === 'top-level' && !new URL(c.url).pathname.startsWith(TAB_PREFIX)) {
      c.postMessage({ type: 'zr-net', entry });
    }
  }
}

function headers(type, size) {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'x-zr-size': String(size),
  };
}

function js(code) {
  return new Response(code, { status: 200, headers: headers('text/javascript; charset=utf-8', code.length) });
}

async function serve(request, url, rawPath) {
  const cfg = await getActive();
  if (!cfg) return new Response('No project is loaded in ZipRun.', { status: 404 });

  if (rawPath.startsWith(VIRTUAL)) return virtual(rawPath.slice(VIRTUAL.length), url, cfg);

  let rel;
  try { rel = decodeURIComponent(rawPath).replace(/^\/+/, ''); } catch { rel = rawPath.replace(/^\/+/, ''); }
  const cache = await caches.open(CACHE);
  const base = '/__vfs__/' + cfg.id + '/';

  const candidates = [];
  if (rel === '' || rel.endsWith('/')) candidates.push(rel + 'index.html');
  else candidates.push(rel, rel + '.html', rel + '/index.html');

  let hit = null;
  let hitPath = null;
  for (const c of candidates) {
    hit = await cache.match(base + encodePath(c));
    if (hit) { hitPath = c; break; }
  }

  const wantsHtml = request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
  if (!hit && wantsHtml && cfg.spa && !/\.[a-z0-9]{1,5}$/i.test(rel)) {
    hit = await cache.match(base + encodePath(cfg.entry || 'index.html'));
    hitPath = cfg.entry || 'index.html';
  }
  if (!hit) {
    return new Response(`404 — "${rawPath}" is not in the uploaded project.`, {
      status: 404,
      headers: headers('text/plain; charset=utf-8', 0),
    });
  }

  const q = url.searchParams;
  if (q.has('module')) return cssModule(await hit.text(), '/' + hitPath, cfg);
  if (q.has('asset') || q.has('url')) return js('export default ' + JSON.stringify('/' + hitPath) + ';');
  if (q.has('raw')) return js('export default ' + JSON.stringify(await hit.text()) + ';');
  if (q.has('json')) return js('export default ' + ((await hit.text()) || 'null') + ';');

  const type = hit.headers.get('content-type') || 'application/octet-stream';
  if (type.startsWith('text/html')) {
    const html = injectBridge(await hit.text());
    return new Response(html, { status: 200, headers: headers(type, html.length) });
  }
  const body = await hit.arrayBuffer();
  return new Response(body, { status: 200, headers: headers(type, body.byteLength) });
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function injectBridge(html) {
  const tag = '<script src="/__ziprun__/bridge.js"></script>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + tag);
  return tag + html;
}

function cssModule(css, file, cfg) {
  const isModule = /\.module\.(css|scss|sass|less)$/.test(file);
  const styleType = cfg.tailwind ? 'text/tailwindcss' : 'text/css';
  return js(`
const css = ${JSON.stringify(css)};
let el = document.querySelector('style[data-zr-file=${JSON.stringify(file)}]');
if (!el) { el = document.createElement('style'); el.setAttribute('data-zr-file', ${JSON.stringify(file)}); el.type = ${JSON.stringify(styleType)}; document.head.appendChild(el); }
el.textContent = css;
export default ${isModule ? 'new Proxy({}, { get: (_, k) => typeof k === "string" ? k : undefined })' : 'css'};
`);
}

function virtual(name, url, cfg) {
  if (name === 'css') {
    const href = url.searchParams.get('href') || '';
    return js(`
const href = ${JSON.stringify(href)};
if (!document.querySelector('link[data-zr-href="' + href + '"]')) {
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-zr-href', href);
  document.head.appendChild(l);
}
export default href;
`);
  }
  return new Response('Unknown virtual module', { status: 404 });
}
