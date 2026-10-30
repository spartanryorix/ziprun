import { get, set, del } from 'idb-keyval';
import type { FileMap } from './files';

export interface RecentMeta {
  id: string;
  name: string;
  updatedAt: number;
  fileCount: number;
  size: number;
  stack: string[];
}

const LIST = 'ziprun:recents';
const MAX = 12;

export async function listRecents(): Promise<RecentMeta[]> {
  try {
    return ((await get(LIST)) as RecentMeta[]) || [];
  } catch {
    return [];
  }
}

export async function saveProject(meta: RecentMeta, files: FileMap) {
  try {
    await set('ziprun:proj:' + meta.id, { name: meta.name, files: Object.fromEntries(files) });
    const list = (await listRecents()).filter((r) => r.id !== meta.id);
    list.unshift(meta);
    for (const old of list.splice(MAX)) await del('ziprun:proj:' + old.id);
    await set(LIST, list);
  } catch {
    /* storage full or unavailable — recents are a convenience only */
  }
}

export async function loadProject(id: string): Promise<{ name: string; files: FileMap } | null> {
  try {
    const rec = (await get('ziprun:proj:' + id)) as { name: string; files: Record<string, Uint8Array> } | undefined;
    return rec ? { name: rec.name, files: new Map(Object.entries(rec.files)) } : null;
  } catch {
    return null;
  }
}

export async function deleteProject(id: string) {
  try {
    await del('ziprun:proj:' + id);
    await set(LIST, (await listRecents()).filter((r) => r.id !== id));
  } catch {
    /* ignore */
  }
}
