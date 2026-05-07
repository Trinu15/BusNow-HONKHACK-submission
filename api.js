/**
 * BusNow — Transit API Integration Layer
 * 
 * Supports multiple data sources with automatic fallback:
 *   1. TSRTC Open API (Hyderabad city buses — primary)
 *   2. GTFS Realtime feed (standard format fallback)
 *   3. OpenStreetMap / Overpass (stop locations)
 *   4. Simulated mock pipeline (offline / demo mode)
 */

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  // Replace with actual TSRTC API key when available
  // Apply at: https://data.telangana.gov.in
  TSRTC_API_KEY: "YOUR_TSRTC_API_KEY",
  TSRTC_BASE:    "https://api.tsrtconline.in/v1",       // example endpoint
  GTFS_RT_FEED:  "https://otd.delhi.gov.in/api/realtime/VehiclePositions.pb", // example
  OSM_OVERPASS:  "https://overpass-api.de/api/interpreter",
  CACHE_TTL_MS:  15000,  // 15s cache — avoid hammering APIs on slow connections
};

// ─── In-memory cache ─────────────────────────────────────────────────────────
const cache = new Map(); // key → { data, timestamp }
function fromCache(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.timestamp < CONFIG.CACHE_TTL_MS) return hit.data;
  return null;
}
function toCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

// ─── 1. TSRTC Live Bus Positions ─────────────────────────────────────────────
/**
 * Fetch real-time bus positions from TSRTC.
 * Returns array of: { routeId, vehicleId, lat, lng, speed, lastUpdated }
 * 
 * NOTE: TSRTC does not have a fully public RT API yet.
 * When available, register at https://data.telangana.gov.in
 * and replace the mock below with the real fetch.
 */
async function fetchTSRTCPositions(routeIds = []) {
  const cacheKey = "tsrtc_" + routeIds.join(",");
  const cached = fromCache(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      api_key: CONFIG.TSRTC_API_KEY,
      routes: routeIds.join(","),
      format: "json"
    });
    const res = await fetch(`${CONFIG.TSRTC_BASE}/vehicle-positions?${params}`, {
      signal: AbortSignal.timeout(5000) // 5s timeout for low-data conditions
    });
    if (!res.ok) throw new Error("TSRTC API error: " + res.status);
    const json = await res.json();

    // Normalize to standard shape
    const positions = (json.vehicles || []).map(v => ({
      routeId:     v.route_id || v.routeNumber,
      vehicleId:   v.vehicle_id || v.busNumber,
      lat:         parseFloat(v.latitude),
      lng:         parseFloat(v.longitude),
      speed:       parseFloat(v.speed_kmh || 0),
      bearing:     parseFloat(v.bearing || 0),
      lastUpdated: new Date(v.timestamp || Date.now()),
      source:      "tsrtc"
    }));

    return toCache(cacheKey, positions);
  } catch (err) {
    console.warn("TSRTC API unavailable, falling back to mock:", err.message);
    return fetchMockPositions(routeIds);
  }
}

// ─── 2. GTFS Realtime Feed (Protocol Buffer) ─────────────────────────────────
/**
 * Parse a GTFS-RT VehiclePositions feed.
 * Uses protobuf.js from CDN. Works with any GTFS-compliant transit system.
 * 
 * To use: load protobuf.js first:
 *   <script src="https://cdn.jsdelivr.net/npm/protobufjs@7/dist/protobuf.min.js"></script>
 */
async function fetchGTFSRealtimePositions(feedUrl) {
  const cacheKey = "gtfs_" + feedUrl;
  const cached = fromCache(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error("GTFS RT fetch failed: " + res.status);

    // Decode protobuf binary
    const buffer = await res.arrayBuffer();
    // Requires gtfs-realtime.proto loaded into protobuf.js
    // In production: load proto definition from /data/gtfs-realtime.proto
    const FeedMessage = protobuf.roots.default?.lookup("transit_realtime.FeedMessage");
    if (!FeedMessage) throw new Error("Protobuf schema not loaded");

    const feed = FeedMessage.decode(new Uint8Array(buffer));
    const positions = feed.entity
      .filter(e => e.vehicle?.position)
      .map(e => ({
        routeId:     e.vehicle.trip?.routeId,
        vehicleId:   e.vehicle.vehicle?.id,
        lat:         e.vehicle.position.latitude,
        lng:         e.vehicle.position.longitude,
        speed:       (e.vehicle.position.speed || 0) * 3.6, // m/s → km/h
        bearing:     e.vehicle.position.bearing || 0,
        lastUpdated: new Date((e.vehicle.timestamp || 0) * 1000),
        source:      "gtfs-rt"
      }));

    return toCache(cacheKey, positions);
  } catch (err) {
    console.warn("GTFS RT unavailable:", err.message);
    return [];
  }
}

// ─── 3. OpenStreetMap — Find bus stops near a location ───────────────────────
/**
 * Query Overpass API for bus stops within radius of a coordinate.
 * No API key needed. Works globally.
 */
async function fetchNearbyStops(lat, lng, radiusMeters = 500) {
  const cacheKey = `stops_${lat.toFixed(3)}_${lng.toFixed(3)}_${radiusMeters}`;
  const cached = fromCache(cacheKey);
  if (cached) return cached;

  const query = `
    [out:json][timeout:10];
    node["highway"="bus_stop"](around:${radiusMeters},${lat},${lng});
    out body;
  `;

  try {
    const res = await fetch(CONFIG.OSM_OVERPASS, {
      method: "POST",
      body: "data=" + encodeURIComponent(query),
      signal: AbortSignal.timeout(8000)
    });
    const json = await res.json();

    const stops = (json.elements || []).map(el => ({
      id:      el.id,
      name:    el.tags?.name || el.tags?.["name:en"] || "Unnamed Stop",
      lat:     el.lat,
      lng:     el.lon,
      routes:  el.tags?.route_ref ? el.tags.route_ref.split(";") : [],
      source:  "osm"
    }));

    return toCache(cacheKey, stops);
  } catch (err) {
    console.warn("OSM Overpass unavailable:", err.message);
    return getMockStops(lat, lng);
  }
}

// ─── 4. Mock pipeline — offline / demo mode ───────────────────────────────────
/**
 * Simulates realistic GPS movement for demo/hackathon.
 * Each call slightly moves bus toward destination.
 */
const mockState = {
  "22":  { lat: 17.4312, lng: 78.4420, speed: 16, targetLat: 17.4374, targetLng: 78.4487 },
  "7X":  { lat: 17.4200, lng: 78.4580, speed: 7,  targetLat: 17.4374, targetLng: 78.4487 },
  "14":  { lat: 17.4455, lng: 78.4385, speed: 24, targetLat: 17.4374, targetLng: 78.4487 },
};

function fetchMockPositions(routeIds = []) {
  return routeIds.map(id => {
    const s = mockState[id];
    if (!s) return null;
    // Move bus 0.0005° toward stop each call (simulates motion)
    const dlat = (s.targetLat - s.lat);
    const dlng = (s.targetLng - s.lng);
    s.lat += dlat * 0.05;
    s.lng += dlng * 0.05;
    // Vary speed slightly
    s.speed = Math.max(5, s.speed + (Math.random() - 0.5) * 3);

    return {
      routeId:     id,
      vehicleId:   "MOCK-" + id,
      lat:         parseFloat(s.lat.toFixed(6)),
      lng:         parseFloat(s.lng.toFixed(6)),
      speed:       Math.round(s.speed),
      lastUpdated: new Date(),
      source:      "mock"
    };
  }).filter(Boolean);
}

function getMockStops(lat, lng) {
  return [
    { id: 1, name: "Ameerpet X Roads",  lat: 17.4374, lng: 78.4487, routes: ["22","7X","14","10","35"] },
    { id: 2, name: "SR Nagar",           lat: 17.4420, lng: 78.4390, routes: ["22","10"] },
    { id: 3, name: "Punjagutta",         lat: 17.4239, lng: 78.4738, routes: ["7X","14","35"] },
  ];
}

// ─── 5. WhatsApp-friendly text format (low-data / basic phone) ───────────────
/**
 * Formats predictions as plain SMS/WhatsApp text.
 * Under 160 chars per bus for basic phone compatibility.
 */
function formatForWhatsApp(predictions, stopName = "Your Stop") {
  const lines = [`🚌 BusNow @ ${stopName} — ${new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}\n`];
  predictions.forEach(p => {
    const eta = p.etaMinutes <= 0 ? "DUE NOW" : `${p.etaMinutes} min`;
    const status = p.status === 'delayed' ? `⚠ +${p.delayMinutes}m late` :
                   p.status === 'early'   ? `⚡ early` : `✅ on time`;
    lines.push(`Route ${p.routeId}: ${eta} | ${status} | Leave by ${p.leaveBy}`);
  });
  lines.push("\nPowered by BusNow — busnow.netlify.app");
  return lines.join("\n");
}

// ─── 6. Main data pipeline ───────────────────────────────────────────────────
/**
 * Full pipeline: fetch positions → predict ETAs → return structured results.
 * Auto-selects best available data source.
 */
async function getRealtimePredictions(stopLat, stopLng, routeIds = ["22", "7X", "14"]) {
  const { predictETA } = window.BusNowPredictor || {};

  // Fetch positions (TSRTC → mock fallback)
  const positions = await fetchTSRTCPositions(routeIds);

  // Get nearby stops for display
  const stops = await fetchNearbyStops(stopLat, stopLng, 300);

  const results = positions.map(pos => {
    if (!pos || !predictETA) return null;
    const baseMin = { "22": 5, "7X": 5, "14": 9 }[pos.routeId] || 10;
    const scheduledETA = new Date(Date.now() + baseMin * 60000);

    const prediction = predictETA({
      routeId:      pos.routeId,
      busLat:       pos.lat,
      busLng:       pos.lng,
      stopLat,
      stopLng,
      scheduledETA,
      walkMinutes:  4
    });

    return {
      routeId:   pos.routeId,
      vehicleId: pos.vehicleId,
      source:    pos.source,
      ...prediction
    };
  }).filter(Boolean);

  return { predictions: results, nearbyStops: stops, fetchedAt: new Date() };
}

// Export
if (typeof module !== 'undefined') {
  module.exports = {
    fetchTSRTCPositions, fetchGTFSRealtimePositions,
    fetchNearbyStops, fetchMockPositions,
    formatForWhatsApp, getRealtimePredictions
  };
}

// Browser global
window.BusNowAPI = {
  fetchTSRTCPositions, fetchNearbyStops,
  fetchMockPositions, formatForWhatsApp,
  getRealtimePredictions
};
