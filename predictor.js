/**
 * BusNow — Delay Prediction Engine
 * 
 * Algorithm: Weighted multi-factor ETA prediction
 * Combines live GPS position, historical delay patterns,
 * time-of-day factors, and crowd/traffic signals.
 */

// ─── Historical delay data (per route, per day, per hour) ───────────────────
// Format: delays[routeId][dayOfWeek][hour] = avg delay in minutes
// 0=Sun, 1=Mon … 6=Sat | Based on 30-day rolling window
const HISTORICAL_DELAYS = {
  "22": {
    1: { 7: 1.2, 8: 2.4, 9: 3.1, 17: 4.2, 18: 5.8 },
    2: { 7: 1.0, 8: 2.1, 9: 2.9, 17: 3.9, 18: 5.2 },
    3: { 7: 1.5, 8: 2.8, 9: 3.5, 17: 4.5, 18: 6.1 },
    4: { 7: 1.1, 8: 2.3, 9: 3.0, 17: 4.0, 18: 5.5 }, // Thu
    5: { 7: 2.0, 8: 3.5, 9: 4.2, 17: 5.0, 18: 7.2 },
    6: { 7: 0.8, 8: 1.2, 9: 1.5, 17: 2.1, 18: 3.0 },
    0: { 7: 0.5, 8: 0.8, 9: 1.0, 17: 1.5, 18: 2.0 },
  },
  "7X": {
    1: { 7: 3.1, 8: 6.8, 9: 5.2, 17: 7.5, 18: 9.1 },
    2: { 7: 2.8, 8: 5.9, 9: 4.8, 17: 7.0, 18: 8.6 },
    3: { 7: 3.5, 8: 7.2, 9: 5.5, 17: 8.0, 18: 9.8 },
    4: { 7: 3.2, 8: 8.1, 9: 6.0, 17: 7.8, 18: 9.5 }, // Thu — historically bad
    5: { 7: 4.0, 8: 9.0, 9: 7.0, 17: 9.5, 18: 11.0 },
    6: { 7: 1.5, 8: 2.5, 9: 2.0, 17: 3.5, 18: 4.5 },
    0: { 7: 1.0, 8: 1.8, 9: 1.5, 17: 2.5, 18: 3.0 },
  },
  "14": {
    1: { 7: 0.8, 8: 1.5, 9: 2.0, 17: 2.5, 18: 3.8 },
    2: { 7: 0.6, 8: 1.2, 9: 1.8, 17: 2.2, 18: 3.5 },
    3: { 7: 0.9, 8: 1.7, 9: 2.2, 17: 2.8, 18: 4.0 },
    4: { 7: 0.5, 8: 1.0, 9: 1.5, 17: 2.0, 18: 3.2 }, // Thu — usually runs early
    5: { 7: 1.5, 8: 2.8, 9: 3.5, 17: 4.0, 18: 5.5 },
    6: { 7: 0.3, 8: 0.5, 9: 0.7, 17: 1.0, 18: 1.5 },
    0: { 7: 0.2, 8: 0.3, 9: 0.5, 17: 0.8, 18: 1.0 },
  }
};

// ─── On-time rate per route (from last 30 days) ──────────────────────────────
const ON_TIME_RATE = { "22": 0.78, "7X": 0.41, "14": 0.86 };

// ─── Traffic zones and their delay multipliers ───────────────────────────────
const TRAFFIC_ZONES = [
  { name: "Central Market Area",  lat: 17.4239, lng: 78.4738, radiusKm: 0.8, multiplier: 1.6 },
  { name: "Ameerpet Junction",    lat: 17.4374, lng: 78.4487, radiusKm: 0.5, multiplier: 1.4 },
  { name: "HITEC City Signal",    lat: 17.4435, lng: 78.3771, radiusKm: 0.6, multiplier: 1.3 },
  { name: "LB Nagar Circle",      lat: 17.3438, lng: 78.5514, radiusKm: 0.7, multiplier: 1.5 },
];

// ─── Utility: Haversine distance (km) ────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
            Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── Get traffic multiplier for a GPS position ───────────────────────────────
function getTrafficMultiplier(lat, lng) {
  let multiplier = 1.0;
  for (const zone of TRAFFIC_ZONES) {
    const dist = haversine(lat, lng, zone.lat, zone.lng);
    if (dist <= zone.radiusKm) {
      multiplier = Math.max(multiplier, zone.multiplier);
    }
  }
  return multiplier;
}

// ─── Core prediction function ─────────────────────────────────────────────────
/**
 * predictETA(routeId, busLat, busLng, stopLat, stopLng, scheduledETA)
 *
 * Returns:
 *   {
 *     etaMinutes:   number   — predicted arrival in minutes from now
 *     delayMinutes: number   — positive = late, negative = early
 *     confidence:   number   — 0–100 score
 *     status:       string   — 'on-time' | 'delayed' | 'early'
 *     leaveBy:      string   — "HH:MM" — recommended departure time
 *     explanation:  string   — human-readable reason
 *   }
 */
function predictETA({ routeId, busLat, busLng, stopLat, stopLng, scheduledETA, walkMinutes = 5 }) {
  const now = new Date();
  const hour = now.getHours();
  const dow  = now.getDay();

  // 1. Scheduled ETA baseline (minutes from now)
  const scheduledMs = scheduledETA - now;
  const scheduledMin = scheduledMs / 60000;

  // 2. Historical delay for this route/day/hour
  const histDelays = HISTORICAL_DELAYS[routeId] || {};
  const dayDelays  = histDelays[dow] || {};
  // Interpolate nearest hour if exact not available
  const histDelay  = dayDelays[hour] ?? dayDelays[hour - 1] ?? dayDelays[hour + 1] ?? 0;

  // 3. Distance-based raw ETA from current GPS position
  //    Assume average bus speed in city = 18 km/h during peak
  const distKm = haversine(busLat, busLng, stopLat, stopLng);
  const peakSpeedKmh = (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19) ? 14 : 22;
  const rawTravelMin = (distKm / peakSpeedKmh) * 60;

  // 4. Traffic zone multiplier at current bus position
  const trafficMult = getTrafficMultiplier(busLat, busLng);
  const adjustedTravelMin = rawTravelMin * trafficMult;

  // 5. Weighted blend: 50% GPS-based, 30% scheduled, 20% historical pattern
  const blendedETA = (adjustedTravelMin * 0.50) + (scheduledMin * 0.30) + ((scheduledMin + histDelay) * 0.20);

  // 6. Delay relative to schedule
  const delayMin = blendedETA - scheduledMin;

  // 7. Confidence score
  //    Start from on-time rate, penalise for traffic/high delay variance
  const onTimeRate   = ON_TIME_RATE[routeId] ?? 0.7;
  const trafficPenalty = (trafficMult - 1) * 30;    // 0–18 pts
  const variancePenalty = Math.min(20, Math.abs(delayMin) * 2);
  const rawConfidence  = onTimeRate * 100 - trafficPenalty - variancePenalty;
  const confidence     = Math.round(Math.min(99, Math.max(40, rawConfidence)));

  // 8. Status
  let status = 'on-time';
  if (delayMin > 2) status = 'delayed';
  else if (delayMin < -1) status = 'early';

  // 9. Leave-by time: ETA - walk time, minus 1 min safety buffer
  const leaveByMs = now.getTime() + (blendedETA - walkMinutes - 1) * 60000;
  const leaveBy   = new Date(leaveByMs).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

  // 10. Human-readable explanation
  let explanation = '';
  if (status === 'delayed') {
    explanation = `Running ~${Math.round(delayMin)} min late. ` +
      (trafficMult > 1.2 ? `Heavy traffic near ${TRAFFIC_ZONES.find(z => getTrafficMultiplier(busLat, busLng) === z.multiplier)?.name ?? 'junction'}. ` : '') +
      `Historically ${Math.round((1 - onTimeRate) * 100)}% of ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow]} trips on this route run late at ${hour}:00.`;
  } else if (status === 'early') {
    explanation = `Running ~${Math.abs(Math.round(delayMin))} min early. Light traffic today. Recommend being at stop by ${leaveBy}.`;
  } else {
    explanation = `On schedule. Historical on-time rate: ${Math.round(onTimeRate * 100)}%. Leave by ${leaveBy} to catch comfortably.`;
  }

  return {
    etaMinutes:   Math.max(0, Math.round(blendedETA * 10) / 10),
    delayMinutes: Math.round(delayMin * 10) / 10,
    confidence,
    status,
    leaveBy,
    explanation,
    debug: { distKm: Math.round(distKm * 100)/100, trafficMult, histDelay, blendedETA: Math.round(blendedETA*10)/10 }
  };
}

// ─── Mock live GPS feed (replace with real GTFS-RT or API) ──────────────────
/**
 * Simulates a live GPS stream for a bus.
 * In production: replace with TSRTC API / GTFS Realtime feed.
 */
function mockGPSFeed(routeId) {
  const mockPositions = {
    "22": { lat: 17.4312, lng: 78.4420, speed: 16 },
    "7X": { lat: 17.4200, lng: 78.4580, speed: 8  }, // stuck in traffic
    "14": { lat: 17.4455, lng: 78.4385, speed: 24 }, // moving fast
  };
  return mockPositions[routeId] || { lat: 17.4376, lng: 78.4487, speed: 15 };
}

// ─── Batch predictions for all routes at a stop ───────────────────────────────
function getPredictionsForStop(stopLat, stopLng, routes = ["22", "7X", "14"]) {
  return routes.map(routeId => {
    const gps = mockGPSFeed(routeId);
    // Simulated scheduled ETA: 5–20 min from now
    const baseMin = { "22": 5, "7X": 5, "14": 9 }[routeId] || 10;
    const scheduledETA = new Date(Date.now() + baseMin * 60000);

    const prediction = predictETA({
      routeId,
      busLat: gps.lat,
      busLng: gps.lng,
      stopLat,
      stopLng,
      scheduledETA,
      walkMinutes: 4
    });

    return { routeId, gps, ...prediction };
  });
}

// ─── Export for use in browser or Node ───────────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = { predictETA, getPredictionsForStop, mockGPSFeed, haversine, getTrafficMultiplier };
}
