# Plinkoo — TikTok Live Plinko Ball Game (Three.js + Matter.js + Firebase)

A complete, production-ready Plinko game:
- Frontend: Static site (GitHub Pages) with Three.js visuals and Matter.js physics.
- Backend: Node.js relay that listens to TikTok Live (chat + gifts) via `tiktok-live-connector` and pushes events to Firebase Realtime Database.
- Realtime sync: Frontend listens to Firebase events and spawns balls. When balls land in scoring slots, the leaderboard updates in Firebase.

Live data storage:
- Firebase Realtime Database URL: `https://plinkoo-82abc-default-rtdb.firebaseio.com/`
- Default TikTok username: `lmohss` (or `@lmohss`)

Important: Do not commit secrets (service account keys, API keys, etc.). Configure them as environment variables on your server host only.

---

## Features

- Upright triangular grid Plinko board with configurable rows.
- Balls are textured with the viewer’s TikTok profile picture and show their username as a floating label.
- Real-time leaderboard synced from Firebase.
- Anti-spam rate limiting on the server per username.
- Optional admin UI (toggle spawn and reset leaderboard).
- Fireworks after jackpots, emoji-ball fallback on avatar load errors.

---

## Project Structure

```
plinkoo/
├─ .gitignore
├─ firebase.rules.json
├─ README.md            (this file)
├─ index.html
├─ style.css
├─ assets/
│  └─ placeholder.txt
├─ js/
│  ├─ firebase.js
│  ├─ game.js
│  └─ utils.js
└─ server/
   ├─ package.json
   ├─ server.js
   └─ .env.example
```

---

## 1) Firebase Setup

1. Create or open your Firebase project (example: `plinkoo-82abc`).
2. Enable Realtime Database:
   - Database URL: `https://plinkoo-82abc-default-rtdb.firebaseio.com/`
3. Set Realtime Database rules:
   - In Firebase Console > Realtime Database > Rules, paste the content of `firebase.rules.json` and publish.
     - The rules allow:
       - Public read for `events`, `leaderboard`, and `config`.
       - Client writes are disabled for `events` (server-only via admin SDK).
       - `leaderboard` writes allowed for demo purposes (you can harden by moving scoring to the server).

4. Create a Firebase service account key (server-side only):
   - Project Settings > Service Accounts > Generate new private key (JSON).
   - Do NOT commit this JSON. Paste it only into your server host environment variable `FIREBASE_SERVICE_ACCOUNT_JSON`.

---

## 2) Backend Deployment (Render / Glitch / Any Node Host)

Only the `server/` folder is needed.

Environment variables required:
- `FIREBASE_SERVICE_ACCOUNT_JSON` — paste the full JSON from your Firebase service account (as a single JSON string). Do NOT commit it.
- `DATABASE_URL` — `https://plinkoo-82abc-default-rtdb.firebaseio.com/`
- `TIKTOK_USERNAME` — `lmohss`
- `ADMIN_TOKEN` — a strong random secret
- Optional:
  - `PORT` — default `3000`
  - `SPAWN_COOLDOWN_MS` — default `7500`
  - `SPAWN_ENABLED` — `true`/`false`, default `true`
  - `DEV_MODE` — default `true` (enables `/admin/spawn` for local testing)

Endpoints:
- `GET /health` — health check
- `POST /admin/reset-leaderboard` — clears leaderboard (header `x-admin-token: <ADMIN_TOKEN>`)
- `POST /admin/spawn` — simulate an event (only when `DEV_MODE=true`). Body: `{ "username": "TestUser", "avatarUrl": "https://...", "command": "!drop" }`
- `POST /admin/spawn-toggle?enabled=true|false` — toggle spawn processing (header `x-admin-token`)

Render example:
- Build command: `npm install`
- Start command: `npm start`
- Root directory: `server/`
- Add env vars in the Render dashboard.

Glitch:
- Import the `server/` folder project.
- Add env vars in the private `.env` area.

---

## 3) Frontend Deployment (GitHub Pages)

- Push this repository to GitHub.
- Settings > Pages: Deploy from branch (root).
- The site is static and talks to Firebase via REST streaming (no client secrets).

Notes:
- The page listens to `/events` for incoming drop events (from the server).
- The page writes to `/leaderboard` when balls land (demo). You can harden this by moving scoring to the server and locking client writes.

---

## 4) Local Development

Backend:
- `cd server`
- `cp .env.example .env` and fill values (paste your service account JSON in `FIREBASE_SERVICE_ACCOUNT_JSON`).
- `npm install`
- `npm start`

Frontend:
- Serve the root with any static server (`npx serve`, VS Code Live Server, or `python -m http.server`).
- For testing without TikTok, call:
  - `POST http://localhost:3000/admin/spawn` with body `{ "username": "Alice", "avatarUrl": "", "command": "!drop" }`

---

## 5) Security Notes

- Never commit your service account JSON or any credentials.
- The `leaderboard` is writable by anyone per the demo rules; for production, handle scoring on the server.
- The server enforces a per-user cooldown; you can add more rate limiting if needed.

---

## 6) Config and Tuning

- Scoring slots and their point values are set in `js/game.js` (`SLOT_POINTS`).
- Peg rows and spacing: `BOARD_ROWS`, `PEG_SPACING` in `js/game.js`.
- Admin panel calls backend admin endpoints; if your backend is on a different domain, proxy or update the frontend to use your backend base URL.

---

## 7) Troubleshooting

- No balls spawning: verify server logs and that `SPAWN_ENABLED` is true; confirm DB rules.
- Avatars not rendering: cross-origin issues; the game falls back to emoji balls.
- Duplicates: run only one display page (demo doesn’t implement event claiming).

---

## 8) Rotating Leaked Keys

If a service account key was exposed:
- Delete the exposed key in Google Cloud Console (IAM & Admin > Service Accounts > Keys).
- Generate a new key and update your server environment (`FIREBASE_SERVICE_ACCOUNT_JSON`).
- Remove the leaked key from any commit(s) and force-push only if it had reached the remote. In your case push was blocked, so re-commit without the secret is sufficient.

Enjoy!