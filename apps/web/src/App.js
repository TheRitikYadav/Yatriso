import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8787";
function wsUrlForRide(rideId, role) {
    const origin = API_BASE_URL.replace(/^http/, "ws");
    return `${origin}/ws/ride/${rideId}?role=${role}`;
}
async function requestJSON(path, init) {
    const res = await fetch(`${API_BASE_URL}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...init
    });
    if (!res.ok) {
        throw new Error(`Request failed: ${res.status}`);
    }
    return (await res.json());
}
function App() {
    const [role, setRole] = useState("rider");
    const [rideId, setRideId] = useState("");
    const [destinationText, setDestinationText] = useState("");
    const [riderLocation, setRiderLocation] = useState(null);
    const [driverLocation, setDriverLocation] = useState(null);
    const [status, setStatus] = useState("requested");
    const [error, setError] = useState("");
    const mapRef = useRef(null);
    const mapRootRef = useRef(null);
    const riderMarkerRef = useRef(null);
    const driverMarkerRef = useRef(null);
    const socketRef = useRef(null);
    const watchIdRef = useRef(null);
    const center = useMemo(() => {
        if (driverLocation)
            return [driverLocation.lng, driverLocation.lat];
        if (riderLocation)
            return [riderLocation.lng, riderLocation.lat];
        return [77.209, 28.6139];
    }, [driverLocation, riderLocation]);
    useEffect(() => {
        if (!mapRootRef.current || mapRef.current)
            return;
        const map = new maplibregl.Map({
            container: mapRootRef.current,
            style: "https://demotiles.maplibre.org/style.json",
            center,
            zoom: 11
        });
        map.addControl(new maplibregl.NavigationControl(), "top-right");
        mapRef.current = map;
        return () => map.remove();
    }, [center]);
    useEffect(() => {
        if (!mapRef.current)
            return;
        mapRef.current.flyTo({ center, zoom: 12, essential: true });
    }, [center]);
    useEffect(() => {
        if (!mapRef.current)
            return;
        if (riderLocation) {
            if (!riderMarkerRef.current) {
                riderMarkerRef.current = new maplibregl.Marker({ color: "#10b981" });
                riderMarkerRef.current.setPopup(new maplibregl.Popup().setText("Rider current location"));
            }
            riderMarkerRef.current
                .setLngLat([riderLocation.lng, riderLocation.lat])
                .addTo(mapRef.current);
        }
    }, [riderLocation]);
    useEffect(() => {
        if (!mapRef.current)
            return;
        if (driverLocation) {
            if (!driverMarkerRef.current) {
                driverMarkerRef.current = new maplibregl.Marker({ color: "#f59e0b" });
                driverMarkerRef.current.setPopup(new maplibregl.Popup().setText("Driver live location"));
            }
            driverMarkerRef.current
                .setLngLat([driverLocation.lng, driverLocation.lat])
                .addTo(mapRef.current);
        }
    }, [driverLocation]);
    async function useBrowserLocation() {
        setError("");
        if (!navigator.geolocation) {
            setError("Geolocation is not available in this browser.");
            return;
        }
        navigator.geolocation.getCurrentPosition((position) => {
            setRiderLocation({
                lat: position.coords.latitude,
                lng: position.coords.longitude
            });
        }, () => setError("Unable to fetch your current location."), { enableHighAccuracy: true, timeout: 10000 });
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
            const response = await requestJSON("/rides", {
                method: "POST",
                body: JSON.stringify({
                    riderLocation,
                    destinationText
                })
            });
            setRideId(response.rideId);
            setStatus("requested");
            connectRideSocket(response.rideId, "rider");
        }
        catch (err) {
            setError(err.message);
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
        }
        catch (err) {
            setError(err.message);
        }
    }
    function connectRideSocket(targetRideId, socketRole) {
        socketRef.current?.close();
        const socket = new WebSocket(wsUrlForRide(targetRideId, socketRole));
        socket.onmessage = (evt) => {
            const message = JSON.parse(evt.data);
            if (message.type === "state") {
                setStatus(message.payload.status);
                setDriverLocation(message.payload.driverLocation);
                setRiderLocation(message.payload.riderLocation);
            }
            if (message.type === "driver_location") {
                setDriverLocation(message.payload);
            }
        };
        socket.onerror = () => setError("Realtime socket error.");
        socketRef.current = socket;
    }
    function beginDriverLocationBroadcast(targetRideId) {
        if (!navigator.geolocation)
            return;
        if (watchIdRef.current !== null) {
            navigator.geolocation.clearWatch(watchIdRef.current);
        }
        watchIdRef.current = navigator.geolocation.watchPosition(async (position) => {
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
            }
            catch {
                // Non-fatal: UI still has last local location.
            }
        }, () => setError("Unable to watch driver location."), { enableHighAccuracy: true, maximumAge: 5000 });
    }
    useEffect(() => {
        return () => {
            socketRef.current?.close();
            if (watchIdRef.current !== null && navigator.geolocation) {
                navigator.geolocation.clearWatch(watchIdRef.current);
            }
        };
    }, []);
    return (_jsxs("div", { className: "container", children: [_jsxs("div", { className: "panel", children: [_jsx("h1", { children: "Yatriso" }), _jsx("p", { children: "No-signup, Cloudflare-first rider/driver foundation." }), _jsxs("div", { className: "row", children: [_jsxs("select", { value: role, onChange: (e) => setRole(e.target.value), "aria-label": "Select role", children: [_jsx("option", { value: "rider", children: "Rider" }), _jsx("option", { value: "driver", children: "Driver" })] }), _jsx("input", { value: rideId, onChange: (e) => setRideId(e.target.value), placeholder: "Ride ID" }), _jsx("span", { className: "pill", children: status })] })] }), _jsxs("div", { className: "panel", children: [role === "rider" ? (_jsxs("div", { className: "row", children: [_jsx("button", { onClick: useBrowserLocation, children: "Use current location" }), _jsx("input", { value: destinationText, onChange: (e) => setDestinationText(e.target.value), placeholder: "Destination address" }), _jsx("button", { onClick: createRide, children: "Request ride" })] })) : (_jsx("div", { className: "row", children: _jsx("button", { onClick: acceptRide, children: "Accept ride" }) })), _jsxs("div", { className: "meta", children: ["Rider: ", riderLocation ? `${riderLocation.lat}, ${riderLocation.lng}` : "n/a", " | Driver:", " ", driverLocation ? `${driverLocation.lat}, ${driverLocation.lng}` : "n/a"] }), error ? _jsxs("div", { className: "meta", children: ["Error: ", error] }) : null] }), _jsx("div", { className: "map", ref: mapRootRef })] }));
}
export default App;
