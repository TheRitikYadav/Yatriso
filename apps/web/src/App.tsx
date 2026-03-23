import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { LngLatLike, Map, Marker, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type Role = "rider" | "driver";

type Coordinates = { lat: number; lng: number };

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

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ??
  (typeof window !== "undefined" && window.location.hostname !== "localhost"
    ? "https://api.yatriso.com"
    : "http://127.0.0.1:8787");

const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors"
    }
  },
  layers: [
    {
      id: "osm",
      type: "raster",
      source: "osm"
    }
  ]
};

function wsUrlForRide(rideId: string, role: Role) {
  const origin = API_BASE_URL.replace(/^http/, "ws");
  return `${origin}/ws/ride/${rideId}?role=${role}`;
}

async function requestJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init
  });
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

async function fetchETA(from: Coordinates, to: Coordinates) {
  const params = new URLSearchParams({
    fromLat: String(from.lat),
    fromLng: String(from.lng),
    toLat: String(to.lat),
    toLng: String(to.lng)
  });
  return requestJSON<{
    distanceMeters: number;
    durationSeconds: number;
    etaMinutes: number;
    geometry: Coordinates[];
  }>(`/eta?${params.toString()}`);
}

function App() {
  const [role, setRole] = useState<Role>("rider");
  const [rideId, setRideId] = useState("");
  const [destinationText, setDestinationText] = useState("");
  const [destinationLocation, setDestinationLocation] = useState<Coordinates | null>(null);
  const [geocodeOptions, setGeocodeOptions] = useState<
    Array<{ label: string; lat: number; lng: number }>
  >([]);
  const [riderLocation, setRiderLocation] = useState<Coordinates | null>(null);
  const [driverLocation, setDriverLocation] = useState<Coordinates | null>(null);
  const [status, setStatus] = useState<RideState["status"]>("requested");
  const [distanceMeters, setDistanceMeters] = useState<number | null>(null);
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState("");

  const mapRef = useRef<Map | null>(null);
  const mapRootRef = useRef<HTMLDivElement | null>(null);
  const riderMarkerRef = useRef<Marker | null>(null);
  const driverMarkerRef = useRef<Marker | null>(null);
  const destinationMarkerRef = useRef<Marker | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const watchIdRef = useRef<number | null>(null);

  const center = useMemo<LngLatLike>(() => {
    if (driverLocation) return [driverLocation.lng, driverLocation.lat];
    if (destinationLocation) return [destinationLocation.lng, destinationLocation.lat];
    if (riderLocation) return [riderLocation.lng, riderLocation.lat];
    return [77.209, 28.6139];
  }, [driverLocation, destinationLocation, riderLocation]);

  useEffect(() => {
    if (!mapRootRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapRootRef.current,
      style: MAP_STYLE,
      center,
      zoom: 11
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.on("load", () => setMapReady(true));
    map.on("error", () => setError("Map failed to load. Please refresh the page."));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.flyTo({ center, zoom: 12, essential: true });
  }, [center]);

  useEffect(() => {
    if (!mapRef.current) return;
    if (riderLocation) {
      if (!riderMarkerRef.current) {
        riderMarkerRef.current = new maplibregl.Marker({ color: "#10b981" });
        riderMarkerRef.current.setPopup(
          new maplibregl.Popup().setText("Rider current location")
        );
      }
      riderMarkerRef.current
        .setLngLat([riderLocation.lng, riderLocation.lat])
        .addTo(mapRef.current);
    }
  }, [riderLocation]);

  useEffect(() => {
    if (!mapRef.current) return;
    if (driverLocation) {
      if (!driverMarkerRef.current) {
        driverMarkerRef.current = new maplibregl.Marker({ color: "#f59e0b" });
        driverMarkerRef.current.setPopup(
          new maplibregl.Popup().setText("Driver live location")
        );
      }
      driverMarkerRef.current
        .setLngLat([driverLocation.lng, driverLocation.lat])
        .addTo(mapRef.current);
    }
  }, [driverLocation]);

  useEffect(() => {
    if (!mapRef.current || !destinationLocation) return;
    if (!destinationMarkerRef.current) {
      destinationMarkerRef.current = new maplibregl.Marker({ color: "#6366f1" });
      destinationMarkerRef.current.setPopup(
        new maplibregl.Popup().setText("Destination")
      );
    }
    destinationMarkerRef.current
      .setLngLat([destinationLocation.lng, destinationLocation.lat])
      .addTo(mapRef.current);
  }, [destinationLocation]);

  useEffect(() => {
    let cancelled = false;
    if (!rideId || status === "completed") return;
    if (!riderLocation || !destinationLocation) return;
    const rider = riderLocation;
    const destination = destinationLocation;
    async function computeRiderTrip() {
      try {
        const eta = await fetchETA(rider, destination);
        if (cancelled) return;
        setDistanceMeters(eta.distanceMeters);
      } catch {
        // Keep UI alive when routing endpoint is temporarily unavailable.
      }
    }
    void computeRiderTrip();
    return () => {
      cancelled = true;
    };
  }, [rideId, status, riderLocation, destinationLocation]);

  useEffect(() => {
    let timer: number | undefined;
    if (!rideId || !riderLocation || !driverLocation || status !== "accepted") return;
    const rider = riderLocation;
    const driver = driverLocation;
    async function computeDriverETA() {
      try {
        const eta = await fetchETA(driver, rider);
        setEtaMinutes(eta.etaMinutes);
      } catch {
        // Non-fatal, ETA can be temporarily unknown.
      }
    }
    void computeDriverETA();
    timer = window.setInterval(() => void computeDriverETA(), 20_000);
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, [rideId, riderLocation, driverLocation, status]);

  async function useBrowserLocation() {
    setError("");
    if (!navigator.geolocation) {
      setError("Geolocation is not available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setRiderLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude
        });
      },
      () => setError("Unable to fetch your current location."),
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }

  async function geocodeDestination() {
    try {
      setError("");
      if (!destinationText.trim()) {
        setError("Enter destination address first.");
        return;
      }
      setLoading(true);
      const params = new URLSearchParams({ q: destinationText.trim() });
      const response = await requestJSON<{
        results: Array<{ label: string; lat: number; lng: number }>;
      }>(`/geocode?${params.toString()}`);
      setGeocodeOptions(response.results);
      if (response.results[0]) {
        setDestinationLocation({
          lat: response.results[0].lat,
          lng: response.results[0].lng
        });
      }
      if (!response.results.length) {
        setError("No matching destination found.");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function joinRide() {
    try {
      setError("");
      if (!rideId.trim()) {
        setError("Enter ride ID first.");
        return;
      }
      const state = await requestJSON<RideState>(`/rides/${rideId}`);
      setStatus(state.status);
      setRiderLocation(state.riderLocation);
      setDriverLocation(state.driverLocation);
      setDestinationText(state.destinationText);
      setDestinationLocation(state.destinationLocation);
      connectRideSocket(rideId, role);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function createRide() {
    try {
      setError("");
      if (!riderLocation) {
        setError("Set rider current location first.");
        return;
      }
      if (!destinationText.trim()) {
        setError("Add destination text before requesting ride.");
        return;
      }
      if (!destinationLocation) {
        setError("Geocode destination before requesting ride.");
        return;
      }
      setLoading(true);
      const response = await requestJSON<{ rideId: string; status: string }>(
        "/rides",
        {
          method: "POST",
          body: JSON.stringify({
            riderLocation,
            destinationText,
            destinationLocation
          })
        }
      );
      setRideId(response.rideId);
      setStatus("requested");
      connectRideSocket(response.rideId, "rider");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function acceptRide() {
    try {
      setError("");
      if (!rideId.trim()) {
        setError("Enter ride ID to accept.");
        return;
      }
      await requestJSON(`/rides/${rideId}/accept`, {
        method: "POST"
      });
      setStatus("accepted");
      connectRideSocket(rideId, "driver");
      beginDriverLocationBroadcast(rideId);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function completeRide() {
    try {
      if (!rideId) return;
      await requestJSON(`/rides/${rideId}/complete`, {
        method: "POST"
      });
      setStatus("completed");
      setEtaMinutes(null);
      socketRef.current?.close();
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function connectRideSocket(targetRideId: string, socketRole: Role) {
    socketRef.current?.close();
    const socket = new WebSocket(wsUrlForRide(targetRideId, socketRole));
    socket.onmessage = (evt) => {
      const message = JSON.parse(evt.data) as
        | { type: "state"; payload: RideState }
        | { type: "driver_location"; payload: { lat: number; lng: number } };
      if (message.type === "state") {
        setStatus(message.payload.status);
        setDriverLocation(message.payload.driverLocation);
        setRiderLocation(message.payload.riderLocation);
        setDestinationText(message.payload.destinationText);
        setDestinationLocation(message.payload.destinationLocation);
      }
      if (message.type === "driver_location") {
        setDriverLocation(message.payload);
      }
    };
    socket.onerror = () => setError("Realtime socket error.");
    socketRef.current = socket;
  }

  function beginDriverLocationBroadcast(targetRideId: string) {
    if (!navigator.geolocation) return;
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      async (position) => {
        const coords = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        setDriverLocation(coords);
        try {
          await requestJSON(`/rides/${targetRideId}/location`, {
            method: "POST",
            body: JSON.stringify(coords)
          });
        } catch {
          // Non-fatal: UI still has last local location.
        }
      },
      () => setError("Unable to watch driver location."),
      { enableHighAccuracy: true, maximumAge: 5_000 }
    );
  }

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  return (
    <div className="container">
      <div className="panel">
        <h1>Yatriso</h1>
        <p>No-signup ride booking with live driver tracking and ETA.</p>
        <div className="row">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            aria-label="Select role"
          >
            <option value="rider">Rider</option>
            <option value="driver">Driver</option>
          </select>
          <input
            value={rideId}
            onChange={(e) => setRideId(e.target.value)}
            placeholder="Ride ID"
          />
          <button onClick={joinRide}>Join</button>
          <span className={`status-chip status-${status}`}>{status}</span>
        </div>
      </div>

      <div className="panel">
        {role === "rider" ? (
          <div className="row">
            <button onClick={useBrowserLocation}>Use current location</button>
            <input
              value={destinationText}
              onChange={(e) => setDestinationText(e.target.value)}
              placeholder="Destination address"
            />
            <button onClick={geocodeDestination} disabled={loading}>
              {loading ? "Locating..." : "Locate destination"}
            </button>
            <button onClick={createRide} disabled={loading}>
              {loading ? "Requesting..." : "Request ride"}
            </button>
          </div>
        ) : (
          <div className="row">
            <button onClick={acceptRide}>Accept ride</button>
            <button onClick={completeRide}>Complete ride</button>
          </div>
        )}
        <div className="meta">
          Rider: {riderLocation ? `${riderLocation.lat}, ${riderLocation.lng}` : "n/a"} | Driver:{" "}
          {driverLocation ? `${driverLocation.lat}, ${driverLocation.lng}` : "n/a"}
        </div>
        <div className="meta">
          Destination: {destinationLocation ? `${destinationLocation.lat}, ${destinationLocation.lng}` : "n/a"}
        </div>
        <div className="meta">
          Driver ETA to pickup: {etaMinutes !== null ? `${etaMinutes} min` : "n/a"} | Rider trip distance:{" "}
          {distanceMeters !== null ? `${(distanceMeters / 1000).toFixed(1)} km` : "n/a"}
        </div>
        {geocodeOptions.length > 0 ? (
          <div className="meta">
            Matches:{" "}
            {geocodeOptions.slice(0, 3).map((item) => item.label).join(" | ")}
          </div>
        ) : null}
        {error ? <div className="meta">Error: {error}</div> : null}
      </div>

      {!mapReady ? (
        <div className="meta">Loading map...</div>
      ) : null}
      <div className="map" ref={mapRootRef} />
    </div>
  );
}

export default App;
