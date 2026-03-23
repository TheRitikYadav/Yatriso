# Yatriso Foundation

Yatriso is a Cloudflare-first taxi platform foundation for college and work travelers.  
This repository contains:

- `apps/web`: Rider and Driver web app (React + Vite + MapLibre)
- `workers/api`: Realtime API with Durable Objects for active rides

## Product assumptions (MVP)

- No signup required
- Rider enters destination and requests a ride
- Driver accepts ride
- Rider sees live driver location and ETA placeholder
- Data is ephemeral and scoped to active rides

## Tech stack

- Cloudflare Pages for frontend hosting
- Cloudflare Workers + Durable Objects for realtime ride session state
- MapLibre + OpenStreetMap tiles for map rendering
- GitHub for source control and CI integration with Cloudflare

## Quick start

### 1) Install dependencies

```bash
npm install
```

### 2) Run frontend

```bash
npm run dev:web
```

### 3) Run worker locally

```bash
npm run dev:api
```

## Cloudflare deployment

### Frontend (Pages)

- Connect this repo to Cloudflare Pages
- Build command: `npm run build:web`
- Build output: `apps/web/dist`
- Env var for frontend:
  - `VITE_API_BASE_URL=https://api.yourdomain.com`

### API (Workers)

Inside `workers/api`, deploy:

```bash
npm run deploy:api
```

Then map a route like:

- `api.yourdomain.com/*` -> `yatriso-api` worker

## API overview

- `POST /rides` create new ride request
- `POST /rides/:rideId/accept` driver accepts ride
- `POST /rides/:rideId/location` driver pushes current location
- `GET /rides/:rideId` fetch current ride snapshot
- `GET /ws/ride/:rideId?role=rider|driver` realtime websocket channel

## Security and abuse controls (recommended next)

- Add Cloudflare Turnstile in frontend
- Add per-IP rate limiting in Worker
- Add city/geofence validation
- Add ride expiry + cleanup policy

## Notes

- This is a foundation, not production-ready dispatch logic.
- Public free geocoding/routing APIs can be rate limited.
