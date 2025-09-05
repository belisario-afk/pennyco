/* eslint-disable no-console */
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const { WebcastPushConnection } = require('tiktok-live-connector');

dotenv.config();

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || 'https://plinkoo-82abc-default-rtdb.firebaseio.com/';
const TIKTOK_USERNAME = (process.env.TIKTOK_USERNAME || 'lmohss').replace(/^@/, '');
const SPAWN_COOLDOWN_MS = Number(process.env.SPAWN_COOLDOWN_MS || 7500);
let SPAWN_ENABLED = String(process.env.SPAWN_ENABLED || 'true').toLowerCase() === 'true';
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

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, spawnEnabled: SPAWN_ENABLED, username: TIKTOK_USERNAME });
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

// Dev simulate spawn
app.post('/admin/spawn', async (req, res) => {
  if (!DEV_MODE) return res.status(403).json({ error: 'DEV_MODE disabled' });
  const { username = 'Tester', avatarUrl = '', command = '!drop' } = req.body || {};
  try {
    await enqueueEvent({ username, avatarUrl, command });
    return res.json({ ok: true });
  } catch (e) {
    console.error('simulate spawn failed', e);
    return res.status(500).json({ error: 'failed' });
  }
});

// TikTok connection
const tiktok = new WebcastPushConnection(TIKTOK_USERNAME, {
  // Request default options; adjust if needed.
});

const lastEventByUser = new Map();

function allowedByCooldown(username) {
  const now = Date.now();
  const last = lastEventByUser.get(username) || 0;
  if (now - last < SPAWN_COOLDOWN_MS) return false;
  lastEventByUser.set(username, now);
  return true;
}

async function enqueueEvent({ username, avatarUrl, command }) {
  if (!SPAWN_ENABLED) return;

  const event = {
    username,
    command,
    avatarUrl: avatarUrl || '',
    timestamp: admin.database.ServerValue.TIMESTAMP,
  };
  await db.ref('events').push(event);
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
    const repeatEnd = !!gift?.repeatEnd;

    // only when the gift streak ends or for non-streakable gifts
    if (gift?.repeatEnd === false && gift?.repeatCount && gift?.repeatCount > 0) {
      return; // wait for repeatEnd
    }

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
    tiktok.on('like', () => {}); // optional
  } catch (err) {
    console.error('Failed to connect to TikTok:', err?.message || err);
    setTimeout(() => startTikTok().catch(console.error), 7000);
  }
}

(async () => {
  // Reflect initial spawnEnabled to DB
  await db.ref('config').update({ spawnEnabled: SPAWN_ENABLED }).catch(() => {});
  startTikTok().catch(console.error);
})();

app.listen(PORT, () => {
  console.log(`Plinkoo relay listening on :${PORT}`);
});