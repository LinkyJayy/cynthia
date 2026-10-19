// Cynthia's own web browser: one headless Chromium page per user, driven by the agent.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { assertPublicUrl } from './net.js';

const IDLE_MS = 10 * 60 * 1000;
const sessions = new Map(); // userId -> { context, page, lastUsed }
let browserPromise = null;
let chromium = null;

function findChromium() {
  const candidates = [config.browserPath, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  // Also look in a Playwright browsers folder if one is installed.
  const pwDir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pwDir && fs.existsSync(pwDir)) {
    for (const d of fs.readdirSync(pwDir).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      candidates.push(`${pwDir}/${d}/chrome-linux64/chrome`, `${pwDir}/${d}/chrome-linux/chrome`);
    }
  }
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  try {
    return execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export async function browserAvailable() {
  try {
    chromium ??= (await import('playwright-core')).chromium;
    return Boolean(findChromium());
  } catch {
    return false;
  }
}

// Honour an outbound HTTPS proxy if the host requires one.
function proxyFromEnv() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!raw) return undefined;
  const u = new URL(raw);
  return {
    server: `${u.protocol}//${u.host}`,
    username: decodeURIComponent(u.username) || undefined,
    password: decodeURIComponent(u.password) || undefined,
  };
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      chromium ??= (await import('playwright-core')).chromium;
      const executablePath = findChromium();
      if (!executablePath) throw new Error('No Chromium found. Set CHROMIUM_PATH or use the provided Dockerfile.');
      const b = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'], proxy: proxyFromEnv() });
      b.on('disconnected', () => (browserPromise = null));
      return b;
    })().catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

const hostCheckCache = new Map();
async function allowed(url) {
  if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return true;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  if (!hostCheckCache.has(host)) {
    hostCheckCache.set(host, assertPublicUrl(url).then(() => true, () => false));
  }
  return hostCheckCache.get(host);
}

async function getSession(userId) {
  let s = sessions.get(userId);
  if (s && !s.page.isClosed()) {
    s.lastUsed = Date.now();
    return s;
  }
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Cynthia/1.0',
  });
  await context.route('**/*', async (route) => ((await allowed(route.request().url())) ? route.continue() : route.abort()));
  const page = await context.newPage();
  s = { context, page, lastUsed: Date.now() };
  sessions.set(userId, s);
  return s;
}

setInterval(() => {
  for (const [userId, s] of sessions) {
    if (Date.now() - s.lastUsed > IDLE_MS) {
      s.context.close().catch(() => {});
      sessions.delete(userId);
    }
  }
}, 60 * 1000).unref();

// Tags visible interactive elements with numbers so the model can refer to them.
const SNAPSHOT_JS = () => {
  const els = [...document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link], [contenteditable=true]')];
  const out = [];
  let n = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight * 3) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    n += 1;
    el.setAttribute('data-cy-ref', String(n));
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    out.push(`[${n}] ${tag}${type ? `(${type})` : ''} ${JSON.stringify(label)}${tag === 'a' ? ` -> ${el.getAttribute('href').slice(0, 100)}` : ''}`);
    if (n >= 80) break;
  }
  return { elements: out, text: document.body ? document.body.innerText : '' };
};

async function snapshot(page) {
  const { elements, text } = await page.evaluate(SNAPSHOT_JS);
  const shot = await page.screenshot({ type: 'jpeg', quality: 60 });
  return {
    url: page.url(),
    title: await page.title(),
    text: text.replace(/\n{3,}/g, '\n\n').slice(0, 6000),
    elements: elements.join('\n'),
    screenshot: shot,
  };
}

function locator(page, { ref, selector, text }) {
  if (ref) return page.locator(`[data-cy-ref="${Number(ref)}"]`).first();
  if (selector) return page.locator(selector).first();
  if (text) return page.getByText(text, { exact: false }).first();
  throw new Error('Provide ref, selector or text to choose an element.');
}

export async function runBrowser(userId, args) {
  const { action } = args;
  if (action === 'close') {
    const s = sessions.get(userId);
    if (s) await s.context.close().catch(() => {});
    sessions.delete(userId);
    return { result: { closed: true } };
  }
  const { page } = await getSession(userId);
  const wait = () => page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  switch (action) {
    case 'open': {
      if (!args.url) throw new Error('url is required');
      const url = /^https?:\/\//i.test(args.url) ? args.url : `https://${args.url}`;
      await assertPublicUrl(url);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(800);
      break;
    }
    case 'click':
      await locator(page, args).click({ timeout: 10000 });
      await wait();
      await page.waitForTimeout(800);
      break;
    case 'type':
      await locator(page, args).fill(String(args.value ?? ''), { timeout: 10000 });
      if (args.submit) {
        await page.keyboard.press('Enter');
        await wait();
        await page.waitForTimeout(1000);
      }
      break;
    case 'press':
      await page.keyboard.press(args.key || 'Enter');
      await wait();
      break;
    case 'scroll':
      await page.mouse.wheel(0, args.direction === 'up' ? -700 : 700);
      await page.waitForTimeout(400);
      break;
    case 'back':
      await page.goBack({ timeout: 15000 }).catch(() => {});
      break;
    case 'snapshot':
      break;
    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
  const snap = await snapshot(page);
  return {
    result: { url: snap.url, title: snap.title, interactive_elements: snap.elements, page_text: snap.text },
    image: { mimeType: 'image/jpeg', data: snap.screenshot },
  };
}
