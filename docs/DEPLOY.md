# Deploying to Render

Element TD 3D runs on **Render** with a single node process serving static files and WebSocket on the same port. No new dependencies, no database, zero configuration outside the blueprint.

## Local verification (do this first)

```bash
npm ci --include=dev
npm run build
PORT=5291 node server/index.js
```

Then:
- Open http://localhost:5291/ in your browser
- Devtools → Network, create a multiplayer room
- Verify the WebSocket connects to `wss://localhost:5291/ws` (under "Type: websocket")
- Play a quick run and confirm the scoreboard updates

Sanity checks:
```bash
# HTTP health check
curl -i http://localhost:5291/healthz
# Expected: 200 OK, body "ok"

# Static asset headers
curl -sI http://localhost:5291/assets/* | grep -i cache-control
# Expected: max-age=31536000, immutable (for hashed filenames)

# SPA fallback
curl -I http://localhost:5291/nonexistent
# Expected: 200 OK (serves index.html)
```

When done: stop the server (`Ctrl+C`). Do not use port 5275.

## Deploying to Render

1. **Create a GitHub repository** (private or public):
   ```bash
   git add -A
   git commit -m "Serve dist/ and the lobby socket from one node process"
   gh repo create element-td-3d --private --source=. --remote=origin --push
   ```

2. **Connect Render** (no CLI):
   - https://dashboard.render.com → **New** → **Blueprint**
   - Connect your GitHub account, select `element-td-3d`
   - Render reads `render.yaml` and shows one web service on the free plan
   - Click **Apply**
   - First build takes 3–6 minutes

3. **Verify in production**:
   ```bash
   curl -i https://<your-service>.onrender.com/healthz
   # Expected: 200 OK, body "ok"
   ```
   Then open https://<your-service>.onrender.com in your browser, press `?mp` to open the multiplayer panel, create a room, and confirm the WebSocket URL in devtools is `wss://<your-service>.onrender.com/ws`.

4. **Subsequent deploys**:
   Just `git push main`. Render auto-builds and deploys.

## How it works

- `server/static.js` serves `dist/` with correct cache headers: hashed assets get 1 year, index.html gets no-cache, sourcemaps get no-store.
- `/healthz` answers before touching the filesystem, so a broken build fails loudly instead of timing out.
- WebSocket lives on `/ws`, not the root, so it is greppable in logs and can be routed independently.
- One HTTP server, one WebSocket server, one certificate — no CORS, no mixed-content, no cross-origin creep.

## Free-plan gotchas

The free tier has **no persistent disk**. The leaderboard resets on every deploy or after 15 minutes of inactivity (Render's default spin-down). This is honest behaviour; the code does not pretend otherwise. If you want a durable leaderboard, move to Render Starter (~$7/mo) or use an external service (Upstash Redis, GitHub Gist API).

**Cold start:** The first request after 15 minutes idle takes 30–60 s to wake the container. The client's reconnect logic is tuned for a LAN (20 s budget); for production, watch for a stalled UI and consider adding a "waking…" message to warn players.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Build fails with "vite: not found" | NODE_ENV=production was set | Remove it from envVars; see render.yaml |
| Health check times out, deploy never goes live | dist/ was not built, or the build path is wrong | Check the build command reads dist/ correctly |
| WebSocket connects to root, not `/ws` | Network is old code | Hard-refresh, clear browser cache |
| Leaderboard shows an old run after deploy | Free plan has no persistent disk | Expected; data resets on each deploy |

## What is NOT included

- Spectating (Feature D) — different feature
- Authentication or user accounts — out of scope
- Database — use an external service if needed
- Email or webhooks — out of scope
