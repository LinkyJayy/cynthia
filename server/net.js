// Outbound HTTP for the agent, with protection against reaching private/internal networks (SSRF).
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are allowed.');
  if (config.allowPrivateNetwork) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('Access to internal hosts is blocked.');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Access to private network addresses is blocked.');
  return url;
}

/** fetch() that refuses private addresses, follows redirects safely and enforces a timeout. */
export async function safeFetch(raw, init = {}, { timeoutMs = 20000, maxRedirects = 5 } = {}) {
  let url = await assertPublicUrl(raw);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(url, { ...init, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).toString());
      if (res.status === 303) init = { ...init, method: 'GET', body: undefined };
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects.');
}

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}
