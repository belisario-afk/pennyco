/* eslint-disable no-console */
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const { WebcastPushConnection } = require('tiktok-live-connector');

dotenv.config();

// Config
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || 'https://plinkoo-82abc-default-rtdb.firebaseio.com/';
const TIKTOK_USERNAME = (process.env.TIKTOK_USERNAME || 'lmohss').replace(/^@/, '');
let SPAWN_COOLDOWN_MS = Number(process.env.SPAWN_COOLDOWN_MS || 1200);
let SPAWN_ENABLED = String(process.env.SPAWN_ENABLED || 'true').toLowerCase() === 'true';
let STREAK_MODE = String(process.env.STREAK_MODE || 'repeatEnd'); // repeatEnd | first | every
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
  console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON.');
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

// Utility
function pushEvent(obj) {
  return db.ref('events').push(obj);
}

app.get('/', (req, res) => {
  res.type('html').send('<h2>Plinkoo Relay</h2><p>OK</p>');
});

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

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || req.query.token;
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

app.post('/admin/reset-leaderboard', requireAdmin, async (_req, res) => {
  try {
    await db.ref('leaderboard').set(null);
    res.json({ ok: true });
  } catch (e) {
    console.error('reset-leaderboard failed', e);
    res.status(500).json({ error: 'failed' });
  }
});

app.post('/admin/spawn-toggle', requireAdmin, async (req, res) => {
  try {
    const enabled = String(req.query.enabled || '').toLowerCase() === 'true';
    SPAWN_ENABLED = enabled;
    await db.ref('config').update({ spawnEnabled: enabled });
    res.json({ ok: true, spawnEnabled: enabled });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

app.get('/admin/config', requireAdmin, (req, res) => {
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
    if (typeof streakMode === 'string' && ['repeatEnd', 'first', 'every'].includes(streakMode)) {
      STREAK_MODE = streakMode;
    }
    await db.ref('config').update({
      spawnEnabled: SPAWN_ENABLED,
      cooldownMs: SPAWN_COOLDOWN_MS,
      streakMode: STREAK_MODE
    });
    res.json({ ok: true, cooldownMs: SPAWN_COOLDOWN_MS, streakMode: STREAK_MODE, spawnEnabled: SPAWN_ENABLED });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

app.post('/admin/spawn', async (req, res) => {
  if (!DEV_MODE) return res.status(403).json({ error: 'DEV_MODE disabled' });
  const { username = 'Tester', avatarUrl = '', command = '!drop' } = req.body || {};
  try {
    await pushEvent({
      username, avatarUrl, command,
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
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

function shouldSpawnForGift(gift) {
  const isStreak = typeof gift.repeatEnd === 'boolean' || (gift.repeatCount && gift.repeatCount > 0);
  if (!isStreak) return true;
  if (STREAK_MODE === 'every') return true;
  if (STREAK_MODE === 'first') {
    return gift.repeatStart === true || gift.repeatCount === 1 || gift.repeatEnd === true;
  }
  return gift.repeatEnd === true;
}

async function handleChat(data) {
  try {
    const username = data?.uniqueId || data?.nickname || 'viewer';
    const avatarUrl = data?.profilePictureUrl || '';
    const raw = (data?.comment || '').trim();
    if (!raw) return;
    const comment = raw.toLowerCase();

    // Redeem parsing
    const redeemMap = {
      t1: ['!t1', '!tier1', '!redeem t1', '!redeem tier1'],
      t2: ['!t2', '!tier2', '!redeem t2', '!redeem tier2'],
      t3: ['!t3', '!tier3', '!redeem t3', '!redeem tier3']
    };
    let redeemTier = null;
    for (const tier of Object.keys(redeemMap)) {
      if (redeemMap[tier].some(k => comment === k)) {
        redeemTier = tier;
        break;
      }
    }

    if (redeemTier) {
      // Always push event (point deduction client-side for now)
      await pushEvent({
        username,
        avatarUrl,
        command: `redeem:${redeemTier}`,
        timestamp: admin.database.ServerValue.TIMESTAMP
      });
      return;
    }

    // Drop command
    if (comment.includes('!drop') || comment === 'drop') {
      if (!allowedByCooldown(username)) return;
      if (!SPAWN_ENABLED) return;
      await pushEvent({
        username,
        avatarUrl,
        command: '!drop',
        timestamp: admin.database.ServerValue.TIMESTAMP
      });
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
    if (!SPAWN_ENABLED) return;

    await pushEvent({
      username,
      avatarUrl,
      command: `gift:${giftName}:${diamonds}`,
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
  } catch (e) {
    console.error('handleGift error', e);
  }
}

async function startTikTok() {
  try {
    const state = await tiktok.connect();
    console.log(`Connected roomId ${state.roomId}`);

    tiktok.on('disconnected', () => {
      console.log('Disconnected, retrying in 5s...');
      setTimeout(() => startTikTok().catch(console.error), 5000);
    });

    tiktok.on('chat', handleChat);
    tiktok.on('gift', handleGift);
    tiktok.on('streamEnd', () => console.log('Stream ended.'));
  } catch (err) {
    console.error('TikTok connect failed:', err?.message || err);
    setTimeout(() => startTikTok().catch(console.error), 7000);
  }
}

(async () => {
  await db.ref('config').update({
    spawnEnabled: SPAWN_ENABLED,
    cooldownMs: SPAWN_COOLDOWN_MS,
    streakMode: STREAK_MODE
  }).catch(()=>{});
  startTikTok().catch(console.error);
})();

app.listen(PORT, () => {
  console.log(`Plinkoo relay listening on :${PORT}`);
});