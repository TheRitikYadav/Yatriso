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
  driverId: string | null;
  driverName: string | null;
  destinationLocation: Coordinates | null;
  destinationText: string;
  createdAt: string;
  expiresAt: string;
};

type OpenRide = {
  rideId: string;
  requestedAt: string;
  expiresAt: string;
  destinationText: string;
  status: RideState["status"];
};

type Screen =
  | "role-select"
  | "location-permission"
  | "rider-destination"
  | "rider-searching"
  | "rider-active"
  | "driver-available"
  | "driver-active"
  | "ride-done";

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
    let message = `Request failed: ${res.status}`;
    try {
      const payload = (await res.json()) as { error?: string; rideId?: string };
      if (payload.error === "driver_busy" && payload.rideId) {
        message = `driver_busy:${payload.rideId}`;
      } else if (payload.error) {
        message = payload.error;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
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

async function fetchLocationName(coords: Coordinates) {
  const params = new URLSearchParams({ lat: String(coords.lat), lng: String(coords.lng) });
  const response = await requestJSON<{ label: string }>(`/reverse-geocode?${params.toString()}`);
  return response.label;
}

function locationKey(coords: Coordinates | null) {
  if (!coords) return "";
  return `${coords.lat.toFixed(3)},${coords.lng.toFixed(3)}`;
}

type DriverProfile = { id: string; name: string };

function getOrCreateDriverProfile(): DriverProfile {
  const cached = localStorage.getItem("yatriso_driver_profile");
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as DriverProfile;
      if (parsed.id && parsed.name) return parsed;
    } catch {
      // ignore
    }
  }
  const profile = {
    id: crypto.randomUUID().slice(0, 8),
    name: `Driver-${Math.floor(Math.random() * 900 + 100)}`
  };
  localStorage.setItem("yatriso_driver_profile", JSON.stringify(profile));
  return profile;
}

function formatClock(iso: string) {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "Unknown";
  return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function minutesLeft(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  return Math.max(0, Math.ceil(ms / 60000));
}

function App() {
  const [role, setRole] = useState<Role | null>(null);
  const [rideId, setRideId] = useState("");
  const [destinationText, setDestinationText] = useState("");
  const [destinationLocation, setDestinationLocation] = useState<Coordinates | null>(null);
  const [destinationName, setDestinationName] = useState("Not set");
  const [geocodeOptions, setGeocodeOptions] = useState<Array<{ label: string; lat: number; lng: number }>>([]);
  const [riderLocation, setRiderLocation] = useState<Coordinates | null>(null);
  const [riderLocationName, setRiderLocationName] = useState("Fetching...");
  const [driverLocation, setDriverLocation] = useState<Coordinates | null>(null);
  const [driverLocationName, setDriverLocationName] = useState("Waiting for driver");
  const [assignedDriverName, setAssignedDriverName] = useState("");
  const [driverProfile, setDriverProfile] = useState<DriverProfile | null>(null);
  const [openRides, setOpenRides] = useState<OpenRide[]>([]);
  const [openRidesLoading, setOpenRidesLoading] = useState(false);
  const [status, setStatus] = useState<RideState["status"]>("requested");
  const [distanceMeters, setDistanceMeters] = useState<number | null>(null);
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [requestedAt, setRequestedAt] = useState("");
  const [locationGranted, setLocationGranted] = useState(false);

  const mapRef = useRef<Map | null>(null);
  const mapRootRef = useRef<HTMLDivElement | null>(null);
  const riderMarkerRef = useRef<Marker | null>(null);
  const driverMarkerRef = useRef<Marker | null>(null);
  const destinationMarkerRef = useRef<Marker | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const riderWatchIdRef = useRef<number | null>(null);
  const driverWatchIdRef = useRef<number | null>(null);
  // Track highest committed status so WebSocket can never downgrade the screen.
  const statusOrderRef = useRef<Record<RideState["status"], number>>({
    requested: 0,
    accepted: 1,
    completed: 2,
    cancelled: 2
  });
  const committedStatusRef = useRef<RideState["status"]>("requested");

  const hasRequiredLocation = role === "rider" ? locationGranted && Boolean(riderLocation) : role === "driver" ? locationGranted && Boolean(driverLocation) : false;

  const screen: Screen = useMemo((): Screen => {
    if (!role) return "role-select";
    if (!hasRequiredLocation) return "location-permission";
    if (role === "rider") {
      if (!rideId) return "rider-destination";
      if (status === "requested") return "rider-searching";
      if (status === "accepted") return "rider-active";
      return "ride-done";
    } else {
      if (status === "accepted" && rideId) return "driver-active";
      if (status === "completed" || status === "cancelled") return "ride-done";
      return "driver-available";
    }
  }, [role, hasRequiredLocation, rideId, status]);

  const showMap = screen === "rider-active" || screen === "driver-active";

  const mapCenter = useMemo<LngLatLike>(() => {
    if (driverLocation) return [driverLocation.lng, driverLocation.lat];
    if (riderLocation) return [riderLocation.lng, riderLocation.lat];
    if (destinationLocation) return [destinationLocation.lng, destinationLocation.lat];
    return [-97.0403, 32.8998];
  }, [driverLocation, riderLocation, destinationLocation]);

  const googleMapsLink = useMemo(() => {
    const params = new URLSearchParams({ api: "1", travelmode: "driving" });
    if (driverLocation) {
      params.set("origin", toLatLng(driverLocation));
      if (destinationLocation) {
        params.set("destination", toLatLng(destinationLocation));
        if (riderLocation) params.set("waypoints", toLatLng(riderLocation));
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
    return "";
  }, [driverLocation, riderLocation, destinationLocation]);

  // ── Restore session ──────────────────────────────────────────────────────────

  async function restoreRideFromSession(targetRole: Role, targetRideId: string) {
    try {
      const state = await requestJSON<RideState>(`/rides/${targetRideId}`);
      setRideId(state.rideId);
      setStatus(state.status);
      setRequestedAt(state.createdAt || "");
      setRiderLocation(state.riderLocation);
      setDriverLocation(state.driverLocation);
      setDestinationText(state.destinationText);
      setDestinationLocation(state.destinationLocation);
      setAssignedDriverName(state.driverName ?? "");
      connectRideSocket(state.rideId, targetRole);
      if (targetRole === "rider") beginRiderLocationBroadcast(state.rideId);
      else if (state.status === "accepted") beginDriverLocationBroadcast(state.rideId);
    } catch {
      // stale session
    }
  }

  async function loadOpenRides() {
    if (role !== "driver") return;
    try {
      setOpenRidesLoading(true);
      const response = await requestJSON<{ rides: OpenRide[] }>("/rides/open");
      setOpenRides(response.rides);
    } catch {
      setOpenRides([]);
    } finally {
      setOpenRidesLoading(false);
    }
  }

  // ── Init effects ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const cachedRole = localStorage.getItem("yatriso_role");
    if (cachedRole === "rider" || cachedRole === "driver") setRole(cachedRole);
  }, []);

  useEffect(() => {
    if (!role) return;
    localStorage.setItem("yatriso_role", role);
    if (role === "driver") {
      setDriverProfile(getOrCreateDriverProfile());
    } else {
      setDriverProfile(null);
    }
  }, [role]);

  useEffect(() => {
    if (!role) return;
    const key = `yatriso_active_ride_${role}`;
    const cachedRideId = localStorage.getItem(key);
    if (!cachedRideId) return;
    void restoreRideFromSession(role, cachedRideId);
  }, [role]);

  useEffect(() => {
    if (!role) return;
    const key = `yatriso_active_ride_${role}`;
    if (rideId && status !== "completed" && status !== "cancelled") {
      localStorage.setItem(key, rideId);
    } else {
      localStorage.removeItem(key);
    }
  }, [role, rideId, status]);

  // ── Map lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!showMap) return;
    if (!mapRootRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapRootRef.current,
      style: MAP_STYLE,
      center: mapCenter,
      zoom: 12
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [showMap]);

  useEffect(() => {
    if (!mapRef.current || !showMap) return;
    mapRef.current.flyTo({ center: mapCenter, zoom: 13, essential: true });
  }, [mapCenter, showMap]);

  useEffect(() => {
    if (!mapRef.current || !riderLocation) return;
    if (!riderMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "marker-rider";
      riderMarkerRef.current = new maplibregl.Marker({ element: el });
      riderMarkerRef.current.setPopup(new maplibregl.Popup().setText("Pickup location"));
    }
    riderMarkerRef.current.setLngLat([riderLocation.lng, riderLocation.lat]).addTo(mapRef.current);
  }, [riderLocation, showMap]);

  useEffect(() => {
    if (!mapRef.current || !driverLocation) return;
    if (!driverMarkerRef.current) {
      driverMarkerRef.current = new maplibregl.Marker({ color: "#f59e0b" });
      driverMarkerRef.current.setPopup(new maplibregl.Popup().setText("Driver"));
    }
    driverMarkerRef.current.setLngLat([driverLocation.lng, driverLocation.lat]).addTo(mapRef.current);
  }, [driverLocation, showMap]);

  useEffect(() => {
    if (!mapRef.current || !destinationLocation) return;
    if (!destinationMarkerRef.current) {
      destinationMarkerRef.current = new maplibregl.Marker({ color: "#6366f1" });
      destinationMarkerRef.current.setPopup(new maplibregl.Popup().setText("Destination"));
    }
    destinationMarkerRef.current.setLngLat([destinationLocation.lng, destinationLocation.lat]).addTo(mapRef.current);
  }, [destinationLocation, showMap]);

  // ── Location name lookups ─────────────────────────────────────────────────────

  useEffect(() => {
    const key = locationKey(riderLocation);
    if (!key) { setRiderLocationName("Fetching..."); return; }
    let cancelled = false;
    void fetchLocationName(riderLocation as Coordinates).then((label) => {
      if (!cancelled) setRiderLocationName(label);
    }).catch(() => {
      if (!cancelled) setRiderLocationName("Current location");
    });
    return () => { cancelled = true; };
  }, [riderLocation?.lat, riderLocation?.lng]);

  useEffect(() => {
    const key = locationKey(driverLocation);
    if (!key) { setDriverLocationName("Waiting for driver"); return; }
    let cancelled = false;
    void fetchLocationName(driverLocation as Coordinates).then((label) => {
      if (!cancelled) setDriverLocationName(label);
    }).catch(() => {
      if (!cancelled) setDriverLocationName("Driver nearby");
    });
    return () => { cancelled = true; };
  }, [driverLocation?.lat, driverLocation?.lng]);

  useEffect(() => {
    if (destinationText.trim()) { setDestinationName(destinationText.trim()); return; }
    const key = locationKey(destinationLocation);
    if (!key) { setDestinationName("Not set"); return; }
    let cancelled = false;
    void fetchLocationName(destinationLocation as Coordinates).then((label) => {
      if (!cancelled) setDestinationName(label);
    }).catch(() => {
      if (!cancelled) setDestinationName("Destination set");
    });
    return () => { cancelled = true; };
  }, [destinationText, destinationLocation?.lat, destinationLocation?.lng]);

  // ── ETA ───────────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    if (!rideId || status === "completed" || status === "cancelled") return;
    if (!riderLocation || !destinationLocation) return;
    const rider = riderLocation;
    const destination = destinationLocation;
    void (async () => {
      try {
        const eta = await fetchETA(rider, destination);
        if (!cancelled) setDistanceMeters(eta.distanceMeters);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [rideId, status, riderLocation, destinationLocation]);

  useEffect(() => {
    let timer: number | undefined;
    if (!rideId || !riderLocation || !driverLocation || status !== "accepted") return;
    const rider = riderLocation;
    const driver = driverLocation;
    const compute = async () => {
      try {
        const eta = await fetchETA(driver, rider);
        setEtaMinutes(eta.etaMinutes);
      } catch { /* non-fatal */ }
    };
    void compute();
    timer = window.setInterval(() => void compute(), 20_000);
    return () => { if (timer) window.clearInterval(timer); };
  }, [rideId, riderLocation, driverLocation, status]);

  // ── Open rides polling ────────────────────────────────────────────────────────

  useEffect(() => {
    if (role !== "driver" || !hasRequiredLocation || status === "accepted") {
      if (role !== "driver") setOpenRides([]);
      return;
    }
    void loadOpenRides();
    const timer = window.setInterval(() => void loadOpenRides(), 15000);
    return () => window.clearInterval(timer);
  }, [role, hasRequiredLocation, status]);

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

  // ── Action handlers ───────────────────────────────────────────────────────────

  async function grantLocation() {
    setError("");
    if (!navigator.geolocation) {
      setError("Geolocation is not available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coords = { lat: position.coords.latitude, lng: position.coords.longitude };
        if (role === "rider") {
          setRiderLocation(coords);
          beginRiderLocationBroadcast(undefined);
        } else {
          setDriverLocation(coords);
        }
        setLocationGranted(true);
      },
      () => setError("Location access denied. Please allow location in your browser settings."),
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }

  async function geocodeDestination() {
    try {
      setError("");
      if (!destinationText.trim()) { setError("Enter destination address first."); return; }
      setLoading(true);
      const params = new URLSearchParams({ q: destinationText.trim() });
      const response = await requestJSON<{ results: Array<{ label: string; lat: number; lng: number }> }>(`/geocode?${params.toString()}`);
      setGeocodeOptions(response.results);
      if (response.results[0]) {
        setDestinationLocation({ lat: response.results[0].lat, lng: response.results[0].lng });
        setDestinationName(response.results[0].label);
      }
      if (!response.results.length) setError("No matching destination found.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function createRide() {
    try {
      setError("");
      if (!riderLocation) { setError("Set your location first."); return; }
      if (!destinationLocation) { setError("Search and confirm a destination first."); return; }
      setLoading(true);
      const response = await requestJSON<{ rideId: string; status: string }>("/rides", {
        method: "POST",
        body: JSON.stringify({ riderLocation, destinationText, destinationLocation })
      });
      setRideId(response.rideId);
      setStatus("requested");
      setRequestedAt(new Date().toISOString());
      setAssignedDriverName("");
      connectRideSocket(response.rideId, "rider");
      beginRiderLocationBroadcast(response.rideId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function acceptRide(selectedRideId?: string) {
    if (accepting) return;
    try {
      setError("");
      setAccepting(true);
      if (!driverLocation) { setError("Share your location first."); return; }
      if (!driverProfile) { setError("Driver profile not ready. Change role to driver again."); return; }
      let targetRideId = selectedRideId?.trim() || "";
      if (!targetRideId) {
        const next = await requestJSON<{ rideId: string }>("/rides/accept-next", {
          method: "POST",
          body: JSON.stringify({ driverId: driverProfile.id, driverName: driverProfile.name })
        });
        targetRideId = next.rideId;
      } else {
        await requestJSON(`/rides/${targetRideId}/accept`, {
          method: "POST",
          body: JSON.stringify({ driverId: driverProfile.id, driverName: driverProfile.name })
        });
      }
      committedStatusRef.current = "accepted";
      setRideId(targetRideId);
      setStatus("accepted");
      setOpenRides([]);
      setAssignedDriverName(driverProfile.name);
      connectRideSocket(targetRideId, "driver");
      beginDriverLocationBroadcast(targetRideId);
    } catch (err) {
      const message = (err as Error).message;
      if (message.startsWith("driver_busy:")) {
        const existingRideId = message.split(":")[1];
        committedStatusRef.current = "accepted";
        setRideId(existingRideId);
        setStatus("accepted");
        connectRideSocket(existingRideId, "driver");
        beginDriverLocationBroadcast(existingRideId);
        return;
      }
      setError(message);
    } finally {
      setAccepting(false);
    }
  }

  async function completeRide() {
    try {
      if (!rideId) return;
      await requestJSON(`/rides/${rideId}/complete`, { method: "POST" });
      committedStatusRef.current = "completed";
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
      await requestJSON(`/rides/${rideId}/cancel`, { method: "POST" });
      committedStatusRef.current = "cancelled";
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
        | { type: "driver_location"; payload: Coordinates }
        | { type: "rider_location"; payload: Coordinates };
      if (message.type === "state") {
        // Only advance status, never downgrade (prevents race where the
        // server's initial-connect state arrives after local accept/complete).
        const incoming = statusOrderRef.current[message.payload.status] ?? 0;
        const committed = statusOrderRef.current[committedStatusRef.current] ?? 0;
        if (incoming >= committed) {
          committedStatusRef.current = message.payload.status;
          setStatus(message.payload.status);
        }
        setRequestedAt(message.payload.createdAt || "");
        setDriverLocation(message.payload.driverLocation);
        setRiderLocation(message.payload.riderLocation);
        setDestinationText(message.payload.destinationText);
        setDestinationLocation(message.payload.destinationLocation);
        setDestinationName(message.payload.destinationText || "Destination");
        setAssignedDriverName(message.payload.driverName ?? "");
      }
      if (message.type === "driver_location") setDriverLocation(message.payload);
      if (message.type === "rider_location") setRiderLocation(message.payload);
    };
    socketRef.current = socket;
  }

  function beginRiderLocationBroadcast(targetRideId?: string) {
    if (!navigator.geolocation) return;
    if (riderWatchIdRef.current !== null) navigator.geolocation.clearWatch(riderWatchIdRef.current);
    riderWatchIdRef.current = navigator.geolocation.watchPosition(
      async (position) => {
        const coords = { lat: position.coords.latitude, lng: position.coords.longitude };
        setRiderLocation(coords);
        if (!targetRideId) return;
        try {
          await requestJSON(`/rides/${targetRideId}/rider-location`, { method: "POST", body: JSON.stringify(coords) });
        } catch { /* non-fatal */ }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5_000 }
    );
  }

  function beginDriverLocationBroadcast(targetRideId: string) {
    if (!navigator.geolocation) return;
    if (driverWatchIdRef.current !== null) navigator.geolocation.clearWatch(driverWatchIdRef.current);
    driverWatchIdRef.current = navigator.geolocation.watchPosition(
      async (position) => {
        const coords = { lat: position.coords.latitude, lng: position.coords.longitude };
        setDriverLocation(coords);
        try {
          await requestJSON(`/rides/${targetRideId}/location`, { method: "POST", body: JSON.stringify(coords) });
        } catch { /* non-fatal */ }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5_000 }
    );
  }

  function stopLocationSharing() {
    if (!navigator.geolocation) return;
    if (riderWatchIdRef.current !== null) { navigator.geolocation.clearWatch(riderWatchIdRef.current); riderWatchIdRef.current = null; }
    if (driverWatchIdRef.current !== null) { navigator.geolocation.clearWatch(driverWatchIdRef.current); driverWatchIdRef.current = null; }
  }

  async function copyGoogleMapsLink() {
    if (!googleMapsLink) return;
    try {
      await navigator.clipboard.writeText(googleMapsLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch { setError("Unable to copy link."); }
  }

  function resetToStart() {
    setRideId("");
    setStatus("requested");
    setAssignedDriverName("");
    setDriverLocation(null);
    setDestinationText("");
    setDestinationLocation(null);
    setDestinationName("Not set");
    setGeocodeOptions([]);
    setEtaMinutes(null);
    setDistanceMeters(null);
    setRequestedAt("");
    setError("");
    socketRef.current?.close();
    stopLocationSharing();
  }

  // ── Render helpers ───────────────────────────────────────────────────────────

  function renderRoleSelect() {
    return (
      <div className="fullscreen-page">
        <div className="brand-mark">Y</div>
        <h1 className="brand-title">Yatriso</h1>
        <p className="brand-sub">Instant rides for college &amp; work travelers</p>
        <div className="role-cards">
          <button className="role-card" onClick={() => setRole("rider")}>
            <span className="role-icon">🧳</span>
            <span className="role-name">I need a ride</span>
            <span className="role-desc">Find a driver going your way</span>
          </button>
          <button className="role-card" onClick={() => setRole("driver")}>
            <span className="role-icon">🚗</span>
            <span className="role-name">I'm a driver</span>
            <span className="role-desc">Pick up passengers nearby</span>
          </button>
        </div>
      </div>
    );
  }

  function renderLocationPermission() {
    return (
      <div className="fullscreen-page">
        <div className="perm-icon">📍</div>
        <h2 className="perm-title">Allow Location</h2>
        <p className="perm-desc">
          {role === "rider"
            ? "Yatriso needs your location to find nearby drivers and show them where to pick you up."
            : "Yatriso needs your location so riders can see where you are and track your arrival."}
        </p>
        {error ? <div className="error-box">{error}</div> : null}
        <button className="btn-primary btn-large" onClick={grantLocation}>
          Allow my location
        </button>
        <button className="btn-ghost" onClick={() => { setRole(null); setError(""); }}>
          ← Change role
        </button>
      </div>
    );
  }

  function renderRiderDestination() {
    return (
      <div className="app-page">
        <header className="app-header">
          <div className="header-role rider">Rider</div>
          <span className="header-location">📍 {riderLocationName}</span>
          <button className="btn-ghost-sm" onClick={() => { setRole(null); setLocationGranted(false); }}>Change</button>
        </header>
        <div className="destination-card">
          <div className="dest-from">
            <span className="dot dot-green" />
            <span>{riderLocationName}</span>
          </div>
          <div className="dest-divider" />
          <div className="dest-to">
            <span className="dot dot-purple" />
            <div className="dest-input-row">
              <input
                className="dest-input"
                value={destinationText}
                onChange={(e) => setDestinationText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void geocodeDestination()}
                placeholder="Where do you want to go?"
              />
              <button className="btn-icon" onClick={geocodeDestination} disabled={loading}>
                {loading ? "..." : "→"}
              </button>
            </div>
          </div>
          {geocodeOptions.length > 0 ? (
            <div className="geocode-results">
              {geocodeOptions.slice(0, 4).map((item) => (
                <button
                  key={`${item.lat},${item.lng}`}
                  className="geocode-item"
                  onClick={() => {
                    setDestinationLocation({ lat: item.lat, lng: item.lng });
                    setDestinationName(item.label);
                    setDestinationText(item.label);
                    setGeocodeOptions([]);
                  }}
                >
                  <span className="dot dot-purple dot-sm" />
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {destinationLocation ? (
          <div className="confirm-dest">
            <div className="confirm-dest-name">
              <strong>Going to:</strong> {destinationName}
            </div>
            <button className="btn-primary btn-large" onClick={createRide} disabled={loading}>
              {loading ? "Requesting..." : "Request Ride"}
            </button>
          </div>
        ) : null}
        {error ? <div className="error-box">{error}</div> : null}
      </div>
    );
  }

  function renderRiderSearching() {
    return (
      <div className="app-page">
        <header className="app-header">
          <div className="header-role rider">Rider</div>
          <button className="btn-ghost-sm" onClick={() => cancelRide().then(resetToStart)}>Cancel</button>
        </header>
        <div className="searching-card">
          <div className="pulse-ring">
            <div className="pulse-dot" />
          </div>
          <h2 className="searching-title">Finding your driver...</h2>
          <p className="searching-sub">Hang tight, a driver will accept your ride soon.</p>
          <div className="ride-summary">
            <div className="route-row">
              <span className="dot dot-green" />
              <div>
                <div className="route-label">Pickup</div>
                <div className="route-value">{riderLocationName}</div>
              </div>
            </div>
            <div className="route-line" />
            <div className="route-row">
              <span className="dot dot-purple" />
              <div>
                <div className="route-label">Destination</div>
                <div className="route-value">{destinationName}</div>
              </div>
            </div>
          </div>
          {distanceMeters ? (
            <div className="trip-meta">~{(distanceMeters / 1000).toFixed(1)} km trip</div>
          ) : null}
          {requestedAt ? (
            <div className="trip-meta muted">Requested at {formatClock(requestedAt)} · expires in {minutesLeft(new Date(new Date(requestedAt).getTime() + 45 * 60000).toISOString())} min</div>
          ) : null}
        </div>
        {error ? <div className="error-box">{error}</div> : null}
      </div>
    );
  }

  function renderRiderActive() {
    return (
      <div className="app-page map-page">
        <header className="app-header floating">
          <div className="header-role rider">Rider</div>
          <div className="status-chip accepted">Driver on the way</div>
          <button className="btn-ghost-sm danger" onClick={() => void cancelRide()}>Cancel ride</button>
        </header>
        <div className="map-fullscreen" ref={mapRootRef} />
        <div className="bottom-sheet">
          <div className="driver-info">
            <div className="driver-avatar">{assignedDriverName ? assignedDriverName[0] : "D"}</div>
            <div>
              <div className="driver-name">{assignedDriverName || "Your driver"}</div>
              <div className="driver-status">
                {etaMinutes !== null ? `Arriving in ${etaMinutes} min` : "Calculating ETA..."}
              </div>
            </div>
            <div className="eta-badge">{etaMinutes !== null ? `${etaMinutes} min` : "—"}</div>
          </div>
          <div className="route-summary">
            <div className="route-row">
              <span className="dot dot-green" />
              <div>
                <div className="route-label">Your location</div>
                <div className="route-value">{riderLocationName}</div>
              </div>
            </div>
            <div className="route-line" />
            <div className="route-row">
              <span className="dot dot-purple" />
              <div>
                <div className="route-label">Destination</div>
                <div className="route-value">{destinationName}</div>
              </div>
            </div>
          </div>
          {googleMapsLink ? (
            <div className="maps-row">
              <a className="btn-maps" href={googleMapsLink} target="_blank" rel="noreferrer">
                Open in Google Maps
              </a>
              <button className="btn-copy" onClick={copyGoogleMapsLink}>
                {copied ? "✓ Copied" : "Copy link"}
              </button>
            </div>
          ) : null}
          {error ? <div className="error-box">{error}</div> : null}
        </div>
      </div>
    );
  }

  function renderDriverAvailable() {
    return (
      <div className="app-page">
        <header className="app-header">
          <div className="header-role driver">Driver</div>
          <span className="header-location">📍 {driverLocationName}</span>
          <button className="btn-ghost-sm" onClick={() => { setRole(null); setLocationGranted(false); }}>Change</button>
        </header>
        {error ? <div className="error-box error-top">{error}</div> : null}
        <div className="rides-list-header">
          <h2 className="rides-title">Available Rides</h2>
          <button className="btn-refresh" onClick={() => void loadOpenRides()} disabled={openRidesLoading}>
            {openRidesLoading ? "..." : "↻"}
          </button>
        </div>
        {openRidesLoading && openRides.length === 0 ? (
          <div className="empty-state">
            <div className="empty-spinner" />
            <p>Loading rides...</p>
          </div>
        ) : openRides.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🔍</div>
            <p>No rides available right now.</p>
            <p className="muted">New requests appear automatically.</p>
          </div>
        ) : (
          <div className="rides-list">
            {openRides.map((ride) => (
              <div className="ride-card" key={ride.rideId}>
                <div className="ride-card-body">
                  <div className="route-row">
                    <span className="dot dot-purple" />
                    <div>
                      <div className="route-label">Destination</div>
                      <div className="route-value">{ride.destinationText || "Not specified"}</div>
                    </div>
                  </div>
                  <div className="ride-card-meta">
                    <span>Requested {formatClock(ride.requestedAt)}</span>
                    <span className={`expiry ${minutesLeft(ride.expiresAt) < 10 ? "expiry-urgent" : ""}`}>
                      Expires in {minutesLeft(ride.expiresAt)} min
                    </span>
                  </div>
                </div>
                <button
                  className="btn-accept"
                  onClick={() => void acceptRide(ride.rideId)}
                  disabled={accepting}
                >
                  {accepting ? "..." : "Accept"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderDriverActive() {
    return (
      <div className="app-page map-page">
        <header className="app-header floating">
          <div className="header-role driver">Driver</div>
          <div className="status-chip accepted">Active ride</div>
          <div className="header-actions">
            <button className="btn-complete" onClick={() => void completeRide()}>Complete</button>
            <button className="btn-ghost-sm danger" onClick={() => void cancelRide()}>Cancel</button>
          </div>
        </header>
        <div className="map-fullscreen" ref={mapRootRef} />
        <div className="bottom-sheet">
          <div className="route-summary">
            <div className="route-row">
              <span className="dot dot-green dot-lg" />
              <div>
                <div className="route-label">Pick up rider at</div>
                <div className="route-value strong">{riderLocationName}</div>
              </div>
            </div>
            <div className="route-line" />
            <div className="route-row">
              <span className="dot dot-purple dot-lg" />
              <div>
                <div className="route-label">Drop off at</div>
                <div className="route-value strong">{destinationName}</div>
              </div>
            </div>
          </div>
          {distanceMeters ? (
            <div className="trip-meta">~{(distanceMeters / 1000).toFixed(1)} km trip</div>
          ) : null}
          {googleMapsLink ? (
            <div className="maps-row">
              <a className="btn-maps" href={googleMapsLink} target="_blank" rel="noreferrer">
                Open in Google Maps
              </a>
              <button className="btn-copy" onClick={copyGoogleMapsLink}>
                {copied ? "✓ Copied" : "Copy link"}
              </button>
            </div>
          ) : null}
          {error ? <div className="error-box">{error}</div> : null}
        </div>
      </div>
    );
  }

  function renderRideDone() {
    const isCompleted = status === "completed";
    return (
      <div className="fullscreen-page">
        <div className="done-icon">{isCompleted ? "✅" : "❌"}</div>
        <h2 className="done-title">{isCompleted ? "Ride Complete" : "Ride Cancelled"}</h2>
        <p className="done-desc">
          {isCompleted
            ? (role === "rider" ? "You've arrived at your destination. Have a great day!" : "Ride completed. Great job!")
            : "This ride was cancelled."}
        </p>
        {distanceMeters && isCompleted ? (
          <div className="done-stat">{(distanceMeters / 1000).toFixed(1)} km trip</div>
        ) : null}
        {googleMapsLink && isCompleted ? (
          <div className="maps-row centered">
            <a className="btn-maps" href={googleMapsLink} target="_blank" rel="noreferrer">
              View route on Google Maps
            </a>
            <button className="btn-copy" onClick={copyGoogleMapsLink}>
              {copied ? "✓ Copied" : "Copy link"}
            </button>
          </div>
        ) : null}
        <button className="btn-primary btn-large" onClick={() => { resetToStart(); if (role === "rider") { /* stay as rider, go to destination screen */ } }}>
          {role === "rider" ? "Book another ride" : "Find next ride"}
        </button>
        <button className="btn-ghost" onClick={() => { resetToStart(); setRole(null); setLocationGranted(false); }}>
          Switch role
        </button>
      </div>
    );
  }

  // ── Root render ───────────────────────────────────────────────────────────────

  return (
    <div className="app-root">
      {screen === "role-select" && renderRoleSelect()}
      {screen === "location-permission" && renderLocationPermission()}
      {screen === "rider-destination" && renderRiderDestination()}
      {screen === "rider-searching" && renderRiderSearching()}
      {screen === "rider-active" && renderRiderActive()}
      {screen === "driver-available" && renderDriverAvailable()}
      {screen === "driver-active" && renderDriverActive()}
      {screen === "ride-done" && renderRideDone()}
    </div>
  );
}

export default App;
