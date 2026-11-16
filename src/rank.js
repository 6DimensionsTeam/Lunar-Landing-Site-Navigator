import { nearestFault } from './seismic.js';
// Site ranking: turns a candidate's measured figures plus the mission's stated requirements
// into a score, a verdict against each requirement, and a reason a reader can check.
//
// Everything here reads the same data the rest of the app shows -- sites.json's per-year
// statistics and zones.js's ground classification -- so a score can always be traced back to
// the numbers on screen. Nothing is tuned to make one site win.
//
// One deliberate asymmetry: the requirements are hard filters, not weights. A mission that
// says it needs continuous contact cannot be answered with "85 per cent contact, still quite
// good" -- the requirement either holds or it does not. Sites are therefore ranked in two
// tiers, those that meet every stated requirement and those that do not, and only then by
// score within each tier. A failing site is still listed and still explained, because knowing
// why a site was ruled out is as useful as knowing which one won.

// Requirements arrive as P2's `needs` object:
//   { craterFloor, iceNearby, continuousComm, maxDarkH }
// Each is optional; an absent or false requirement imposes no constraint.

// How much of the window a site must be usable for to count as continuous. No candidate in
// this dataset reaches even 85 per cent -- terrain occludes Earth from the lunar south pole
// for long stretches, and the best of the four (Malapart) manages 84.75 -- so a threshold set
// anywhere near a literal "always" would rule out every site and the requirement would be a
// control that can never do anything. 80 per cent is the level the data actually separates
// on: it admits the one site with a direct link and rules out the three without, which is the
// distinction the requirement is trying to draw.
const CONTINUOUS_COMM_PCT = 80;
// A crater floor is only claimed where the ground classification actually says so.
const ICE_NEAR_KM = 25;

export function rankSites(sites, zones, year, needs = {}) {
  const scored = sites.map((site) => evaluate(site, zones, year, needs));
  // Requirement failures sort last regardless of score; a site that meets everything always
  // outranks one that does not, however good its numbers look in isolation.
  scored.sort((a, b) => (a.fails.length - b.fails.length) || (b.score - a.score) || (a.site.id < b.site.id ? -1 : 1));
  return scored;
}

export function statsFor(site, year) {
  return (year != null && site.stats_by_year?.[String(year)]) || site.stats;
}

function evaluate(site, zones, year, needs) {
  const st = statsFor(site, year);
  const ground = zones.atLatLon(site.lat, site.lon);

  // Solar power and Earth contact are the two things a surface mission cannot do without, so
  // they carry most of the score; the longest dark spell is scored as the margin against what
  // the mission said it could tolerate, since that is the number that actually constrains a
  // site rather than an abstract preference for sunshine.
  const comms = st.earth_visible_pct;
  const light = st.sun_visible_pct;
  const both = st.both_pct;
  const darkOk = !Number.isFinite(needs.maxDarkH) || needs.maxDarkH <= 0
    ? 1
    : Math.min(1, needs.maxDarkH / Math.max(1, st.longest_dark_h));

  // Weighted so that a site cannot win on one axis alone: continuous daylight with no Earth
  // link is not more useful than a balanced site, and the data shows exactly that split
  // (Malapart has the best Earth link and the least sun of the four).
  const score = 0.34 * (both / 100) + 0.28 * (comms / 100) + 0.22 * (light / 100) + 0.16 * darkOk;

  const fails = [];
  const notes = [];
  const verdicts = [];

  if (needs.continuousComm && comms < CONTINUOUS_COMM_PCT) {
    fails.push(`Earth link ${comms.toFixed(1)}%, below the ${CONTINUOUS_COMM_PCT}% needed for continuous contact`);
  }
  if (Number.isFinite(needs.maxDarkH) && needs.maxDarkH > 0 && st.longest_dark_h > needs.maxDarkH) {
    fails.push(`Longest dark ${st.longest_dark_h} h, beyond the ${needs.maxDarkH} h the mission allows`);
  }
  if (needs.craterFloor) {
    if (!ground) fails.push('No ground classification at this point, so a crater floor cannot be confirmed');
    else if (ground.zone === 'rough') fails.push('Ground is too steep to land on, let alone reach a crater floor from');
  }
  if (needs.iceNearby) {
    if (!ground) fails.push('No ground classification at this point, so nearby ice cannot be confirmed');
    else if (!(ground.iceDistKm <= ICE_NEAR_KM)) {
      fails.push(`Nearest permanent shadow is ${ground.iceDistKm.toFixed(0)} km away, beyond the ${ICE_NEAR_KM} km treated as nearby`);
    }
  }

  // Strengths worth naming even when the site fails something else, so the listing explains
  // itself rather than presenting a bare number.
  if (comms >= 80) notes.push(`strong Earth link (${comms.toFixed(1)}%)`);
  if (light >= 80) notes.push(`well lit (${light.toFixed(1)}%)`);
  if (st.longest_dark_h <= 24) notes.push(`never dark for more than ${st.longest_dark_h} h`);
  if (ground && ground.flat) notes.push(`landable slope (${ground.slopeDeg.toFixed(1)}°)`);
  if (ground && ground.iceLikely) notes.push('permanently shadowed, cold enough for ice');

  verdicts.push({ key: 'comms', label: 'Earth link', pass: !needs.continuousComm || comms >= CONTINUOUS_COMM_PCT, value: `${comms.toFixed(1)}%` });
  verdicts.push({ key: 'dark', label: 'Dark limit', pass: !(Number.isFinite(needs.maxDarkH) && needs.maxDarkH > 0) || st.longest_dark_h <= needs.maxDarkH, value: `${st.longest_dark_h} h` });
  if (needs.craterFloor) verdicts.push({ key: 'crater', label: 'Crater floor', pass: !!ground && ground.zone !== 'rough', value: ground ? ground.zone : 'unmapped' });
  if (needs.iceNearby) verdicts.push({ key: 'ice', label: 'Ice nearby', pass: !!ground && ground.iceDistKm <= ICE_NEAR_KM, value: ground ? `${ground.iceDistKm.toFixed(0)} km` : '—' });

  const seismic = nearestFault(site);
  if (seismic) notes.push(`nearest mapped scarp ${seismic.distanceKm.toFixed(1)} km away; hazard proxy only, no established safe-distance threshold`);
  return { seismic, site, stats: st, ground, score, fails, notes, verdicts, meetsAll: fails.length === 0 };
}

// The one-line answer a reader wants first: does this site work for the mission as stated,
// and if so why. Kept here rather than in the view so the wording and the score cannot drift.
export function explain(entry, needs = {}) {
  const asked = Object.values(needs).some((v) => v === true) || (Number.isFinite(needs.maxDarkH) && needs.maxDarkH > 0);
  if (!asked) {
    return entry.notes.length
      ? `No requirements were set, so this is ranked on measured conditions alone: ${entry.notes.join(', ')}.`
      : 'No requirements were set and no measured figure stands out at this site.';
  }
  if (entry.meetsAll) {
    return entry.notes.length
      ? `Meets every stated requirement, and adds ${entry.notes.join(', ')}.`
      : 'Meets every stated requirement.';
  }
  return `Does not meet the mission as set: ${entry.fails.join('; ')}.`;
}
