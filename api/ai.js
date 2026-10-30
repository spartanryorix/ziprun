/*
 * ZipRun AI proxy — Vercel Function.
 *
 * Streams chat completions from an OpenAI-compatible provider serving NVIDIA Nemotron models.
 * The API key lives only in server-side environment variables, never in the browser bundle.
 *
 *   NEBIUS_API_KEY   → Nebius Token Factory (https://api.tokenfactory.eu-north1.nebius.com/v1)
 *   NVIDIA_API_KEY   → NVIDIA API catalog   (https://integrate.api.nvidia.com/v1)
 *   AI_API_KEY + AI_BASE_URL → any other OpenAI-compatible endpoint
 *   AI_MODEL_CODE / AI_MODEL_FAST → optional model overrides
 *
 *   AI_ACCESS_CODE   → optional: when set, the server key is only used by people who enter this code;
 *                      everyone else must bring their own key (protects your credit).
 *
 * Visitors may also send their own key in the `x-ai-key` header (with `x-ai-provider`).
 * The model is only ever called when a person clicks an AI button — never on page load.
 */

const PROVIDERS = {
  nebius: {
    label: 'Nebius Token Factory',
    baseUrl: 'https://api.tokenfactory.eu-north1.nebius.com/v1',
    models: { code: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', fast: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B' },
  },
  nvidia: {
    label: 'NVIDIA API',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: { code: 'nvidia/nemotron-3-ultra-550b-a55b', fast: 'nvidia/nvidia-nemotron-nano-9b-v2' },
  },
};

const MAX_BODY = 600_000; // characters of prompt we are willing to forward
const RATE = { windowMs: 10 * 60 * 1000, max: 20 };
const MAX_TOKENS = { code: 12000, fast: 2500 };
const hits = new Map();

function env(name) {
  return (typeof process !== 'undefined' && process.env && process.env[name]) || '';
}

function resolveProvider(request) {
  const userKey = request.headers.get('x-ai-key');
  if (userKey) {
    const id = request.headers.get('x-ai-provider') === 'nebius' ? 'nebius' : 'nvidia';
    return { id, ...PROVIDERS[id], key: userKey, byo: true };
  }
  let id = null;
  let key = '';
  if (env('NEBIUS_API_KEY')) { id = 'nebius'; key = env('NEBIUS_API_KEY'); }
  else if (env('NVIDIA_API_KEY')) { id = 'nvidia'; key = env('NVIDIA_API_KEY'); }
  else if (env('AI_API_KEY')) { id = env('AI_BASE_URL').includes('nebius') ? 'nebius' : 'nvidia'; key = env('AI_API_KEY'); }
  if (!id) return null;
  const base = PROVIDERS[id];
  return {
    id,
    label: base.label,
    key,
    byo: false,
    baseUrl: (env('AI_BASE_URL') || base.baseUrl).replace(/\/+$/, ''),
    models: { code: env('AI_MODEL_CODE') || base.models.code, fast: env('AI_MODEL_FAST') || base.models.fast },
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function rateLimited(request) {
  const ip = (request.headers.get('x-forwarded-for') || 'local').split(',')[0].trim();
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE.max;
}

/** True when an access code is configured and this request did not supply it (and brings no own key). */
function locked(request, p) {
  const code = env('AI_ACCESS_CODE');
  return !!code && !p.byo && request.headers.get('x-ai-access') !== code;
}

export async function GET(request) {
  const p = resolveProvider(request);
  if (!p) return json({ configured: false });
  return json({ configured: true, locked: locked(request, p), provider: p.id, label: p.label, models: p.models, byo: p.byo });
}

export async function POST(request) {
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: 'Cross-origin requests are not allowed.' }, 403);

  const p = resolveProvider(request);
  if (!p) {
    return json({ error: 'No AI key is configured. Add NEBIUS_API_KEY or NVIDIA_API_KEY in your Vercel project settings, or enter your own key in the AI panel.' }, 503);
  }
  if (locked(request, p)) return json({ error: 'AI is locked on this site. Enter the access code (or your own API key) in the AI panel settings.' }, 401);
  if (!p.byo && rateLimited(request)) return json({ error: 'Too many AI requests from your network. Wait a few minutes, or add your own API key in the AI panel.' }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const messages = Array.isArray(body.messages) ? body.messages.filter((m) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role)) : [];
  if (!messages.length) return json({ error: 'No messages.' }, 400);
  if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_BODY) return json({ error: 'The request is too large. Try a smaller project or a more specific question.' }, 413);

  const role = body.role === 'fast' ? 'fast' : 'code';
  const thinking = body.thinking !== false && role === 'code';
  const candidates = [...new Set([p.models[role], p.models.code])];

  // Try the routed model first; fall back to the main model and to "no thinking" if the provider rejects a parameter.
  // Variants drop optional parameters (reasoning, usage reporting) if a provider rejects them.
  const variants = thinking
    ? [{ think: true, usage: true }, { think: false, usage: true }, { think: false, usage: false }]
    : [{ think: false, usage: true }, { think: false, usage: false }];
  let lastError = '';
  for (const model of candidates) {
    for (const v of variants) {
      const payload = {
        model,
        messages,
        temperature: role === 'code' ? 0.3 : 0.6,
        top_p: 0.95,
        max_tokens: MAX_TOKENS[role],
        stream: true,
      };
      if (v.think) payload.chat_template_kwargs = { enable_thinking: true };
      if (v.usage) payload.stream_options = { include_usage: true };
      let upstream;
      try {
        upstream = await fetch(p.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key, Accept: 'text/event-stream' },
          body: JSON.stringify(payload),
          signal: request.signal,
        });
      } catch (err) {
        lastError = 'Could not reach ' + p.label + ': ' + (err && err.message);
        continue;
      }
      if (upstream.ok && upstream.body) {
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
            'X-ZipRun-Model': model,
            'X-ZipRun-Provider': p.label,
          },
        });
      }
      const text = await upstream.text().catch(() => '');
      lastError = `${p.label} returned ${upstream.status}: ${text.slice(0, 400)}`;
      if (upstream.status === 401 || upstream.status === 403) return json({ error: `${p.label} rejected the API key (HTTP ${upstream.status}). Check the key in your settings.` }, 401);
      if (upstream.status === 429) return json({ error: `${p.label} rate limit reached. Try again in a minute.` }, 429);
      if (upstream.status >= 500) break; // provider trouble — try the next model
    }
  }
  return json({ error: lastError || 'The AI request failed.' }, 502);
}
