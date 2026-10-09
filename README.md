# Monster Realm V26 — Render FREE TEST SERVER

**This repository contains the online PvP BACKEND ONLY, not the 400-monster game**.
The game will be uploaded separately to CrazyGames after the server has a live HTTPS URL.

## Deploy for free

1. Create a GitHub repository, e.g. `monster-realm-v26-server`, and upload these four files to its root:
   `server.mjs`, `ws-lite.mjs`, `package.json`, `render.yaml`.
2. Connect the repository to Render (or give its URL to ChatGPT to create the service).
3. Use `Web Service`, runtime `Node`, region `Singapore`, plan `Free`, build command `echo "No external dependencies"`, start command `node server.mjs`.
4. Environment variable: `DATA_FILE=/tmp/monster-realm-test/players.json`.
5. Wait for `Live`. Open the actual `https://YOUR-APP.onrender.com/health`, which should return `{ "ok": true, ... }`.
6. Provide that *public HTTPS URL only* to ChatGPT. Do not send account passwords or tokens.
7. ChatGPT will create a CrazyGames V26 game ZIP with its `backend-config.js` pointing to the live URL.
8. Test two browser sessions on the CrazyGames Preview page, with three monsters in each team.

## Important free-tier warning

- Render sleeps after 15 minutes with no inbound traffic/WebSocket messages, and waking may take a minute.
- Free Web Services **do not have persistent disks**. Accounts, friendship data and local player files are lost on redeploy/restart/sleep. **Use disposable TEST names/passwords**.
- Game progress is saved separately through CrazyGames SDK/local browser, but online friend accounts on this test backend are temporary.
- Only one instance is supported; this is **not production-ready** multiplayer infrastructure.
- Never change `plan: free` to `starter` or add a `disk` unless you agree to paying.

Node 20+; no external npm dependencies are needed. Live PvP rooms, rematch, profile, friend invites and cooldowns are in `server.mjs`.
