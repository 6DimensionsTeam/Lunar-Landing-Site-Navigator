// Grid measurements describe an area, not a certified landing solution.
export function evaluateLocation(point, zones, cfg = null) {
  const zone = zones.atLatLon(point.lat, point.lon);
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const known = zone && [zone.sun, zone.earth, zone.slopeDeg].every(finite);
  const blockers = [];
  if (zone && !zone.flat) blockers.push('Terrain is not classified as landing-flat.');
  if (zone?.inShadow) blockers.push('Permanent shadow limits solar power.');
  if (cfg?.needs?.iceNearby && !zone?.iceLikely) blockers.push('Nearby stable ice is not confirmed.');
  const comm = cfg?.needs?.continuousComm;
  // Increase communication weight when the mission requests uninterrupted communication.
  const score = known ? Math.round(Math.max(0, Math.min(100,
    (comm ? .25 : .45) * zone.sun + (comm ? .5 : .3) * zone.earth +
    .25 * Math.max(0, 100 - zone.slopeDeg * 5)))) : null;
  if (comm) blockers.push('Grid visibility averages cannot verify uninterrupted communication.');
  if (cfg?.needs?.maxDarkH != null) blockers.push('Maximum dark duration requires a mission-time horizon analysis.');
  return { point: { lat: point.lat, lon: point.lon }, zone, score,
    stars: score == null ? null : Math.max(1, Math.min(5, Math.round(score / 20))), blockers };
}
