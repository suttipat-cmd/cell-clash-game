# Cell Clash

A **2–5 player online Agar-style game** that runs entirely on **GitHub Pages + Supabase Realtime**. There is one central arena, Guest names, Free for All and Teams. No server, container, paid game host, login form, or bot is required.

## How it works

- The web build is static and deploys to GitHub Pages.
- Supabase Realtime Presence lists players in `cell-clash:central`.
- The longest-present connected player becomes the temporary match host. That browser simulates the arena and broadcasts snapshots at 15fps using Supabase Broadcast.
- If the host leaves, the remaining players elect a new host and return safely to the lobby for a fresh round.
- The Supabase publishable key is intentionally included in the static client build. It is a public key, not a secret or service-role credential.

This design is deliberately limited to a friendly, small public room. A malicious browser can still alter its own client or impersonate input, so it is not appropriate for ranked play, prizes, or high-stakes leaderboards. Those require an authoritative game server.

## Play locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in two separate browser profiles/devices to test the shared room. The browser must be able to connect to `https://gnbvicxgcxskeydukdcv.supabase.co`.

```bash
npm run test
npm run typecheck
npm run build
```

## Deployment

Every push to `main` validates, builds, and deploys the static site to GitHub Pages. The workflow builds with `VITE_BASE_PATH=/cell-clash-game/`, so assets work beneath the repository page path.

If GitHub Pages is not yet enabled, open **Repository → Settings → Pages** and choose **GitHub Actions** as the source once. The first successful deployment will then publish the game at:

`https://suttipat-cmd.github.io/cell-clash-game/`

## Supabase

The project is `cell-clash-prod` (`gnbvicxgcxskeydukdcv`). The initial migrations keep RLS enabled for profiles and match-history tables. The current realtime-only game does not need to expose database records to players; it uses the public Realtime channel only.

For a public friendly room, keep **Realtime Settings → Allow public access** enabled. If the game later gains accounts, private rooms, ranking, or moderation, migrate the channel to Realtime Authorization with authenticated users and RLS policies.
