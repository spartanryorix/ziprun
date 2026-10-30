import { FileMap, isText, toText } from './files';
import type { Analysis } from './analyze';

export interface LogLine {
  level: string;
  text: string;
}

/** Build a ready-to-paste prompt for ChatGPT / Claude / Codex describing what is wrong. */
export function buildFixPrompt(files: FileMap, analysis: Analysis, logs: LogLine[], mode: string): string {
  const errors = logs.filter((l) => l.level === 'error' || l.level === 'warn').slice(-25);
  const issues = analysis.diagnostics.filter((d) => d.severity !== 'info');
  const tree = [...files.keys()].slice(0, 200).join('\n');
  const mentioned = new Set<string>();
  for (const d of issues) if (d.file) mentioned.add(d.file);
  for (const l of errors) {
    const m = l.text.match(/\/?([\w./-]+\.(?:jsx?|tsx?|css|html))/);
    if (m && files.has(m[1].replace(/^\//, ''))) mentioned.add(m[1].replace(/^\//, ''));
  }

  let out = `I have a ${analysis.summary} (${analysis.stack.join(', ') || 'unknown stack'}). `;
  out += `When I run it (${mode} mode in ZipRun, a browser-based runner), I see the problems below. Please explain the cause of each and give me the corrected code (full files for anything you change).\n\n`;
  if (issues.length) {
    out += `## Static analysis\n`;
    for (const d of issues) out += `- [${d.severity}] ${d.title}${d.file ? ` (${d.file}${d.line ? ':' + d.line : ''})` : ''}${d.detail ? ' — ' + d.detail : ''}\n`;
    out += '\n';
  }
  if (errors.length) {
    out += `## Runtime console\n\`\`\`\n${errors.map((l) => `[${l.level}] ${l.text}`).join('\n').slice(0, 6000)}\n\`\`\`\n\n`;
  }
  if (!issues.length && !errors.length) out += `No errors were detected. Please review the project and suggest the most valuable improvements to UI/UX, accessibility, performance and code quality.\n\n`;
  out += `## File tree\n\`\`\`\n${tree}\n\`\`\`\n\n`;
  if (analysis.pkg) out += `## package.json\n\`\`\`json\n${toText(files.get('package.json')!).slice(0, 3000)}\n\`\`\`\n\n`;
  let budget = 24000;
  for (const f of mentioned) {
    const d = files.get(f);
    if (!d || !isText(f, d) || f === 'package.json') continue;
    const body = toText(d);
    if (body.length > budget) continue;
    budget -= body.length;
    out += `## ${f}\n\`\`\`\n${body}\n\`\`\`\n\n`;
  }
  return out.trim() + '\n';
}
