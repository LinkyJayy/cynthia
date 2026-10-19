// Each user's persistent "computer" storage. Files live in the database so they survive redeploys.
import { db, id, now } from './db.js';

const MAX_FILE = 15 * 1024 * 1024;

const MIME = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html',
  css: 'text/css', js: 'text/javascript', py: 'text/x-python', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', stl: 'model/stl', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  obj: 'model/obj', yaml: 'text/yaml', yml: 'text/yaml', ics: 'text/calendar',
};

export function normalizePath(p) {
  const clean = String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
  if (!clean) throw new Error('A file path is required.');
  if (clean.length > 300) throw new Error('Path too long.');
  return clean;
}

export function mimeFor(path, fallback = 'application/octet-stream') {
  if (path.endsWith('.model3d.json')) return 'application/vnd.cynthia.model3d+json';
  const ext = path.split('.').pop().toLowerCase();
  return MIME[ext] || fallback;
}

export const isText = (mime) => /^text\/|json|xml|javascript|yaml|svg|calendar/.test(mime);

export async function saveFile(userId, path, data, mime) {
  path = normalizePath(path);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  if (buf.length > MAX_FILE) throw new Error('File is too large (15 MB max).');
  mime = mime || mimeFor(path);
  const t = now();
  const existing = await db.get('SELECT id FROM files WHERE user_id = ? AND path = ?', [userId, path]);
  if (existing) {
    await db.run('UPDATE files SET data = ?, mime = ?, size = ?, updated_at = ? WHERE id = ?', [buf, mime, buf.length, t, existing.id]);
    return { id: existing.id, path, mime, size: buf.length };
  }
  const fid = id();
  await db.run(
    'INSERT INTO files (id, user_id, path, mime, size, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [fid, userId, path, mime, buf.length, buf, t, t],
  );
  return { id: fid, path, mime, size: buf.length };
}

export async function readFile(userId, path) {
  return db.get('SELECT * FROM files WHERE user_id = ? AND path = ?', [userId, normalizePath(path)]);
}

export async function listFiles(userId, prefix = '') {
  const rows = await db.all('SELECT id, path, mime, size, updated_at FROM files WHERE user_id = ? ORDER BY path', [userId]);
  const p = prefix ? normalizePath(prefix) + '/' : '';
  return rows.filter((r) => r.path.startsWith(p));
}

export async function deleteFile(userId, path) {
  const r = await db.run('DELETE FROM files WHERE user_id = ? AND path = ?', [userId, normalizePath(path)]);
  return r.changes > 0;
}

/** Keeps only the newest `keep` files under a folder (used for browser screenshots). */
export async function pruneFolder(userId, folder, keep) {
  const rows = await db.all('SELECT id, path FROM files WHERE user_id = ? ORDER BY updated_at DESC', [userId]);
  const old = rows.filter((r) => r.path.startsWith(folder + '/')).slice(keep);
  for (const r of old) await db.run('DELETE FROM files WHERE id = ?', [r.id]);
}
