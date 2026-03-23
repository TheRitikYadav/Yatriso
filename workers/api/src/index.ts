export interface Env {
  RIDE_ROOM: DurableObjectNamespace;
  DISPATCH_HUB: DurableObjectNamespace;
}

type Coordinates = {
  lat: number;
  lng: number;
};

type RideState = {
  rideId: string;
  status: "requested" | "accepted" | "completed" | "cancelled";
  riderLocation: Coordinates | null;
  driverLocation: Coordinates | null;
  driverId: string | null;
  driverName: string | null;
  destinationLocation: Coordinates | null;
  destinationText: string;
  createdAt: string;
  expiresAt: string;
};

type OpenRideEntry = {
  rideId: string;
  requestedAt: string;
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

function dispatchStub(env: Env) {
  const id = env.DISPATCH_HUB.idFromName("global-dispatch");
  return env.DISPATCH_HUB.get(id);
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
          driverId: null,
          driverName: null,
          destinationLocation: payload.destinationLocation ?? null,
          destinationText: payload.destinationText ?? "",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString()
        })
      });
      await dispatchStub(env).fetch("https://dispatch/add-open", {
        method: "POST",
        body: JSON.stringify({
          rideId,
          requestedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString()
        })
      });
      return json({ rideId, status: "requested" });
    }

    const acceptMatch = url.pathname.match(/^\/rides\/([^/]+)\/accept$/);
    if (request.method === "POST" && acceptMatch) {
      const rideId = acceptMatch[1];
      const stub = roomStub(env, rideId);
      const payload = (await request.json().catch(() => ({}))) as {
        driverId?: string;
        driverName?: string;
      };
      if (payload.driverId) {
        const assign = await dispatchStub(env).fetch("https://dispatch/assign-driver", {
          method: "POST",
          body: JSON.stringify({ driverId: payload.driverId, rideId })
        });
        if (!assign.ok) return assign;
      }
      await dispatchStub(env).fetch("https://dispatch/remove-open", {
        method: "POST",
        body: JSON.stringify({ rideId })
      });
      return stub.fetch("https://room/accept", {
        method: "POST",
        body: JSON.stringify({
          driverId: payload.driverId ?? null,
          driverName: payload.driverName ?? null
        })
      });
    }

    if (request.method === "POST" && url.pathname === "/rides/accept-next") {
      const payload = (await request.json().catch(() => ({}))) as {
        driverId?: string;
        driverName?: string;
      };
      if (!payload.driverId) {
        return json({ error: "missing_driver_id" }, { status: 400 });
      }

      const assign = await dispatchStub(env).fetch("https://dispatch/assign-driver", {
        method: "POST",
        body: JSON.stringify({ driverId: payload.driverId, rideId: "pending" })
      });
      if (!assign.ok) return assign;

      const dispatch = dispatchStub(env);
      let rideId = "";
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const next = await dispatch.fetch("https://dispatch/next-open");
        if (!next.ok) {
          await dispatch.fetch("https://dispatch/release-driver", {
            method: "POST",
            body: JSON.stringify({ driverId: payload.driverId })
          });
          return next;
        }
        const nextData = (await next.json()) as { rideId: string };
        const candidateRideId = nextData.rideId;
        const candidateStateRes = await roomStub(env, candidateRideId).fetch("https://room/state");
        if (!candidateStateRes.ok) {
          continue;
        }
        const candidateState = (await candidateStateRes.json()) as RideState;
        if (candidateState.status !== "requested") {
          continue;
        }
        rideId = candidateRideId;
        break;
      }
      if (!rideId) {
        await dispatch.fetch("https://dispatch/release-driver", {
          method: "POST",
          body: JSON.stringify({ driverId: payload.driverId })
        });
        return json({ error: "no_open_rides" }, { status: 404 });
      }

      await dispatch.fetch("https://dispatch/assign-driver", {
        method: "POST",
        body: JSON.stringify({ driverId: payload.driverId, rideId })
      });

      const stub = roomStub(env, rideId);
      await stub.fetch("https://room/accept", {
        method: "POST",
        body: JSON.stringify({
          driverId: payload.driverId ?? null,
          driverName: payload.driverName ?? null
        })
      });
      return json({
        rideId,
        status: "accepted",
        driverName: payload.driverName ?? "Driver"
      });
    }

    if (request.method === "GET" && url.pathname === "/rides/open") {
      const dispatch = dispatchStub(env);
      const open = await dispatch.fetch("https://dispatch/open-rides");
      if (!open.ok) return open;
      const entries = (await open.json()) as { rides: OpenRideEntry[] };
      const rides: Array<{
        rideId: string;
        requestedAt: string;
        expiresAt: string;
        destinationText: string;
        status: RideState["status"];
      }> = [];
      for (const entry of entries.rides) {
        const stateRes = await roomStub(env, entry.rideId).fetch("https://room/state");
        if (!stateRes.ok) continue;
        const state = (await stateRes.json()) as RideState;
        if (state.status !== "requested") continue;
        rides.push({
          rideId: state.rideId,
          requestedAt: state.createdAt || entry.requestedAt,
          expiresAt: state.expiresAt || entry.expiresAt,
          destinationText: state.destinationText || "Destination not set",
          status: state.status
        });
      }
      return json({ rides });
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

    const riderLocationMatch = url.pathname.match(/^\/rides\/([^/]+)\/rider-location$/);
    if (request.method === "POST" && riderLocationMatch) {
      const rideId = riderLocationMatch[1];
      const stub = roomStub(env, rideId);
      const body = (await request.json()) as Coordinates;
      return stub.fetch("https://room/rider-location", {
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
      await dispatchStub(env).fetch("https://dispatch/remove-open", {
        method: "POST",
        body: JSON.stringify({ rideId })
      });
      await dispatchStub(env).fetch("https://dispatch/release-by-ride", {
        method: "POST",
        body: JSON.stringify({ rideId })
      });
      return stub.fetch("https://room/complete", { method: "POST" });
    }

    const cancelMatch = url.pathname.match(/^\/rides\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const rideId = cancelMatch[1];
      const stub = roomStub(env, rideId);
      await dispatchStub(env).fetch("https://dispatch/remove-open", {
        method: "POST",
        body: JSON.stringify({ rideId })
      });
      await dispatchStub(env).fetch("https://dispatch/release-by-ride", {
        method: "POST",
        body: JSON.stringify({ rideId })
      });
      return stub.fetch("https://room/cancel", { method: "POST" });
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

    if (request.method === "GET" && url.pathname === "/reverse-geocode") {
      const lat = parseCoordinate(url.searchParams.get("lat"));
      const lng = parseCoordinate(url.searchParams.get("lng"));
      if (lat === null || lng === null) {
        return json({ error: "missing_or_invalid_coordinates" }, { status: 400 });
      }
      const reverseURL = new URL("https://nominatim.openstreetmap.org/reverse");
      reverseURL.searchParams.set("format", "jsonv2");
      reverseURL.searchParams.set("lat", String(lat));
      reverseURL.searchParams.set("lon", String(lng));
      const reverseRes = await fetch(reverseURL, {
        headers: {
          "User-Agent": "Yatriso/0.1 (Cloudflare Worker Reverse Geocoder)"
        }
      });
      if (!reverseRes.ok) {
        return json({ error: "reverse_geocoding_failed" }, { status: 502 });
      }
      const payload = (await reverseRes.json()) as {
        display_name?: string;
      };
      return json({
        label: payload.display_name ?? "Unknown location"
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
    driverId: null,
    driverName: null,
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
      const alarmAt = Date.parse(this.stateData.expiresAt || "");
      void this.state.storage.setAlarm(Number.isNaN(alarmAt) ? Date.now() + 45 * 60 * 1000 : alarmAt);
      return json(this.stateData);
    }

    if (request.method === "POST" && url.pathname === "/accept") {
      const payload = (await request.json().catch(() => ({}))) as {
        driverId?: string | null;
        driverName?: string | null;
      };
      this.stateData.status = "accepted";
      this.stateData.driverId = payload.driverId ?? this.stateData.driverId;
      this.stateData.driverName = payload.driverName ?? this.stateData.driverName;
      this.stateData.expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      void this.state.storage.setAlarm(Date.now() + 2 * 60 * 60 * 1000);
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

    if (request.method === "POST" && url.pathname === "/rider-location") {
      const data = (await request.json()) as Coordinates;
      this.stateData.riderLocation = data;
      this.broadcast({ type: "rider_location", payload: data });
      this.broadcast({ type: "state", payload: this.stateData });
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/complete") {
      this.stateData.status = "completed";
      this.broadcast({ type: "state", payload: this.stateData });
      this.closeSockets();
      return json(this.stateData);
    }

    if (request.method === "POST" && url.pathname === "/cancel") {
      this.stateData.status = "cancelled";
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
    if (this.stateData.status === "requested") {
      this.stateData.status = "cancelled";
      this.broadcast({ type: "state", payload: this.stateData });
      this.closeSockets();
      return;
    }
    if (this.stateData.status !== "completed" && this.stateData.status !== "cancelled") {
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

export class DispatchHub {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/add-open") {
      const body = (await request.json()) as OpenRideEntry;
      const list = ((await this.state.storage.get("openRideEntries")) as OpenRideEntry[] | undefined) ?? [];
      if (!list.find((entry) => entry.rideId === body.rideId)) {
        list.push(body);
      }
      await this.state.storage.put("openRideEntries", list);
      return json({ ok: true, count: list.length });
    }

    if (request.method === "POST" && url.pathname === "/remove-open") {
      const body = (await request.json()) as { rideId: string };
      const list = ((await this.state.storage.get("openRideEntries")) as OpenRideEntry[] | undefined) ?? [];
      const nextList = list.filter((entry) => entry.rideId !== body.rideId);
      await this.state.storage.put("openRideEntries", nextList);
      return json({ ok: true, count: nextList.length });
    }

    if (request.method === "POST" && url.pathname === "/assign-driver") {
      const body = (await request.json()) as { driverId: string; rideId: string };
      const assignments =
        ((await this.state.storage.get("driverAssignments")) as Record<string, string> | undefined) ?? {};
      const existingRideId = assignments[body.driverId];
      if (existingRideId && existingRideId !== "pending" && existingRideId !== body.rideId) {
        return json({ error: "driver_busy", rideId: existingRideId }, { status: 409 });
      }
      assignments[body.driverId] = body.rideId;
      await this.state.storage.put("driverAssignments", assignments);
      return json({ ok: true, rideId: body.rideId });
    }

    if (request.method === "POST" && url.pathname === "/release-driver") {
      const body = (await request.json()) as { driverId: string };
      const assignments =
        ((await this.state.storage.get("driverAssignments")) as Record<string, string> | undefined) ?? {};
      delete assignments[body.driverId];
      await this.state.storage.put("driverAssignments", assignments);
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/release-by-ride") {
      const body = (await request.json()) as { rideId: string };
      const assignments =
        ((await this.state.storage.get("driverAssignments")) as Record<string, string> | undefined) ?? {};
      for (const [driverId, assignedRideId] of Object.entries(assignments)) {
        if (assignedRideId === body.rideId) {
          delete assignments[driverId];
        }
      }
      await this.state.storage.put("driverAssignments", assignments);
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/next-open") {
      const now = Date.now();
      const list = ((await this.state.storage.get("openRideEntries")) as OpenRideEntry[] | undefined) ?? [];
      const valid = list.filter((entry) => Date.parse(entry.expiresAt) > now);
      const next = valid.shift();
      if (!next) {
        await this.state.storage.put("openRideEntries", valid);
        return json({ error: "no_open_rides" }, { status: 404 });
      }
      await this.state.storage.put("openRideEntries", valid);
      return json({ rideId: next.rideId });
    }

    if (request.method === "GET" && url.pathname === "/open-rides") {
      const now = Date.now();
      const list = ((await this.state.storage.get("openRideEntries")) as OpenRideEntry[] | undefined) ?? [];
      const valid = list.filter((entry) => Date.parse(entry.expiresAt) > now);
      if (valid.length !== list.length) {
        await this.state.storage.put("openRideEntries", valid);
      }
      return json({ rides: valid });
    }

    return json({ error: "not_found" }, { status: 404 });
  }
}
