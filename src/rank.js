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

// The Earth-link bar, when the caller does not state one.
//
// There is no published figure for how much of the period a landing site must see Earth: the
// requirement belongs to a mission's communications design, not to the ground, and this project
// has no such design to cite. So this number is ours, and the honest thing is to say which number
// it is and let the user replace it. `continuousComm` therefore takes a percentage as well as a
// boolean: a number is the user's own bar, `true` falls back to this default, and the field keeps
// its place in the needs contract either way.
//
// The default is 80. Note what that does on the shipped pool, because it is the reason the bar
// should be the user's and not a fact the product asserts: Malapert Massif measures 84.8% and
// every other site lands between 51.9% and 57.6%, so 80 sits inside a 27-point empty gap and the
// requirement behaves as a switch that selects exactly one site. That is a property of this
// terrain -- the south pole occludes Earth from most of it for long stretches -- not a standard
// any site is failing to meet.
const CONTINUOUS_COMM_PCT = 80;
// Resolve the caller's Earth-link bar: a finite percentage is taken as given, anything else
// truthy means "use our default", and a falsy value means the requirement was not asked for.
export function commBar(need) {
  return Number.isFinite(need) ? need : CONTINUOUS_COMM_PCT;
}
// A crater floor is only claimed where the ground classification actually says so.
const ICE_NEAR_KM = 25;

// The pool the selector ranks: the four published Artemis candidate regions plus the places
// found in the grid. Merged here so nothing downstream has to know they arrived in different
// files, and tagged so the interface can tell a reader which is which -- "a region NASA
// published" and "a place our own scan found" are different claims and must not look alike.
export function candidatePool(data) {
  const named = (data.sites?.sites || []).map((s) => ({ ...s, source: 'nasa' }));
  const found = (data.candidates?.candidates || []).map((c) => ({ ...c, source: 'data' }));
  return [...named, ...found];
}

export function rankSites(sites, zones, year, needs = {}) {
  const scored = sites.map((site) => evaluate(site, zones, year, needs));
  // Requirement failures sort last regardless of score; a site that meets everything always
  // outranks one that does not, however good its numbers look in isolation. Within a tier the
  // published regions lead at equal score, since a reader can go and check those.
  scored.sort((a, b) => (a.fails.length - b.fails.length) || (b.score - a.score)
    || (a.site.source === b.site.source ? 0 : a.site.source === 'nasa' ? -1 : 1)
    || (a.site.id < b.site.id ? -1 : 1));
  return scored;
}

export function statsFor(site, year) {
  return (year != null && site.stats_by_year[String(year)]) || site.stats;
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

  const commNeeded = needs.continuousComm ? commBar(needs.continuousComm) : null;
  if (commNeeded !== null && comms < commNeeded) {
    fails.push(`Earth link ${comms.toFixed(1)}%, below the ${commNeeded}% needed for continuous contact`);
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

  // A verdict is only produced for a requirement that was actually asked for. These two used to
  // be pushed unconditionally with pass computed as "true unless the requirement applies", so a
  // mission with no requirements still rendered two green PASS rows -- a verdict on a demand
  // nobody made -- and the caller's own "no requirements set" branch could never be reached.
  if (commNeeded !== null) {
    verdicts.push({ key: 'comms', label: 'Earth link', pass: comms >= commNeeded, value: `${comms.toFixed(1)}%` });
  }
  if (Number.isFinite(needs.maxDarkH) && needs.maxDarkH > 0) {
    verdicts.push({ key: 'dark', label: 'Dark limit', pass: st.longest_dark_h <= needs.maxDarkH, value: `${st.longest_dark_h} h worst` });
  }
  if (needs.craterFloor) verdicts.push({ key: 'crater', label: 'Crater floor', pass: !!ground && ground.zone !== 'rough', value: ground ? ground.zone : 'unmapped' });
  if (needs.iceNearby) verdicts.push({ key: 'ice', label: 'Ice nearby', pass: !!ground && ground.iceDistKm <= ICE_NEAR_KM, value: ground ? `${ground.iceDistKm.toFixed(0)} km` : '—' });

  return { site, stats: st, ground, score, fails, notes, verdicts, meetsAll: fails.length === 0 };
}

// A side-by-side reading of the same rankSites() output: one row per site, one column per
// figure worth comparing across the pool, rather than one site's own verdict read in
// isolation. Kept here, next to evaluate(), so the columns can never show a number evaluate()
// did not itself compute.
//
// Only the measured figures and the requirements actually asked for become columns. A
// requirement nobody set would be a column of identical "not asked" cells repeated six times,
// which is not a comparison; the four baseline figures (sun, Earth link, longest dark, ground)
// are shown regardless, because those are what distinguishes the sites whether or not a
// mission constrains them.
export function compareSites(entries) {
  const rows = entries.map((entry) => {
    const { site, stats: st, ground, verdicts } = entry;
    const byKey = new Map(verdicts.map((v) => [v.key, v]));
    return {
      site, entry,
      cells: {
        sun: { value: `${st.sun_visible_pct.toFixed(1)}%`, raw: st.sun_visible_pct },
        comms: { value: `${st.earth_visible_pct.toFixed(1)}%`, raw: st.earth_visible_pct, verdict: byKey.get('comms') ?? null },
        dark: { value: `${st.longest_dark_h} h`, raw: st.longest_dark_h, verdict: byKey.get('dark') ?? null },
        ground: {
          value: ground ? ground.zone : 'unmapped',
          verdict: byKey.get('crater') ?? null,
        },
        ice: { value: ground ? `${ground.iceDistKm.toFixed(0)} km` : '—', raw: ground ? ground.iceDistKm : null, verdict: byKey.get('ice') ?? null },
        overall: { value: entry.meetsAll ? 'MEETS' : 'FAILS', verdict: { pass: entry.meetsAll } },
      },
    };
  });
  // A column is worth a place in the table only if at least one row has a verdict for it; sun
  // and ground are the exception, shown as plain figures with no pass/fail column of their own.
  const askedComms = rows.some((r) => r.cells.comms.verdict);
  const askedDark = rows.some((r) => r.cells.dark.verdict);
  const askedCrater = rows.some((r) => r.cells.ground.verdict);
  const askedIce = rows.some((r) => r.cells.ice.verdict);
  // Which raw value wins the column: more sunlight and more Earth link are better, less
  // darkness and nearer ice are better. ground and overall have no numeric "best" -- ground is
  // a category and overall already reads as MEETS/FAILS -- so neither marks a best cell.
  const columns = [
    { key: 'sun', label: 'Sunlight', better: 'high' },
    { key: 'comms', label: 'Earth link', graded: askedComms, better: 'high' },
    { key: 'dark', label: 'Longest dark', graded: askedDark, better: 'low' },
    { key: 'ground', label: 'Ground', graded: askedCrater },
    { key: 'ice', label: 'Ice nearby', graded: askedIce, better: 'low' },
    { key: 'overall', label: 'Meets mission', graded: true },
  ];
  // Mark every row that reaches the column's best raw value, not just the first: a tie between
  // two sites is a real tie, and singling one out would claim a difference the figures do not
  // show. Rows missing that figure (raw === null, an unmapped site's ice distance) never win.
  for (const col of columns) {
    if (!col.better) continue;
    const present = rows.map((r) => r.cells[col.key].raw).filter((v) => Number.isFinite(v));
    if (!present.length) continue;
    const best = col.better === 'high' ? Math.max(...present) : Math.min(...present);
    for (const row of rows) {
      const cell = row.cells[col.key];
      cell.best = Number.isFinite(cell.raw) && cell.raw === best;
    }
  }
  return { rows, columns };
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
