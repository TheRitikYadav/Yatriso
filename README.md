# Yatriso — Real-time Ride Coordination MVP

**TypeScript · React · Vite · Cloudflare Workers · Durable Objects**

Yatriso is a prototype for coordinating rides between travelers and drivers. It uses a web frontend and a Cloudflare Worker backend with Durable Objects for stateful, real-time ride sessions.

## Architecture

```text
Rider / Driver (React + Vite)
           |
           v
   Cloudflare Worker API
           |
           v
 Durable Object per ride
 (state, location, WebSocket)
           |
   Geocoding / routing API
```

## Functionality represented in this repository

- Riders enter origin/destination and create shareable ride requests.
- Drivers can join via ride ID and accept a request.
- Sessions support location updates and rider-side tracking.
- Backend routes provide geocoding and estimated travel information.
- Durable Object alarms expire ride state after two hours.

This is an **MVP**, not a production taxi dispatch service. Payments, verified driver identity and production reliability are not established by the repository.

## Code structure

| Path | Description |
| --- | --- |
| `apps/web` | React and Vite frontend |
| `workers/api` | Cloudflare Worker and Durable Object backend |
| `.github` | Repository automation |

## Development

```bash
git clone https://github.com/TheRitikYadav/Yatriso.git
cd Yatriso
npm ci
npm run dev:api
```

Run the web frontend in a separate terminal:

```bash
cp apps/web/.env.example apps/web/.env
npm run dev:web
```

Set the frontend API URL in the local environment file to your Worker development endpoint.

## Important API paths

```text
GET  /health
GET  /geocode?q=...
GET  /eta?fromLat=...&fromLng=...&toLat=...&toLng=...
POST /rides
GET  /rides/:rideId
POST /rides/:rideId/accept
POST /rides/:rideId/location
POST /rides/:rideId/complete
GET  /ws/ride/:rideId?role=rider|driver
```

## Build and deployment

- Web build: `npm run build`
- Worker local development: `npm run dev:api`
- Worker deployment: `npm run deploy:api`
- Wrangler config: `workers/api/wrangler.toml`

Deployment requires an appropriately configured Cloudflare account, Worker route, Pages deployment, and environment variables. Example custom domains in configuration or documentation do **not** guarantee an active live deployment.

## Engineering takeaways

This repository explores lightweight real-time state synchronization, API design, location data flow, and edge-hosted application architecture. For a production system, the next priorities would be tests, authentication, abuse controls, data retention policies, and failure handling.
