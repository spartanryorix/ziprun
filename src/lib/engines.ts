import type { FileSystemTree, WebContainer as WC, WebContainerProcess } from '@webcontainer/api';
import { FileMap, dirname, mimeOf } from './files';
import type { Analysis } from './analyze';
import type { Served } from './quick';

/** Static engine: serve the folder that contains the chosen HTML entry as the site root. */
export function buildStatic(files: FileMap, analysis: Analysis, entryHtml?: string) {
  const entry = entryHtml || analysis.staticEntry || 'index.html';
  const root = dirname(entry);
  const served: Served = new Map();
  for (const [p, d] of files) {
    if (root && !p.startsWith(root + '/')) continue;
    served.set(root ? p.slice(root.length + 1) : p, { data: d, type: mimeOf(p) });
  }
  const rel = root ? entry.slice(root.length + 1) : entry;
  return { served, entry: rel, root };
}

export const staticPath = (root: string, path: string) => (root ? (path.startsWith(root + '/') ? path.slice(root.length + 1) : null) : path);

// ---------------------------------------------------------------- Node (WebContainers)

export interface NodeCallbacks {
  onOutput(data: string): void;
  onServer(port: number, url: string): void;
  onPort(port: number, type: 'open' | 'close', url: string): void;
  onStatus(status: string): void;
  onError(message: string): void;
}

let bootPromise: Promise<WC> | null = null;

export function nodeSupported(): { ok: boolean; reason?: string } {
  if (typeof SharedArrayBuffer === 'undefined' || !window.crossOriginIsolated) {
    const safari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    return {
      ok: false,
      reason: safari
        ? 'Node mode needs Chrome, Edge, Brave or Firefox — Safari does not support in-browser Node.js yet.'
        : 'Node mode needs a cross-origin isolated page (SharedArrayBuffer). Use Chrome, Edge or Firefox.',
    };
  }
  return { ok: true };
}

function toTree(files: FileMap): FileSystemTree {
  const tree: FileSystemTree = {};
  for (const [path, data] of files) {
    const parts = path.split('/');
    let node: FileSystemTree = tree;
    for (const dir of parts.slice(0, -1)) {
      if (!node[dir] || !('directory' in node[dir])) node[dir] = { directory: {} };
      node = (node[dir] as { directory: FileSystemTree }).directory;
    }
    node[parts[parts.length - 1]] = { file: { contents: data } };
  }
  return tree;
}

export class NodeEngine {
  wc: WC | null = null;
  shell: WebContainerProcess | null = null;
  private input: WritableStreamDefaultWriter<string> | null = null;
  private disposers: (() => void)[] = [];
  private disposed = false;

  constructor(private cb: NodeCallbacks) {}

  async start(files: FileMap, command: string, size: { cols: number; rows: number }, previewScript: string) {
    const { WebContainer } = await import('@webcontainer/api');
    this.cb.onStatus('Booting Node.js in your browser…');
    if (bootPromise) {
      try { (await bootPromise).teardown(); } catch { /* already gone */ }
      bootPromise = null;
    }
    bootPromise = WebContainer.boot({ coep: 'credentialless', workdirName: 'project' });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
      'Node.js did not start within 60 s. A browser extension, firewall or network policy may be blocking stackblitz.com / webcontainer-api.io.')), 60000));
    const wc = (this.wc = await Promise.race([bootPromise, timeout]));
    if (this.disposed) return;
    this.disposers.push(
      wc.on('server-ready', (port, url) => this.cb.onServer(port, url)),
      wc.on('port', (port, type, url) => this.cb.onPort(port, type, url)),
      wc.on('error', (e) => this.cb.onError(e.message)),
    );
    await wc.setPreviewScript(previewScript).catch(() => {});
    this.cb.onStatus('Copying project files…');
    await wc.mount(toTree(files));
    this.cb.onStatus('Starting terminal…');
    const shell = (this.shell = await wc.spawn('jsh', { terminal: size, env: { FORCE_COLOR: '3' } }));
    shell.output.pipeTo(new WritableStream({ write: (d) => this.cb.onOutput(d) })).catch(() => {});
    this.input = shell.input.getWriter();
    this.cb.onStatus('Installing dependencies & starting dev server…');
    if (command) await this.write(command + '\n');
  }

  write(data: string) {
    return this.input?.write(data);
  }

  resize(cols: number, rows: number) {
    this.shell?.resize({ cols, rows });
  }

  async writeFile(path: string, data: Uint8Array) {
    if (!this.wc) return;
    const dir = dirname(path);
    if (dir) await this.wc.fs.mkdir(dir, { recursive: true });
    await this.wc.fs.writeFile(path, data);
  }

  async deleteFile(path: string) {
    await this.wc?.fs.rm(path, { force: true }).catch(() => {});
  }

  /** Read the container's files back (excluding node_modules) so edits made in the terminal are kept. */
  async snapshot(): Promise<FileMap | null> {
    if (!this.wc) return null;
    const out: FileMap = new Map();
    const walk = async (dir: string) => {
      const entries = await this.wc!.fs.readdir(dir || '.', { withFileTypes: true });
      for (const e of entries) {
        const p = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (['node_modules', '.git', '.cache', 'dist', '.next', '.vite'].includes(e.name)) continue;
          await walk(p);
        } else out.set(p, await this.wc!.fs.readFile(p));
      }
    };
    await walk('');
    return out;
  }

  dispose() {
    this.disposed = true;
    this.disposers.forEach((d) => d());
    this.disposers = [];
    try { this.shell?.kill(); } catch { /* ignore */ }
    this.input = null;
    this.shell = null;
  }
}
