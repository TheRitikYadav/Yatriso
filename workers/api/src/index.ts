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
  destinationText: string;
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
      };
      const rideId = crypto.randomUUID().slice(0, 8);
      const stub = roomStub(env, rideId);
      await stub.fetch("https://room/init", {
        method: "POST",
        body: JSON.stringify({
          rideId,
          riderLocation: payload.riderLocation ?? null,
          destinationText: payload.destinationText ?? ""
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

    const wsMatch = url.pathname.match(/^\/ws\/ride\/([^/]+)$/);
    if (request.method === "GET" && wsMatch) {
      const rideId = wsMatch[1];
      const role = (url.searchParams.get("role") as SocketRole | null) ?? "rider";
      const stub = roomStub(env, rideId);
      return stub.fetch(`https://room/ws?role=${role}`, request);
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
    destinationText: ""
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
}
