# ZipRun

**Drop a zip. Watch it run. Let AI fix it.** Upload a project exported from ChatGPT, Claude, Codex or Cursor and see it running in your browser. No VS Code, no terminal, no localhost. When it breaks, the **ZipRun Doctor** agent, powered by **NVIDIA Nemotron**, fixes it for you.

## ZipRun Doctor: the AI agent

- **Auto-fix loop:** Nemotron reads the detected problems, console errors, failed requests and the relevant files, then writes complete file edits. ZipRun applies them, re-runs the app, collects the new errors, and repeats (up to 3 passes) until the app runs cleanly. The health score is shown before and after.
- **Chat to change:** say "add dark mode" or "make it mobile friendly" and get reviewable diffs to apply one by one or all at once.
- **UI/UX review:** captures the rendered DOM of the live preview (layout, sizes, colours, accessibility gaps) and asks Nemotron for a scored design review with code changes.
- **Explain:** a plain-English tour of the project for non-developers.
- **Model routing:** on Nebius both roles default to **NVIDIA Nemotron 3 Nano 30B A3B**, which is fast and inexpensive. Code changes use reasoning (shown in a collapsible "Reasoning" section), and explanations use shorter answers. Override with `AI_MODEL_CODE` / `AI_MODEL_FAST`.
- **Credit protection:** the model is only called when someone clicks an AI button, never on page load. There is an optional access code, a per-visitor rate limit (20 requests per 10 minutes), output caps, and a token count shown on every answer.
- **Safe by design:** every change is shown as a diff, and you can undo all AI changes with one click. The API key stays on the server.

## How we use NVIDIA Nemotron and Nebius Token Factory

- **NVIDIA Nemotron 3 Nano 30B A3B** powers the ZipRun Doctor agent. It reads the detected errors, console output and failed requests, then writes complete file edits. The app re-runs and the loop repeats up to 3 times.
- **Nebius Token Factory** is the default inference provider. It serves Nemotron through an OpenAI-compatible API, and its fast, inexpensive responses are what make the multi-pass fix loop practical, since each project can need several model calls.
- Two model roles: code changes use Nemotron with reasoning, and explanations use shorter, faster answers.
- The API key stays on the server in a Vercel serverless function (`api/ai.js`).
- Other Nebius services: none, only Token Factory.

### Configure the AI (Vercel → Settings → Environment Variables)

| Variable | Use |
|---|---|
| `NEBIUS_API_KEY` | Nebius Token Factory (`https://api.tokenfactory.eu-north1.nebius.com/v1`, default model `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`). Takes priority if set. |
| `AI_ACCESS_CODE` | Optional. When set, only people who enter this code can use your key; everyone else needs their own key. |
| `NVIDIA_API_KEY` | NVIDIA API catalog (`https://integrate.api.nvidia.com/v1`) |
| `AI_MODEL_CODE` / `AI_MODEL_FAST` | Optional model ID overrides |
| `AI_BASE_URL` + `AI_API_KEY` | Any other OpenAI-compatible endpoint |

Visitors can also paste their own key in the AI panel. It is stored only in their browser and sent only to ZipRun's own `/api/ai` function.

## Features

- **Three run modes**, picked automatically:
  - **Static**: serves HTML/CSS/JS exactly like a local web server, including root paths (`/css/app.css`), multi-page sites and SPAs.
  - **Instant**: compiles React / TypeScript / JSX in the browser and loads npm packages from [esm.sh](https://esm.sh), with no `npm install`. Handles Vite and Create React App layouts, `@/` aliases, CSS imports, Tailwind and single-component exports with no `package.json`.
  - **Node**: runs the real `npm install && npm run dev` inside an in-browser Node.js ([WebContainers](https://webcontainers.io)) with an interactive terminal. Use it for Next.js, Vue, Svelte, Angular, Astro and Express. Needs Chrome, Edge or Firefox.
- **DevTools**: a console that captures logs and errors and can run JS inside the preview, a network log, and a problems list.
- **Health check**: flags missing files, broken imports, filename case mismatches that break on Linux hosts, hard-coded API keys, missing env vars, calls to `localhost` backends, missing viewport tags and more, and scores the project out of 100.
- **Live editing**: a CodeMirror editor with live reload. CSS changes apply without a reload.
- **Device preview**: phone, tablet, laptop and desktop frames, with rotation and fullscreen.
- **Fix with AI**: builds one prompt with the errors and the relevant files, ready to paste into ChatGPT or Claude.
- **Recent projects** are kept in the browser (IndexedDB), and you can **download** the edited project as a zip.

Uploaded files never leave the browser.

## Run locally

```bash
npm install
NVIDIA_API_KEY=... npm run dev   # or NEBIUS_API_KEY=...
```

## Deploy to Vercel

The repo includes a `vercel.json` (Vite preset plus the `Cross-Origin-Embedder-Policy` / `Cross-Origin-Opener-Policy` headers that Node mode needs).

- **From GitHub:** push this folder to a repo, open https://vercel.com/new, import it, and click **Deploy**.
- **From your machine:** `npx vercel --prod`

## How it works

- `public/sw.js`: a service worker answers every request from the preview iframe out of Cache Storage, so the project behaves as if it were served from `localhost`.
- `public/__ziprun__/bridge.js`: injected into previews. It forwards console output, errors, navigation and failed requests to the UI.
- `src/lib/analyze.ts`: detects the stack and runs the diagnostics.
- `src/lib/quick.ts`: the Instant engine (sucrase + es-module-lexer + esm.sh).
- `src/lib/engines.ts`: the Static and Node (WebContainers) engines.
- `api/ai.js`: a Vercel Function that streams Nemotron completions. It handles provider selection, model fallback and rate limiting, and keeps the key on the server.
- `src/lib/ai.ts` and `src/components/AIPanel.tsx`: context building, edit parsing, diffs and the agent loop.

> WebContainers are free for personal, open-source and prototype use. Commercial production use needs a [StackBlitz license](https://webcontainers.io/enterprise).
