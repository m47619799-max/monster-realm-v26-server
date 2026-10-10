# Monster Realm V28 — Real PvP + Free Switching (Render Free)

This V28 update REPLACES the V27 server. Use the existing Render service and GitHub repository; do not create a second service.

## Deploy

1. Visit https://github.com/m47619799-max/monster-realm-v26-server
2. Upload all 6 files from this package to the repository root, overwrite the existing files and commit on `main`.
3. Wait for Render auto-deploy (or inspect Render deployment if it does not trigger).
4. Visit https://monster-realm-v26-online.onrender.com/health and check `"edition":"V28"`.
5. Use V28 CrazyGames or V28 Poki game build only after the above update.

## Rules

- PvP room starts a server-controlled 30-second team-selection period with exactly 3 monsters per side.
- After prep, visual 1-vs-1 battles begin; 3 team members remain available.
- On YOUR turn, you may switch to ANY of your 3 living monsters without spending a turn or affecting ability cooldowns. You can immediately attack after switching.
- Cannot switch to KO monsters, outside your turn, or after the match ends.
- When a monster is KO, automatically send another living teammate; match ends only when all 3 faint.
- Skill 1 has no cooldown, skills 2-9 wait 3 turns.
- Rematch starts another 30-second team-selection window.

## Notes

- Render Free sleeping/restarts can erase temporary friend accounts stored on its ephemeral filesystem. Use test-only names and passwords.
- No extra npm dependencies needed. Build command: `echo "No external dependencies"`, start command: `node server.mjs`.
- The server URL is HTTPS and WebSocket (WSS) enabled by Render.
- Poki publication may require separate approval for connecting to the external server via Content Security Policy.
