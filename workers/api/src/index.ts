export interface Env {
  RIDE_ROOM: DurableObjectNamespace;
}

type Coordinates = {
  lat: number;
  lng: number;
};

type RideState = {
  rideId: string;
  status: "requested" | "accepted" | "completed";
  riderLocation: Coordinates | null;
  driverLocation: Coordinates | null;
  destinationLocation: Coordinates | null;
  destinationText: string;
  createdAt: string;
  expiresAt: string;
};

type SocketRole = "rider" | "driver";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...(init.headers ?? {})
    }
  });
}

function roomStub(env: Env, rideId: string) {
  const id = env.RIDE_ROOM.idFromName(rideId);
  return env.RIDE_ROOM.get(id);
}

function parseCoordinate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function oneDecimalMinutes(seconds: number) {
  return Math.round((seconds / 60) * 10) / 10;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "POST" && url.pathname === "/rides") {
      const payload = (await request.json()) as {
        riderLocation: Coordinates;
        destinationText: string;
        destinationLocation: Coordinates | null;
      };
      const rideId = crypto.randomUUID().slice(0, 8);
      const stub = roomStub(env, rideId);
      await stub.fetch("https://room/init", {
        method: "POST",
        body: JSON.stringify({
          rideId,
          status: "requested",
          riderLocation: payload.riderLocation ?? null,
          driverLocation: null,
          destinationLocation: payload.destinationLocation ?? null,
          destinationText: payload.destinationText ?? "",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
        })
      });
      return json({ rideId, status: "requested" });
    }

    const acceptMatch = url.pathname.match(/^\/rides\/([^/]+)\/accept$/);
    if (request.method === "POST" && acceptMatch) {
      const rideId = acceptMatch[1];
      const stub = roomStub(env, rideId);
      return stub.fetch("https://room/accept", { method: "POST" });
    }

    const locationMatch = url.pathname.match(/^\/rides\/([^/]+)\/location$/);
    if (request.method === "POST" && locationMatch) {
      const rideId = locationMatch[1];
      const stub = roomStub(env, rideId);
      const body = (await request.json()) as Coordinates;
      return stub.fetch("https://room/location", {
        method: "POST",
        body: JSON.stringify(body)
      });
    }

    const readMatch = url.pathname.match(/^\/rides\/([^/]+)$/);
    if (request.method === "GET" && readMatch) {
      const rideId = readMatch[1];
      const stub = roomStub(env, rideId);
      return stub.fetch("https://room/state");
    }

    const completeMatch = url.pathname.match(/^\/rides\/([^/]+)\/complete$/);
    if (request.method === "POST" && completeMatch) {
      const rideId = completeMatch[1];
      const stub = roomStub(env, rideId);
      return stub.fetch("https://room/complete", { method: "POST" });
    }

    const wsMatch = url.pathname.match(/^\/ws\/ride\/([^/]+)$/);
    if (request.method === "GET" && wsMatch) {
      const rideId = wsMatch[1];
      const role = (url.searchParams.get("role") as SocketRole | null) ?? "rider";
      const stub = roomStub(env, rideId);
      return stub.fetch(`https://room/ws?role=${role}`, request);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/geocode") {
      const q = url.searchParams.get("q")?.trim();
      if (!q) {
        return json({ error: "missing_query" }, { status: 400 });
      }
      const nominatimURL = new URL("https://nominatim.openstreetmap.org/search");
      nominatimURL.searchParams.set("q", q);
      nominatimURL.searchParams.set("format", "jsonv2");
      nominatimURL.searchParams.set("limit", "5");
      const nominatimRes = await fetch(nominatimURL, {
        headers: {
          "User-Agent": "Yatriso/0.1 (Cloudflare Worker Geocoder)"
        }
      });
      if (!nominatimRes.ok) {
        return json({ error: "geocoding_failed" }, { status: 502 });
      }
      const rows = (await nominatimRes.json()) as Array<{
        display_name: string;
        lat: string;
        lon: string;
      }>;
      return json({
        results: rows.map((row) => ({
          label: row.display_name,
          lat: Number(row.lat),
          lng: Number(row.lon)
        }))
      });
    }

    if (request.method === "GET" && url.pathname === "/eta") {
      const fromLat = parseCoordinate(url.searchParams.get("fromLat"));
      const fromLng = parseCoordinate(url.searchParams.get("fromLng"));
      const toLat = parseCoordinate(url.searchParams.get("toLat"));
      const toLng = parseCoordinate(url.searchParams.get("toLng"));
      if (fromLat === null || fromLng === null || toLat === null || toLng === null) {
        return json({ error: "missing_or_invalid_coordinates" }, { status: 400 });
      }
      const routeURL = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=simplified&geometries=geojson`;
      const routeRes = await fetch(routeURL);
      if (!routeRes.ok) {
        return json({ error: "routing_failed" }, { status: 502 });
      }
      const routeJSON = (await routeRes.json()) as {
        routes?: Array<{
          distance: number;
          duration: number;
          geometry: { coordinates: [number, number][] };
        }>;
      };
      const route = routeJSON.routes?.[0];
      if (!route) {
        return json({ error: "route_not_found" }, { status: 404 });
      }
      return json({
        distanceMeters: Math.round(route.distance),
        durationSeconds: Math.round(route.duration),
        etaMinutes: oneDecimalMinutes(route.duration),
        geometry: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
      });
    }

    return json({ error: "not_found" }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;

export class RideRoom {
  constructor(private readonly state: DurableObjectState) {}

  private stateData: RideState = {
    rideId: "",
    status: "requested",
    riderLocation: null,
    driverLocation: null,
    destinationLocation: null,
    destinationText: "",
    createdAt: "",
    expiresAt: ""
  };

  private sockets = new Set<WebSocket>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      const data = (await request.json()) as RideState;
      this.stateData = {
        ...this.stateData,
        ...data
      };
      void this.state.storage.setAlarm(Date.now() + 2 * 60 * 60 * 1000);
      return json(this.stateData);
    }

    if (request.method === "POST" && url.pathname === "/accept") {
      this.stateData.status = "accepted";
      this.broadcast({ type: "state", payload: this.stateData });
      return json(this.stateData);
    }

    if (request.method === "POST" && url.pathname === "/location") {
      const data = (await request.json()) as Coordinates;
      this.stateData.driverLocation = data;
      this.broadcast({ type: "driver_location", payload: data });
      this.broadcast({ type: "state", payload: this.stateData });
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/complete") {
      this.stateData.status = "completed";
      this.broadcast({ type: "state", payload: this.stateData });
      this.closeSockets();
      return json(this.stateData);
    }

    if (request.method === "GET" && url.pathname === "/state") {
      return json(this.stateData);
    }

    if (request.method === "GET" && url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      this.sockets.add(server);
      server.send(JSON.stringify({ type: "state", payload: this.stateData }));
      server.addEventListener("close", () => this.sockets.delete(server));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    if (this.stateData.status !== "completed") {
      this.stateData.status = "completed";
      this.broadcast({ type: "state", payload: this.stateData });
    }
    this.closeSockets();
  }

  private broadcast(message: unknown) {
    const payload = JSON.stringify(message);
    for (const socket of this.sockets) {
      try {
        socket.send(payload);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }

  private closeSockets() {
    for (const socket of this.sockets) {
      try {
        socket.close(1000, "ride_closed");
      } catch {
        // Ignore socket close errors.
      }
    }
    this.sockets.clear();
  }
}
