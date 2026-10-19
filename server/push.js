// Web Push notifications so Cynthia can reach users even when the app is closed.
import webpush from 'web-push';
import { config } from './config.js';
import { db, id, now, ensureSetting } from './db.js';

let publicKey = '';

export async function initPush() {
  let pub = config.vapidPublicKey;
  let priv = config.vapidPrivateKey;
  if (!pub || !priv) {
    // Generate once and keep in the database so existing subscriptions stay valid.
    const keys = JSON.parse(await ensureSetting('vapid_keys', () => JSON.stringify(webpush.generateVAPIDKeys())));
    pub = keys.publicKey;
    priv = keys.privateKey;
  }
  webpush.setVapidDetails(config.vapidSubject, pub, priv);
  publicKey = pub;
}

export const getPublicKey = () => publicKey;

export async function subscribe(userId, sub) {
  if (!sub?.endpoint) throw new Error('Invalid subscription.');
  await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
  await db.run('INSERT INTO push_subscriptions (id, user_id, endpoint, data, created_at) VALUES (?, ?, ?, ?, ?)', [
    id(), userId, sub.endpoint, JSON.stringify(sub), now(),
  ]);
}

export async function unsubscribe(endpoint) {
  await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

export async function notify(userId, { title, body, url = '/', tag }) {
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  const payload = JSON.stringify({ title, body: String(body || '').slice(0, 300), url, tag });
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(JSON.parse(s.data), payload);
        sent += 1;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) await unsubscribe(s.endpoint);
        else console.warn('[push] failed:', e.message);
      }
    }),
  );
  return sent;
}
