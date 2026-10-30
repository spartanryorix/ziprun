import type { ServedFile } from './quick';

const CACHE = 'ziprun-vfs';
const ACTIVE_KEY = '/__ziprun__/active.json';

export interface PreviewConfig {
  id: string;
  entry: string;
  spa: boolean;
  tailwind: boolean;
}

let registration: Promise<ServiceWorkerRegistration> | null = null;

export function serviceWorkerSupported() {
  return 'serviceWorker' in navigator && 'caches' in window;
}

export async function ensureServiceWorker(): Promise<ServiceWorker> {
  if (!serviceWorkerSupported()) throw new Error('This browser does not support service workers (needed for previews). Try Chrome, Edge, Firefox or Safari.');
  registration ??= navigator.serviceWorker.register('/sw.js', { scope: '/' });
  const reg = await registration;
  const ready = await navigator.serviceWorker.ready;
  const worker = ready.active || reg.active || reg.waiting || reg.installing;
  if (!worker) throw new Error('Preview service worker failed to start.');
  if (worker.state !== 'activated') {
    await new Promise<void>((resolve) => {
      const check = () => worker.state === 'activated' && resolve();
      worker.addEventListener('statechange', check);
      check();
    });
  }
  return worker;
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const keyFor = (id: string, path: string) => `/__vfs__/${id}/${encodePath(path)}`;

export async function writeFiles(id: string, files: Iterable<[string, ServedFile]>) {
  const cache = await caches.open(CACHE);
  const jobs: Promise<void>[] = [];
  for (const [path, f] of files) {
    jobs.push(cache.put(keyFor(id, path), new Response(f.data as BodyInit, { headers: { 'Content-Type': f.type } })));
  }
  await Promise.all(jobs);
}

export async function removeFile(id: string, path: string) {
  const cache = await caches.open(CACHE);
  await cache.delete(keyFor(id, path));
}

/** Replace the whole served site for project `id` and make it the active preview. */
export async function publishSite(config: PreviewConfig, files: Iterable<[string, ServedFile]>) {
  const worker = await ensureServiceWorker();
  await caches.delete(CACHE);
  await writeFiles(config.id, files);
  const cache = await caches.open(CACHE);
  await cache.put(ACTIVE_KEY, new Response(JSON.stringify(config), { headers: { 'Content-Type': 'application/json' } }));
  await new Promise<void>((resolve) => {
    const nonce = Math.random().toString(36).slice(2);
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'zr-activated' && e.data.nonce === nonce) {
        navigator.serviceWorker.removeEventListener('message', onMsg);
        resolve();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    worker.postMessage({ type: 'zr-activate', config, nonce });
    setTimeout(resolve, 1500); // the config is also persisted in the cache
  });
}
