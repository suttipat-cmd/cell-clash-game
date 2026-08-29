# Cell Clash

An online, server-authoritative Agar-style arena for **2–5 guest players**. One central lobby supports Free for All and balanced Teams matches. Bots are deliberately excluded.

## Architecture

- `apps/web` — Vite + TypeScript canvas renderer and input layer.
- `apps/server` — Socket.IO authoritative simulation at 25 ticks per second. The browser only sends intent; the server calculates movement, food, viruses, splits, ejected mass, deaths and scores.
- `packages/shared` — game constants, types and rules shared by the client/server.
- `supabase` — anonymous guest identity, profile row and completed-match persistence schema. Supabase Realtime is not used for high-frequency movement.

## Local development

Requirements: Node 22+ (Node 24 recommended) and npm.

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. The web app uses Vite's WebSocket proxy to reach the local server on port 3001. `AUTH_REQUIRED=false` makes local game development possible before Supabase is configured; never deploy with that value.

```bash
npm run test
npm run typecheck
npm run build
```

## Supabase setup

Project URL: `https://gnbvicxgcxskeydukdcv.supabase.co`

1. In **Authentication → Providers**, enable **Anonymous sign-ins**.
2. In **Authentication → URL configuration**, add the production web URL and local `http://localhost:5173` as redirect URLs.
3. In **Connect**, copy the `sb_publishable_...` key. It is safe to use in the browser; do not use a secret/service-role key there.
4. Add the publishable key to the values in `.env`.
5. Link the CLI and apply the committed migration:

   ```bash
   npx supabase@latest login
   npx supabase@latest link --project-ref gnbvicxgcxskeydukdcv
   npx supabase@latest db push
   ```

6. In the Dashboard, run the security advisors after the migration. Every public table in the migration has RLS enabled.

## Production deployment

The game server needs an always-on Node service with WebSocket support; static hosting alone (including GitHub Pages) is not enough.

1. Deploy `apps/server` as a Docker service using `apps/server/Dockerfile`.
2. Set `AUTH_REQUIRED=true`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `CLIENT_ORIGIN=https://your-web-domain` on the server. Do not place a Supabase secret key in the client.
3. Deploy `apps/web` to any static host, set `VITE_GAME_SERVER_URL=https://your-game-server-domain` and the two `VITE_SUPABASE_*` values during its build.
4. Add the final web URL to Supabase Auth redirect URLs and the server `CLIENT_ORIGIN` allow-list.
5. Health check endpoint: `GET /healthz`.

## Security model

- The server validates authenticated Guest JWTs in production.
- A client cannot send mass, coordinates, collisions, score or an arbitrary game-state update.
- Input is normalized/rate-limited. Split/eject cooldowns and game rules are server-side.
- RLS prevents a guest from reading or editing anyone else's profile, and browser roles have no direct access to match history writes.
- The `service_role`/secret key is never exposed through Vite variables or source code.
