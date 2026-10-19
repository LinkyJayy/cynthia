import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import { config } from './config.js';
import { initDb } from './db.js';
import { initAuth } from './auth.js';
import { initPush } from './push.js';
import { startScheduler } from './scheduler.js';
import api from './routes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.join(root, 'node_modules');

await initDb();
await initAuth();
await initPush();

if (!config.geminiApiKey) console.warn('[cynthia] GEMINI_API_KEY is not set — chats will fail until it is configured.');

const app = express();
app.set('trust proxy', 1); // Railway (and most PaaS) terminate TLS at a proxy
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression({ filter: (req, res) => !req.path.endsWith('/messages') && compression.filter(req, res) }));
app.use(cookieParser());
app.use(express.json({ limit: '40mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.use('/api', api);

// Front-end libraries served straight from node_modules (no build step needed).
const vendor = {
  '/vendor/marked.js': 'marked/lib/marked.esm.js',
  '/vendor/purify.js': 'dompurify/dist/purify.es.mjs',
};
for (const [route, file] of Object.entries(vendor)) {
  app.get(route, (_req, res) => res.sendFile(path.join(modules, file), { maxAge: '7d' }));
}
app.use('/vendor/three', express.static(path.join(modules, 'three'), { maxAge: '7d' }));

app.get('/sw.js', (_req, res) => {
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('service-worker-allowed', '/');
  res.sendFile(path.join(root, 'public', 'sw.js'));
});
app.use(express.static(path.join(root, 'public'), { maxAge: config.isProd ? '1h' : 0, index: false }));
app.get(/^\/(?!api\/|vendor\/).*/, (_req, res) => {
  res.setHeader('cache-control', 'no-cache');
  res.sendFile(path.join(root, 'public', 'index.html'));
});

const server = app.listen(config.port, () => {
  console.log(`[cynthia] listening on http://localhost:${config.port}`);
  startScheduler();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[cynthia] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
