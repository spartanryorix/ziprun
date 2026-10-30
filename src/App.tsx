import { useEffect, useState } from 'react';
import Landing from './components/Landing';
import Workspace from './components/Workspace';
import type { FileMap } from './lib/files';
import { ensureServiceWorker, serviceWorkerSupported } from './lib/preview';
import { ensureLexer } from './lib/resolve';

export interface LoadedProject {
  id: string;
  name: string;
  files: FileMap;
  skipped: Record<string, number>;
}

export default function App() {
  const [project, setProject] = useState<LoadedProject | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return (localStorage.getItem('ziprun:theme') as 'dark' | 'light') || 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('ziprun:theme', theme); } catch { /* ignore */ }
  }, [theme]);

  // Install the preview service worker early so the first preview is instant.
  useEffect(() => {
    if (serviceWorkerSupported()) ensureServiceWorker().catch(() => {});
    ensureLexer().catch(() => {});
  }, []);

  // The import lexer must be ready before a project is analysed (it loads in a few ms).
  const open = (p: LoadedProject) => {
    ensureLexer().catch(() => {}).finally(() => setProject(p));
  };

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  if (project) {
    return <Workspace key={project.id} project={project} onClose={() => setProject(null)} theme={theme} onToggleTheme={toggleTheme} />;
  }
  return <Landing onOpen={open} theme={theme} onToggleTheme={toggleTheme} />;
}
