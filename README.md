# Monster Realm V27 – PvP 30-second team selection (Render Free)

This is an **update to the existing V26 GitHub repository**. Do not create a new Render service.

1. Open https://github.com/m47619799-max/monster-realm-v26-server
2. Click **Add file → Upload files**, upload all 6 files in this package at repository root, overwriting the V26 versions. Commit to `main`.
3. Render automatically deploys from GitHub. Wait until **Live**.
4. Open https://monster-realm-v26-online.onrender.com/health and verify `"edition":"V27"`.
5. Then use the separate V27 game ZIP on CrazyGames Preview.

### PvP rules

- A room starts with one host waiting; the 30-second server-controlled timer starts when a second player joins.
- Each player has **3 team slots**; choose monsters from up to 500 owned creatures.
- The server rejects duplicate selections, late selections, and attacks before the prep timer ends.
- Time ends: teams lock and real turn-based attacks begin automatically.
- Monster reaches 0 HP: next creature enters. Defeat all 3: win.
- Skill 1 has no cooldown; skills 2–9 use a 3-turn cooldown.
- Rematch opens a new 30-second selection period.
- Works through both room ID and accepted friend challenge.

⚠ Render Free hosts use ephemeral files and may restart/sleep. This is a test deployment, not durable account storage.
