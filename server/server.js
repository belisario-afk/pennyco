/* eslint-disable no-console */
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const { WebcastPushConnection } = require('tiktok-live-connector');

dotenv.config();

// Config (env + runtime)
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || 'https://plinkoo-82abc-default-rtdb.firebaseio.com/';
const TIKTOK_USERNAME = (process.env.TIKTOK_USERNAME || 'lmohss').replace(/^@/, '');
let SPAWN_COOLDOWN_MS = Number(process.env.SPAWN_COOLDOWN_MS || 1200); // lower default for snappier spawns
let SPAWN_ENABLED = String(process.env.SPAWN_ENABLED || 'true').toLowerCase() === 'true';
// How to handle streak gifts: 'repeatEnd' (default), 'first' (spawn on first gift), 'every' (spawn each event - use with low cooldown)
let STREAK_MODE = String(process.env.STREAK_MODE || 'repeatEnd'); // 'repeatEnd' | 'first' | 'every'
const DEV_MODE = String(process.env.DEV_MODE || 'true').toLowerCase() === 'true';

const serviceAccountJSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!serviceAccountJSON) {
  console.error('FIREBASE_SERVICE_ACCOUNT_JSON missing. Exiting.');
  process.exit(1);
}
let serviceAccount;
try {
  serviceAccount = JSON.parse(serviceAccountJSON);
} catch (e) {
  console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON. Make sure it is valid JSON.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DATABASE_URL,
});

const db = admin.database();
const app = express();
app.use(cors());
app.use(express.json());

// Root page (info)
app.get('/', (req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html><head><meta charset="utf-8"><title>Plinkoo Relay</title>
    <style>body{font-family:system-ui;padding:24px;color:#0b0f1a}</style></head>
    <body>
      <h2>Plinkoo Relay</h2>
      <p>Service is running. Use <a href="/health">/health</a> for status.</p>
      <ul>
        <li>POST <code>/admin/spawn</code> (DEV_MODE only) { "username": "Test", "avatarUrl": "", "command": "!drop" }</li>
        <li>POST <code>/admin/spawn-toggle?enabled=true|false</code> (requires x-admin-token)</li>
        <li>POST <code>/admin/reset-leaderboard</code> (requires x-admin-token)</li>
        <li>GET/POST <code>/admin/config</code> (requires x-admin-token) to tune cooldown and streak mode</li>
      </ul>
    </body></html>
  `);
});

// Health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    spawnEnabled: SPAWN_ENABLED,
    username: TIKTOK_USERNAME,
    devMode: DEV_MODE,
    streakMode: STREAK_MODE,
    cooldownMs: SPAWN_COOLDOWN_MS
  });
});

// Admin guard
function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || req.query.token;
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

// Admin: reset leaderboard
app.post('/admin/reset-leaderboard', requireAdmin, async (req, res) => {
  try {
    await db.ref('leaderboard').set(null);
    return res.json({ ok: true });
  } catch (e) {
    console.error('reset-leaderboard failed', e);
    return res.status(500).json({ error: 'failed' });
  }
});

// Admin: toggle spawn enabled
app.post('/admin/spawn-toggle', requireAdmin, async (req, res) => {
  try {
    const enabled = String(req.query.enabled || '').toLowerCase() === 'true';
    SPAWN_ENABLED = enabled;
    await db.ref('config').update({ spawnEnabled: enabled });
    return res.json({ ok: true, spawnEnabled: enabled });
  } catch (e) {
    console.error('spawn-toggle failed', e);
    return res.status(500).json({ error: 'failed' });
  }
});

// Admin: config (cooldown + streak mode)
app.get('/admin/config', requireAdmin, async (req, res) => {
  res.json({
    ok: true,
    spawnEnabled: SPAWN_ENABLED,
    cooldownMs: SPAWN_COOLDOWN_MS,
    streakMode: STREAK_MODE
  });
});

app.post('/admin/config', requireAdmin, async (req, res) => {
  try {
    const { cooldownMs, streakMode, spawnEnabled } = req.body || {};
    if (typeof cooldownMs === 'number' && cooldownMs >= 0) SPAWN_COOLDOWN_MS = cooldownMs;
    if (typeof spawnEnabled === 'boolean') SPAWN_ENABLED = spawnEnabled;
    if (typeof streakMode === 'string' && ['repeatEnd','first','every'].includes(streakMode)) {
      STREAK_MODE = streakMode;
    }
    await db.ref('config').update({
      spawnEnabled: SPAWN_ENABLED,
      cooldownMs: SPAWN_COOLDOWN_MS,
      streakMode: STREAK_MODE
    });
    res.json({ ok: true, cooldownMs: SPAWN_COOLDOWN_MS, streakMode: STREAK_MODE, spawnEnabled: SPAWN_ENABLED });
  } catch (e) {
    console.error('admin/config failed', e);
    res.status(500).json({ error: 'failed' });
  }
});

// Dev simulate spawn
app.post('/admin/spawn', async (req, res) => {
  if (!DEV_MODE) return res.status(403).json({ error: 'DEV_MODE disabled' });
  const { username = 'Tester', avatarUrl = '', command = '!drop' } = req.body || {};
  try {
    console.log('[admin/spawn] simulate', { username, command });
    await enqueueEvent({ username, avatarUrl, command });
    return res.json({ ok: true });
  } catch (e) {
    console.error('simulate spawn failed', e);
    return res.status(500).json({ error: 'failed' });
  }
});

// TikTok connection
const tiktok = new WebcastPushConnection(TIKTOK_USERNAME, {});
const lastEventByUser = new Map();

function allowedByCooldown(username) {
  const now = Date.now();
  const last = lastEventByUser.get(username) || 0;
  if (now - last < SPAWN_COOLDOWN_MS) return false;
  lastEventByUser.set(username, now);
  return true;
}

async function enqueueEvent({ username, avatarUrl, command }) {
  if (!SPAWN_ENABLED) {
    console.log('[enqueueEvent] blocked (spawn disabled)', username, command);
    return;
  }
  const event = {
    username,
    command,
    avatarUrl: avatarUrl || '',
    timestamp: admin.database.ServerValue.TIMESTAMP,
  };
  const ref = await db.ref('events').push(event);
  console.log('[enqueueEvent] pushed', ref.key, { username, command });
}

function shouldSpawnForGift(gift) {
  // TikTok gift fields commonly used: repeatEnd (boolean), repeatCount (number), giftType
  // Non-streak gifts typically have repeatEnd undefined and repeatCount 0/undefined.
  const isStreak = typeof gift.repeatEnd === 'boolean' || (gift.repeatCount && gift.repeatCount > 0);
  if (!isStreak) return true; // single gift: spawn immediately

  if (STREAK_MODE === 'every') return true;
  if (STREAK_MODE === 'first') {
    // as soon as streak starts OR first count observed
    return gift.repeatStart === true || gift.repeatCount === 1 || gift.repeatEnd === true;
  }
  // default 'repeatEnd': only spawn when streak ends
  return gift.repeatEnd === true;
}

async function handleChat(data) {
  try {
    const username = data?.uniqueId || data?.nickname || 'viewer';
    const avatarUrl = data?.profilePictureUrl || '';
    const comment = (data?.comment || '').trim();
    if (!comment) return;
    const normalized = comment.toLowerCase();
    if (normalized.includes('!drop') || normalized === 'drop') {
      if (!allowedByCooldown(username)) return;
      await enqueueEvent({ username, avatarUrl, command: '!drop' });
    }
  } catch (e) {
    console.error('handleChat error', e);
  }
}

async function handleGift(gift) {
  try {
    const username = gift?.uniqueId || gift?.nickname || 'viewer';
    const avatarUrl = gift?.profilePictureUrl || '';
    const giftName = gift?.giftName || 'gift';
    const diamonds = Number(gift?.diamondCount || 0);

    if (!shouldSpawnForGift(gift)) return;
    if (!allowedByCooldown(username)) return;

    await enqueueEvent({ username, avatarUrl, command: `gift:${giftName}:${diamonds}` });
  } catch (e) {
    console.error('handleGift error', e);
  }
}

async function startTikTok() {
  try {
    const state = await tiktok.connect();
    console.log(`Connected to roomId ${state.roomId} as @${TIKTOK_USERNAME}`);

    tiktok.on('disconnected', () => {
      console.log('Disconnected, retrying in 5s...');
      setTimeout(() => startTikTok().catch(console.error), 5000);
    });

    tiktok.on('chat', handleChat);
    tiktok.on('gift', handleGift);
    tiktok.on('streamEnd', () => console.log('Stream ended.'));
  } catch (err) {
    console.error('Failed to connect to TikTok:', err?.message || err);
    setTimeout(() => startTikTok().catch(console.error), 7000);
  }
}

(async () => {
  await db.ref('config').update({
    spawnEnabled: SPAWN_ENABLED,
    cooldownMs: SPAWN_COOLDOWN_MS,
    streakMode: STREAK_MODE
  }).catch(() => {});
  startTikTok().catch(console.error);
})();

app.listen(PORT, () => {
  console.log(`Plinkoo relay listening on :${PORT}`);
});