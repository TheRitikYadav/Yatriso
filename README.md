# Yatriso

Yatriso is a no-signup taxi platform MVP for college and work travelers, designed to run mostly on Cloudflare with ephemeral ride state.

## Included apps

- `apps/web` - React + Vite rider/driver web app
- `workers/api` - Cloudflare Worker + Durable Object realtime backend

## Current MVP features

- Rider: current location + destination address input
- Destination geocoding via free OpenStreetMap Nominatim API
- Ride request creation and ride ID sharing
- Driver: join ride by ride ID, accept ride, send live location
- Rider: live driver tracking and pickup ETA
- Ride completion endpoint
- Automatic ride expiry via Durable Object alarm (2 hours)

## Local development

### Install dependencies

```bash
npm install
```

### Start backend (Worker)

```bash
npm run dev:api
```

### Start frontend

```bash
cp apps/web/.env.example apps/web/.env
npm run dev:web
```

## API routes

- `GET /health`
- `GET /geocode?q=address`
- `GET /eta?fromLat=&fromLng=&toLat=&toLng=`
- `POST /rides`
- `GET /rides/:rideId`
- `POST /rides/:rideId/accept`
- `POST /rides/:rideId/location`
- `POST /rides/:rideId/complete`
- `GET /ws/ride/:rideId?role=rider|driver`

## Deploy and host on Cloudflare

### 1) Deploy Worker API (one-time, then on changes)

From repo root:

```bash
npm run deploy:api
```

In Cloudflare dashboard, set route:

- `api.yatriso.com/*` -> `yatriso-api`

### 2) Deploy Frontend with Pages

In Cloudflare Pages:

- Connect GitHub repo: `TheRitikYadav/Yatriso`
- Framework preset: `Vite`
- Root directory: `/` (repo root)
- Build command: `npm run build`
- Build output directory: `dist`
- Environment variable:
  - `VITE_API_BASE_URL=https://api.yatriso.com`

Set Pages custom domain:

- `yatriso.com` (or `app.yatriso.com`)

### 3) DNS expected end state

- `yatriso.com` -> Cloudflare Pages project
- `api.yatriso.com` -> Worker route

## Cloudflare CI/CD command values

Use these exact values to avoid workspace deploy errors:

- Workers deploy command: `npx wrangler deploy -c workers/api/wrangler.toml`
- Pages build command: `npm run build`
- Pages output directory: `dist`

## Free API note

This MVP uses free public endpoints for geocoding and routing. They can be rate-limited. For production scale, move to managed or self-hosted geocoding/routing.
