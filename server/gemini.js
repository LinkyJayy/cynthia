// Minimal Gemini REST client (streaming + one-shot).
import { config } from './config.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

function headers() {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured on the server.');
  return { 'content-type': 'application/json', 'x-goog-api-key': config.geminiApiKey };
}

async function raise(res) {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    msg = body.error?.message || msg;
  } catch {}
  const err = new Error(`Gemini API error: ${msg}`);
  err.status = res.status;
  throw err;
}

export async function generate(model, body, signal) {
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await raise(res);
  return res.json();
}

/** Yields each streamed GenerateContentResponse chunk. */
export async function* stream(model, body, signal) {
  const res = await fetch(`${BASE}/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await raise(res);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (data) yield JSON.parse(data);
    }
  }
}
