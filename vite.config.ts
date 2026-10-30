import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Cross-origin isolation is required by WebContainers (in-browser Node.js).
// `credentialless` keeps third-party CDNs (fonts, images, scripts) working inside previews.
const isolation = {
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** Serve the Vercel function in api/ai.js during `vite dev` and `vite preview`. */
function apiRoutes(): Plugin {
  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/ai')) return next();
    const mod = await import('./api/ai.js');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request('http://' + (req.headers.host || 'localhost') + req.url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
    const fn = req.method === 'GET' ? mod.GET : mod.POST;
    const response: Response = await fn(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (!response.body) return res.end();
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  };
  return {
    name: 'ziprun-api',
    configureServer: (server) => { server.middlewares.use(handle); },
    configurePreviewServer: (server) => { server.middlewares.use(handle); },
  };
}

export default defineConfig({
  plugins: [react(), apiRoutes()],
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { chunkSizeWarningLimit: 2000 },
});
