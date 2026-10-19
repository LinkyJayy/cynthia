import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { db, id, now, ensureSetting } from './db.js';

const COOKIE = 'cynthia_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
let secret;

export const DEFAULT_PREFS = {
  chatStyle: 'imessage', // imessage | whatsapp | cynthia
  theme: 'system', // system | light | dark
  enterToSend: true,
};

export async function initAuth() {
  // Use JWT_SECRET when provided; otherwise generate one and keep it in the database
  // so sessions survive restarts and redeploys.
  secret = config.jwtSecret || (await ensureSetting('jwt_secret', () => crypto.randomBytes(48).toString('hex')));
}

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    prefs: { ...DEFAULT_PREFS, ...JSON.parse(u.prefs || '{}') },
    createdAt: u.created_at,
  };
}

function setSession(res, user) {
  const token = jwt.sign({ sub: user.id }, secret, { expiresIn: Math.floor(MAX_AGE_MS / 1000) });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

const validEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

export async function signup(req, res) {
  if (!config.allowSignups) {
    const count = await db.get('SELECT COUNT(*) AS n FROM users');
    if (Number(count.n) > 0) return res.status(403).json({ error: 'Sign-ups are disabled on this server.' });
  }
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 80);
  const password = String(req.body.password || '');
  if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (await db.get('SELECT id FROM users WHERE email = ?', [email])) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const user = {
    id: id(),
    email,
    name,
    password_hash: await bcrypt.hash(password, 12),
    prefs: JSON.stringify(DEFAULT_PREFS),
    hook_token: crypto.randomBytes(24).toString('hex'),
    created_at: now(),
  };
  await db.run(
    'INSERT INTO users (id, email, name, password_hash, prefs, hook_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [user.id, user.email, user.name, user.password_hash, user.prefs, user.hook_token, user.created_at],
  );
  setSession(res, user);
  res.json({ user: publicUser(user) });
}

export async function login(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  setSession(res, user);
  res.json({ user: publicUser(user) });
}

export function logout(_req, res) {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) return res.status(401).json({ error: 'Not signed in.' });
    const { sub } = jwt.verify(token, secret);
    const user = await db.get('SELECT * FROM users WHERE id = ?', [sub]);
    if (!user) return res.status(401).json({ error: 'Not signed in.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Not signed in.' });
  }
}

export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!(await bcrypt.compare(String(currentPassword || ''), req.user.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (String(newPassword || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(String(newPassword), 12), req.user.id]);
  res.json({ ok: true });
}
