import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { LngLatLike, Map, Marker } from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type Role = "rider" | "driver";

type Coordinates = { lat: number; lng: number };

type RideState = {
  rideId: string;
  status: "requested" | "accepted" | "completed" | "cancelled";
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
  layers: [{ id: "osm", type: "raster", source: "osm" }]
};

function wsUrlForRide(rideId: string, role: Role) {
  const origin = API_BASE_URL.replace(/^http/, "ws");
  return `${origin}/ws/ride/${rideId}?role=${role}`;
}

function toLatLng(coords: Coordinates) {
  return `${coords.lat},${coords.lng}`;
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
  const [copied, setCopied] = useState(false);
  const [mapError, setMapError] = useState("");
  const [error, setError] = useState("");

  const mapRef = useRef<Map | null>(null);
  const mapRootRef = useRef<HTMLDivElement | null>(null);
  const riderMarkerRef = useRef<Marker | null>(null);
  const driverMarkerRef = useRef<Marker | null>(null);
  const destinationMarkerRef = useRef<Marker | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const riderWatchIdRef = useRef<number | null>(null);
  const driverWatchIdRef = useRef<number | null>(null);

  const center = useMemo<LngLatLike>(() => {
    if (driverLocation) return [driverLocation.lng, driverLocation.lat];
    if (destinationLocation) return [destinationLocation.lng, destinationLocation.lat];
    if (riderLocation) return [riderLocation.lng, riderLocation.lat];
    return [-97.0403, 32.8998];
  }, [driverLocation, destinationLocation, riderLocation]);

  const googleMapsLink = useMemo(() => {
    const params = new URLSearchParams({ api: "1", travelmode: "driving" });
    if (driverLocation) {
      params.set("origin", toLatLng(driverLocation));
      if (destinationLocation) {
        params.set("destination", toLatLng(destinationLocation));
        if (riderLocation) {
          params.set("waypoints", toLatLng(riderLocation));
        }
      } else if (riderLocation) {
        params.set("destination", toLatLng(riderLocation));
      } else {
        return "";
      }
      return `https://www.google.com/maps/dir/?${params.toString()}`;
    }

    if (riderLocation && destinationLocation) {
      params.set("origin", toLatLng(riderLocation));
      params.set("destination", toLatLng(destinationLocation));
      return `https://www.google.com/maps/dir/?${params.toString()}`;
    }

    if (riderLocation) {
      params.set("destination", toLatLng(riderLocation));
      return `https://www.google.com/maps/dir/?${params.toString()}`;
    }

    return "";
  }, [driverLocation, riderLocation, destinationLocation]);

  useEffect(() => {
    if (!mapRootRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapRootRef.current,
      style: MAP_STYLE,
      center,
      zoom: 11
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.on("error", () => setMapError("Map failed to load. Try refreshing once."));
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
    if (!rideId || status === "completed" || status === "cancelled") return;
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
    if (role === "rider") {
      beginRiderLocationBroadcast(rideId || undefined);
    }
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

  async function createRide() {
    try {
      setError("");
      if (!riderLocation) {
        setError("Set rider current location first.");
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
      beginRiderLocationBroadcast(response.rideId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function acceptRide() {
    try {
      setError("");
      let targetRideId = rideId.trim();
      if (!targetRideId) {
        const next = await requestJSON<{ rideId: string; status: string }>(
          "/rides/accept-next",
          { method: "POST" }
        );
        targetRideId = next.rideId;
        setRideId(targetRideId);
      } else {
        await requestJSON(`/rides/${targetRideId}/accept`, {
          method: "POST"
        });
      }
      setStatus("accepted");
      connectRideSocket(targetRideId, "driver");
      beginDriverLocationBroadcast(targetRideId);
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
      stopLocationSharing();
      socketRef.current?.close();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function cancelRide() {
    try {
      if (!rideId) return;
      await requestJSON(`/rides/${rideId}/cancel`, {
        method: "POST"
      });
      setStatus("cancelled");
      stopLocationSharing();
      socketRef.current?.close();
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
        | { type: "driver_location"; payload: { lat: number; lng: number } }
        | { type: "rider_location"; payload: { lat: number; lng: number } };
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
      if (message.type === "rider_location") {
        setRiderLocation(message.payload);
      }
    };
    socket.onerror = () => setError("Realtime socket error.");
    socketRef.current = socket;
  }

  function beginRiderLocationBroadcast(targetRideId?: string) {
    if (!navigator.geolocation) return;
    if (riderWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(riderWatchIdRef.current);
    }
    riderWatchIdRef.current = navigator.geolocation.watchPosition(
      async (position) => {
        const coords = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };
        setRiderLocation(coords);
        if (!targetRideId) return;
        try {
          await requestJSON(`/rides/${targetRideId}/rider-location`, {
            method: "POST",
            body: JSON.stringify(coords)
          });
        } catch {
          // Non-fatal and retried by next location update.
        }
      },
      () => setError("Unable to watch rider location."),
      { enableHighAccuracy: true, maximumAge: 5_000 }
    );
  }

  function beginDriverLocationBroadcast(targetRideId: string) {
    if (!navigator.geolocation) return;
    if (driverWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(driverWatchIdRef.current);
    }
    driverWatchIdRef.current = navigator.geolocation.watchPosition(
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

  function stopLocationSharing() {
    if (!navigator.geolocation) return;
    if (riderWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(riderWatchIdRef.current);
      riderWatchIdRef.current = null;
    }
    if (driverWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(driverWatchIdRef.current);
      driverWatchIdRef.current = null;
    }
  }

  async function copyGoogleMapsLink() {
    if (!googleMapsLink) return;
    try {
      await navigator.clipboard.writeText(googleMapsLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Unable to copy link.");
    }
  }

  useEffect(() => {
    if (role === "rider" && rideId && status === "accepted") {
      beginRiderLocationBroadcast(rideId);
    }
  }, [role, rideId, status]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      stopLocationSharing();
    };
  }, []);

  return (
    <div className="container">
      <div className="panel hero">
        <div>
          <h1>Yatriso</h1>
          <p>No-signup ride booking with live tracking and fast dispatch for work and college rides.</p>
        </div>
        <div className="row controls-row">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            aria-label="Select role"
          >
            <option value="rider">Rider</option>
            <option value="driver">Driver</option>
          </select>
          <span className={`pill status-${status}`}>{status}</span>
          {rideId ? <span className="pill">Ride: {rideId}</span> : null}
        </div>
      </div>

      <div className="panel">
        {role === "rider" ? (
          <div className="row controls-row">
            <button onClick={useBrowserLocation}>Use my location</button>
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
            <button className="button-secondary" onClick={cancelRide} disabled={!rideId}>
              Cancel ride
            </button>
          </div>
        ) : (
          <div className="row controls-row">
            <button onClick={acceptRide}>Accept next ride</button>
            <button onClick={completeRide}>Complete ride</button>
            <button className="button-secondary" onClick={cancelRide} disabled={!rideId}>
              Cancel ride
            </button>
          </div>
        )}
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Rider</div>
            <div className="stat-value">
              {riderLocation ? `${riderLocation.lat.toFixed(5)}, ${riderLocation.lng.toFixed(5)}` : "n/a"}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Driver</div>
            <div className="stat-value">
              {driverLocation ? `${driverLocation.lat.toFixed(5)}, ${driverLocation.lng.toFixed(5)}` : "n/a"}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Destination</div>
            <div className="stat-value">
              {destinationLocation
                ? `${destinationLocation.lat.toFixed(5)}, ${destinationLocation.lng.toFixed(5)}`
                : "n/a"}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Driver ETA</div>
            <div className="stat-value">{etaMinutes !== null ? `${etaMinutes} min` : "n/a"}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Trip Distance</div>
            <div className="stat-value">
              {distanceMeters !== null ? `${(distanceMeters / 1000).toFixed(1)} km` : "n/a"}
            </div>
          </div>
        </div>
        {geocodeOptions.length > 0 ? (
          <div className="meta">
            Matches:{" "}
            {geocodeOptions.slice(0, 3).map((item) => item.label).join(" | ")}
          </div>
        ) : null}
        {googleMapsLink ? (
          <div className="share-row">
            <a className="maps-link" href={googleMapsLink} target="_blank" rel="noreferrer">
              Open live Google Maps route
            </a>
            <button className="button-secondary" onClick={copyGoogleMapsLink}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        ) : null}
        {error ? <div className="meta">Error: {error}</div> : null}
      </div>

      <div className="map" ref={mapRootRef} />
      {mapError ? <div className="meta">{mapError}</div> : null}
      <footer className="footer">
        <span>Yatriso</span>
        <span>Live rides for college and work travelers</span>
      </footer>
    </div>
  );
}

export default App;
