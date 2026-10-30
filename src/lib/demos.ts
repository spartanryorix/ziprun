import { FileMap, toBytes } from './files';

const make = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, toBytes(v)]));

export const DEMOS: { id: string; name: string; description: string; files: () => FileMap }[] = [
  {
    id: 'broken-weather',
    name: 'broken-weather-app',
    description: 'AI-generated app with real bugs. Try AI Auto-fix!',
    files: () =>
      make({
        'package.json': JSON.stringify({
          name: 'broken-weather-app', private: true, version: '0.1.0', type: 'module',
          scripts: { dev: 'vite', build: 'vite build' },
          dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
          devDependencies: { vite: '^5.4.0', '@vitejs/plugin-react': '^4.3.0' },
        }, null, 2),
        'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Weather Now</title>
  </head>
  <body>
    <img src="/logo.png" class="logo">
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
        'src/main.jsx': `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
`,
        'src/App.jsx': `import WeatherCard from './components/weathercard';
import { cities } from './data';

export default function App() {
  const [unit, setUnit] = useState('C');
  return (
    <main className="app">
      <header>
        <h1>Weather Now</h1>
        <button onClick={() => setUnit(unit === 'C' ? 'F' : 'C')}>Show °{unit === 'C' ? 'F' : 'C'}</button>
      </header>
      <section className="grid">
        {cities.map((c) => <WeatherCard key={c.name} city={c} unit={unit} />)}
      </section>
    </main>
  );
}
`,
        'src/components/WeatherCard.jsx': `import { formatTemp } from '../utils/format';

export default function WeatherCard({ city, unit }) {
  return (
    <article className="card">
      <div className="icon">{city.icon}</div>
      <h2>{city.name}</h2>
      <p className="temp">{formatTemp(city.tempC, unit)}</p>
      <p className="muted">{city.condition}</p>
    </article>
  );
}
`,
        'src/utils/format.js': `export function formatTemperature(celsius, unit) {
  const value = unit === 'F' ? celsius * 9 / 5 + 32 : celsius;
  return Math.round(value) + '°' + unit;
}
`,
        'src/data.js': `export const cities = [
  { name: 'Lisbon', tempC: 22, condition: 'Sunny', icon: '☀️' },
  { name: 'Oslo', tempC: 7, condition: 'Rain showers', icon: '🌧️' },
  { name: 'Tokyo', tempC: 18, condition: 'Partly cloudy', icon: '⛅' },
  { name: 'Nairobi', tempC: 25, condition: 'Clear', icon: '🌤️' },
];
`,
        'src/index.css': `body { margin: 0; font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }
.app { max-width: 900px; margin: 0 auto; padding: 32px 16px; }
header { display: flex; justify-content: space-between; align-items: center; }
header button { background: #38bdf8; border: 0; color: #0f172a; padding: 8px 14px; border-radius: 8px; font-weight: 600; cursor: pointer; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-top: 24px; }
.card { background: #1e293b; border-radius: 16px; padding: 20px; }
.icon { font-size: 36px; }
.temp { font-size: 32px; font-weight: 800; margin: 8px 0; }
.muted { color: #94a3b8; margin: 0; }
.logo { display: block; width: 40px; margin: 16px auto 0; }
`,
      }),
  },
  {
    id: 'react-tasks',
    name: 'react-task-board',
    description: 'Vite + React + Tailwind task board',
    files: () =>
      make({
        'package.json': JSON.stringify({
          name: 'react-task-board', private: true, version: '0.1.0', type: 'module',
          scripts: { dev: 'vite', build: 'vite build' },
          dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', 'lucide-react': '^0.460.0' },
          devDependencies: { vite: '^5.4.0', '@vitejs/plugin-react': '^4.3.0', tailwindcss: '^3.4.0', postcss: '^8.4.0', autoprefixer: '^10.4.0' },
        }, null, 2),
        'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Task Board</title>
  </head>
  <body class="bg-slate-950">
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
        'vite.config.js': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n`,
        'tailwind.config.js': `export default {\n  content: ['./index.html', './src/**/*.{js,jsx}'],\n  theme: { extend: { colors: { brand: '#7c5cff' } } },\n  plugins: [],\n};\n`,
        'postcss.config.js': `export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`,
        'src/index.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\nbody { font-family: Inter, system-ui, sans-serif; }\n`,
        'src/main.jsx': `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
        'src/App.jsx': `import { useState } from 'react';
import { Plus, Check, Trash2, Sparkles } from 'lucide-react';
import { useLocalStorage } from './useLocalStorage';

const seed = [
  { id: 1, text: 'Upload a zip to ZipRun', done: true },
  { id: 2, text: 'Edit this file and watch the preview update', done: false },
  { id: 3, text: 'Open the Console tab and type document.title', done: false },
];

export default function App() {
  const [tasks, setTasks] = useLocalStorage('tasks', seed);
  const [text, setText] = useState('');
  const left = tasks.filter((t) => !t.done).length;

  function add(e) {
    e.preventDefault();
    if (!text.trim()) return;
    setTasks([...tasks, { id: Date.now(), text: text.trim(), done: false }]);
    console.log('Added task:', text.trim());
    setText('');
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-slate-100 px-4 py-12">
      <div className="mx-auto max-w-lg">
        <div className="flex items-center gap-2 text-brand mb-2"><Sparkles size={18} /> <span className="text-sm font-medium">Demo project</span></div>
        <h1 className="text-4xl font-bold tracking-tight">Task board</h1>
        <p className="text-slate-400 mt-1">{left} task{left === 1 ? '' : 's'} left</p>

        <form onSubmit={add} className="mt-6 flex gap-2">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="What needs doing?"
            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none focus:border-brand" />
          <button className="rounded-xl bg-brand px-4 font-medium hover:opacity-90 flex items-center gap-1"><Plus size={18} />Add</button>
        </form>

        <ul className="mt-6 space-y-2">
          {tasks.map((t) => (
            <li key={t.id} className="group flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-4 py-3">
              <button onClick={() => setTasks(tasks.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))}
                className={'h-6 w-6 rounded-full border flex items-center justify-center ' + (t.done ? 'bg-emerald-500 border-emerald-500' : 'border-white/30')}>
                {t.done && <Check size={14} />}
              </button>
              <span className={'flex-1 ' + (t.done ? 'line-through text-slate-500' : '')}>{t.text}</span>
              <button onClick={() => setTasks(tasks.filter((x) => x.id !== t.id))} className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-400">
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
`,
        'src/useLocalStorage.js': `import { useEffect, useState } from 'react';

export function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem('demo:' + key);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem('demo:' + key, JSON.stringify(value)); } catch {}
  }, [key, value]);
  return [value, setValue];
}
`,
        'README.md': '# React task board\n\nA tiny Vite + React + Tailwind demo for ZipRun.\n\n```\nnpm install\nnpm run dev\n```\n',
      }),
  },
  {
    id: 'static-landing',
    name: 'coffee-landing-page',
    description: 'Plain HTML/CSS/JS landing page',
    files: () =>
      make({
        'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bean There — Coffee Roasters</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <header class="nav">
    <a class="logo" href="/">☕ Bean There</a>
    <nav><a href="#menu">Menu</a><a href="about.html">About</a><a href="#visit" class="btn">Visit us</a></nav>
  </header>
  <section class="hero">
    <h1>Small batch.<br><span>Big flavour.</span></h1>
    <p>Freshly roasted beans, delivered every Friday.</p>
    <button id="order" class="btn big">Order a bag</button>
    <p id="count" class="muted"></p>
  </section>
  <section id="menu" class="grid">
    <article><h3>Espresso</h3><p>Dark, syrupy, chocolate notes.</p><b>$3.20</b></article>
    <article><h3>Flat white</h3><p>Velvety micro-foam over a double shot.</p><b>$4.10</b></article>
    <article><h3>Cold brew</h3><p>Steeped 18 hours. Smooth and bright.</p><b>$4.50</b></article>
  </section>
  <footer id="visit">12 Roast Lane · Open 7am–4pm</footer>
  <script src="js/app.js"></script>
</body>
</html>
`,
        'about.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>About — Bean There</title>
  <link rel="stylesheet" href="/css/style.css">
</head>
<body>
  <header class="nav"><a class="logo" href="index.html">☕ Bean There</a></header>
  <section class="hero"><h1>Our story</h1><p>Two friends, one tiny roaster, too much coffee.</p><a class="btn" href="index.html">← Back home</a></section>
</body>
</html>
`,
        'css/style.css': `:root { --bg: #fbf6f0; --ink: #2b1d14; --accent: #c2611f; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Georgia, 'Times New Roman', serif; background: var(--bg); color: var(--ink); }
.nav { display: flex; justify-content: space-between; align-items: center; padding: 20px 6vw; }
.nav a { color: inherit; text-decoration: none; margin-left: 20px; }
.logo { font-weight: bold; font-size: 1.2rem; margin: 0 !important; }
.btn { background: var(--accent); color: #fff !important; padding: 10px 18px; border-radius: 999px; border: 0; cursor: pointer; font: inherit; }
.btn.big { font-size: 1.1rem; padding: 14px 28px; }
.hero { padding: 12vh 6vw; text-align: center; }
.hero h1 { font-size: clamp(2.4rem, 7vw, 5rem); margin: 0 0 12px; line-height: 1.05; }
.hero h1 span { color: var(--accent); font-style: italic; }
.muted { opacity: .6; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; padding: 0 6vw 10vh; }
.grid article { background: #fff; border-radius: 16px; padding: 24px; box-shadow: 0 8px 30px rgba(43,29,20,.08); }
footer { text-align: center; padding: 40px; background: var(--ink); color: var(--bg); }
@media (max-width: 600px) { .nav nav a:not(.btn) { display: none; } }
`,
        'js/app.js': `let orders = 0;
const button = document.getElementById('order');
const count = document.getElementById('count');

button.addEventListener('click', () => {
  orders += 1;
  count.textContent = orders + (orders === 1 ? ' bag' : ' bags') + ' in your basket';
  console.log('Order clicked', { orders });
  if (orders === 5) console.warn('That is a lot of coffee!');
});

console.info('Bean There site loaded');
`,
      }),
  },
];
