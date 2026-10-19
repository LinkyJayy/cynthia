import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { db, id, now } from './db.js';
import { config } from './config.js';
import { signup, login, logout, requireAuth, publicUser, changePassword, DEFAULT_PREFS } from './auth.js';
import { runTurn, createConversation } from './agent.js';
import { listFiles, readFile, deleteFile, saveFile } from './workspace.js';
import { getPublicKey, subscribe, unsubscribe, notify } from './push.js';
import { browserAvailable } from './browser.js';
import { assertPublicUrl } from './net.js';

const api = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const active = new Map(); // conversationId -> AbortController

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const hookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

// ------------------------------------------------------------------ Public
api.get('/config', wrap(async (_req, res) => {
  res.json({
    pushPublicKey: getPublicKey(),
    model: config.geminiModel,
    browser: await browserAvailable(),
    geminiConfigured: Boolean(config.geminiApiKey),
    allowSignups: config.allowSignups,
  });
}));

api.post('/auth/signup', authLimiter, wrap(signup));
api.post('/auth/login', authLimiter, wrap(login));
api.post('/auth/logout', logout);

// Incoming webhook: lets other services (Shortcuts, Zapier, IFTTT, n8n, Home Assistant...) talk to Cynthia.
api.post('/hooks/:token', hookLimiter, wrap(async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE hook_token = ?', [req.params.token]);
  if (!user) return res.status(404).json({ error: 'Unknown hook.' });
  const text = String(req.body?.message ?? req.body?.text ?? '').slice(0, 20000);
  if (!text) return res.status(400).json({ error: 'Send JSON like {"message": "..."}.' });
  let conversationId = req.body.conversation_id;
  if (!conversationId || !(await db.get('SELECT id FROM conversations WHERE id = ? AND user_id = ?', [conversationId, user.id]))) {
    conversationId = (await createConversation(user.id, String(req.body.title || '🔗 Webhook').slice(0, 60))).id;
  }
  const msg = await runTurn({
    user,
    conversationId,
    text,
    userMeta: { via: 'webhook' },
    extraSystem: 'This message arrived through the incoming webhook from another app or automation, not typed in the chat UI. Reply concisely; your reply is returned to the calling service.',
  });
  if (req.body.notify) await notify(user.id, { title: 'Cynthia', body: msg.content, url: `/?c=${conversationId}` });
  res.json({ reply: msg.content, conversation_id: conversationId, attachments: msg.meta.attachments });
}));

// ------------------------------------------------------------------ Authenticated
api.use(wrap(requireAuth));

api.get('/auth/me', (req, res) => res.json({ user: publicUser(req.user) }));

api.patch('/me', wrap(async (req, res) => {
  const { name, prefs } = req.body;
  if (typeof name === 'string' && name.trim()) {
    await db.run('UPDATE users SET name = ? WHERE id = ?', [name.trim().slice(0, 80), req.user.id]);
  }
  if (prefs && typeof prefs === 'object') {
    const merged = { ...DEFAULT_PREFS, ...JSON.parse(req.user.prefs || '{}') };
    for (const k of ['chatStyle', 'theme', 'enterToSend', 'timezone', 'wallpaper', 'fontSize']) if (k in prefs) merged[k] = prefs[k];
    await db.run('UPDATE users SET prefs = ? WHERE id = ?', [JSON.stringify(merged), req.user.id]);
  }
  res.json({ user: publicUser(await db.get('SELECT * FROM users WHERE id = ?', [req.user.id])) });
}));

api.post('/me/password', wrap(changePassword));

api.delete('/me', wrap(async (req, res) => {
  if (!(await bcrypt.compare(String(req.body.password || ''), req.user.password_hash))) {
    return res.status(400).json({ error: 'Password is incorrect.' });
  }
  for (const t of ['messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)', 'conversations WHERE user_id = ?',
    'files WHERE user_id = ?', 'memories WHERE user_id = ?', 'tasks WHERE user_id = ?', 'integrations WHERE user_id = ?',
    'push_subscriptions WHERE user_id = ?', 'users WHERE id = ?']) {
    await db.run(`DELETE FROM ${t}`, [req.user.id]);
  }
  logout(req, res);
}));

api.get('/me/hook', (req, res) => {
  res.json({ url: `${req.protocol}://${req.get('host')}/api/hooks/${req.user.hook_token}` });
});
api.post('/me/hook/rotate', wrap(async (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  await db.run('UPDATE users SET hook_token = ? WHERE id = ?', [token, req.user.id]);
  res.json({ url: `${req.protocol}://${req.get('host')}/api/hooks/${token}` });
}));

// ---- Conversations
const ownConv = async (req) => db.get('SELECT * FROM conversations WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);

api.get('/conversations', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT c.*, (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message
     FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC LIMIT 300`,
    [req.user.id],
  );
  res.json({ conversations: rows.map((c) => ({ ...c, running: active.has(c.id) })) });
}));

api.post('/conversations', wrap(async (req, res) => {
  res.json({ conversation: await createConversation(req.user.id, String(req.body?.title || 'New chat').slice(0, 80)) });
}));

api.patch('/conversations/:id', wrap(async (req, res) => {
  if (!(await ownConv(req))) return res.status(404).json({ error: 'Not found' });
  await db.run('UPDATE conversations SET title = ? WHERE id = ?', [String(req.body.title || 'Chat').slice(0, 80), req.params.id]);
  res.json({ ok: true });
}));

api.delete('/conversations/:id', wrap(async (req, res) => {
  if (!(await ownConv(req))) return res.status(404).json({ error: 'Not found' });
  active.get(req.params.id)?.abort();
  await db.run('DELETE FROM messages WHERE conversation_id = ?', [req.params.id]);
  await db.run('DELETE FROM conversations WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

api.get('/conversations/:id/messages', wrap(async (req, res) => {
  const conv = await ownConv(req);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const rows = await db.all(
    'SELECT id, role, content, meta, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at',
    [req.params.id],
  );
  res.json({
    conversation: { ...conv, running: active.has(conv.id) },
    messages: rows.map((m) => ({ ...m, meta: JSON.parse(m.meta || '{}') })),
  });
}));

api.post('/conversations/:id/stop', wrap(async (req, res) => {
  if (!(await ownConv(req))) return res.status(404).json({ error: 'Not found' });
  active.get(req.params.id)?.abort();
  res.json({ ok: true });
}));

// Streams the reply as Server-Sent Events. The turn keeps running if the client disconnects,
// so Cynthia finishes her work and the result is there when the user comes back.
api.post('/conversations/:id/messages', wrap(async (req, res) => {
  if (!(await ownConv(req))) return res.status(404).json({ error: 'Not found' });
  if (active.has(req.params.id)) return res.status(409).json({ error: 'Cynthia is still working on the previous message.' });
  const text = String(req.body.text || '').slice(0, 100000);
  const files = (Array.isArray(req.body.files) ? req.body.files : []).slice(0, 10).filter(
    (f) => f && typeof f.data === 'string' && typeof f.mimeType === 'string',
  );
  if (!text.trim() && !files.length) return res.status(400).json({ error: 'Message is empty.' });

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let open = true;
  res.on('close', () => (open = false));
  const emit = (e) => {
    if (open) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const ping = setInterval(() => open && res.write(': ping\n\n'), 15000);
  const controller = new AbortController();
  active.set(req.params.id, controller);
  try {
    await runTurn({ user: req.user, conversationId: req.params.id, text, files, emit, signal: controller.signal });
  } catch (e) {
    emit({ type: 'error', error: e.message });
  } finally {
    clearInterval(ping);
    active.delete(req.params.id);
    if (open) res.end();
  }
}));

// ---- Files ("Computer")
api.get('/files', wrap(async (req, res) => res.json({ files: await listFiles(req.user.id) })));

api.get('/files/raw', wrap(async (req, res) => {
  const f = await readFile(req.user.id, req.query.path);
  if (!f) return res.status(404).json({ error: 'Not found' });
  res.setHeader('content-type', f.mime);
  // User/AI-generated files must never run scripts on our origin.
  res.setHeader('content-security-policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', 'private, max-age=60');
  const name = f.path.split('/').pop();
  res.setHeader('content-disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name.replace(/"/g, '')}"`);
  res.send(Buffer.from(f.data));
}));

api.post('/files', wrap(async (req, res) => {
  const { path, data, mimeType } = req.body;
  res.json({ file: await saveFile(req.user.id, path, Buffer.from(String(data || ''), 'base64'), mimeType) });
}));

api.delete('/files', wrap(async (req, res) => res.json({ deleted: await deleteFile(req.user.id, req.query.path) })));

// ---- Memories
api.get('/memories', wrap(async (req, res) => {
  res.json({ memories: await db.all('SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]) });
}));
api.post('/memories', wrap(async (req, res) => {
  const content = String(req.body.content || '').trim().slice(0, 1000);
  if (!content) return res.status(400).json({ error: 'Empty memory.' });
  await db.run('INSERT INTO memories (id, user_id, content, created_at) VALUES (?, ?, ?, ?)', [id(), req.user.id, content, now()]);
  res.json({ ok: true });
}));
api.delete('/memories/:id', wrap(async (req, res) => {
  await db.run('DELETE FROM memories WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ---- Scheduled tasks
api.get('/tasks', wrap(async (req, res) => {
  res.json({ tasks: await db.all('SELECT * FROM tasks WHERE user_id = ? ORDER BY next_run_at', [req.user.id]) });
}));
api.patch('/tasks/:id', wrap(async (req, res) => {
  const t = await db.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if ('enabled' in req.body) {
    const enabled = req.body.enabled ? 1 : 0;
    const next = enabled && t.next_run_at < now() ? now() + (t.every_minutes || 1) * 60000 : t.next_run_at;
    await db.run('UPDATE tasks SET enabled = ?, next_run_at = ? WHERE id = ?', [enabled, next, t.id]);
  }
  res.json({ ok: true });
}));
api.post('/tasks/:id/run', wrap(async (req, res) => {
  await db.run('UPDATE tasks SET next_run_at = ?, enabled = 1 WHERE id = ? AND user_id = ?', [now(), req.params.id, req.user.id]);
  res.json({ ok: true });
}));
api.delete('/tasks/:id', wrap(async (req, res) => {
  await db.run('DELETE FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ---- Connections (outgoing integrations)
const KINDS = ['discord', 'slack', 'webhook'];
api.get('/integrations', wrap(async (req, res) => {
  const rows = await db.all('SELECT * FROM integrations WHERE user_id = ? ORDER BY name', [req.user.id]);
  res.json({
    integrations: rows.map((r) => ({
      id: r.id, name: r.name, kind: r.kind, description: r.description,
      url: r.url.replace(/^(https?:\/\/[^/]+\/).{6,}$/, '$1…'), // don't echo secrets embedded in webhook URLs
      headerNames: Object.keys(JSON.parse(r.headers || '{}')),
    })),
  });
}));
api.post('/integrations', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const kind = KINDS.includes(req.body.kind) ? req.body.kind : 'webhook';
  const url = String(req.body.url || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  try {
    await assertPublicUrl(url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  let headers = {};
  if (req.body.headers) {
    try {
      headers = typeof req.body.headers === 'string' ? JSON.parse(req.body.headers) : req.body.headers;
    } catch {
      return res.status(400).json({ error: 'Headers must be a JSON object.' });
    }
  }
  if (await db.get('SELECT id FROM integrations WHERE user_id = ? AND LOWER(name) = LOWER(?)', [req.user.id, name])) {
    return res.status(409).json({ error: 'A connection with that name already exists.' });
  }
  await db.run(
    'INSERT INTO integrations (id, user_id, name, kind, url, headers, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id(), req.user.id, name, kind, url, JSON.stringify(headers), String(req.body.description || '').slice(0, 300), now()],
  );
  res.json({ ok: true });
}));
api.delete('/integrations/:id', wrap(async (req, res) => {
  await db.run('DELETE FROM integrations WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ---- Push
api.post('/push/subscribe', wrap(async (req, res) => {
  await subscribe(req.user.id, req.body.subscription);
  res.json({ ok: true });
}));
api.post('/push/unsubscribe', wrap(async (req, res) => {
  await unsubscribe(String(req.body.endpoint || ''));
  res.json({ ok: true });
}));
api.post('/push/test', wrap(async (req, res) => {
  const sent = await notify(req.user.id, { title: 'Cynthia', body: 'Notifications are working! 🐰', url: '/' });
  res.json({ sent });
}));

api.use((err, _req, res, _next) => {
  console.error('[api]', err);
  if (res.headersSent) return res.end();
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status < 500 ? err.message : 'Something went wrong on the server.' });
});

export default api;
