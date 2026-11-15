// Robustness across many missions, instead of one ranking of one mission.
//
// A single ranking answers "which site is best for the mission as stated". It cannot answer the
// question a planner actually has, which is "which site do I still want when the mission changes
// under me". Requirements move: a launch slips, a relay is not approved, an endurance budget is
// cut. A site that wins narrowly under one set of requirements and fails under the next is a
// worse choice than a site that is merely good under all of them.
//
// So this re-runs the same ranking across many requirement sets -- "worlds" -- and counts how
// often each site still meets every requirement. The site that survives the most worlds is the
// answer, and it is not always the one with the highest score in any single world.
//
// WHAT A WORLD IS, EXACTLY. It is a requirement set: an arrival year plus the four fields
// rank.js already treats as hard filters (craterFloor, iceNearby, continuousComm, maxDarkH).
// Nothing here models engineering. A world is not a simulated spacecraft; it is a different set
// of demands placed on the same measured ground.
//
// WHERE THE VARIATION IS REAL. The year axis is measured data, not an assumption: each site's
// sunlight, Earth link and longest night genuinely differ year to year over 2026-2040 (the
// ephemeris covers a full 18.6-year lunar precession cycle, and the figures move by several
// points across it). Reading a different year reads different real numbers. The requirement axes
// are the mission's own stated constraints, which a user already sets by hand on the mission
// screen -- sweeping them is sweeping the same control, not inventing physics.
//
// WHAT THIS DOES NOT CLAIM. It does not say what a lighter lander can endure, what a budget cut
// costs, or how likely any world is. Those would need engineering models and cost data this
// project does not have, and a number derived from them would be invented. The worlds are
// deliberately unweighted: survival is counted, not averaged against a probability nobody
// measured.

import { rankSites, statsFor } from './rank.js';

// The endurance values swept on the darkness axis, in hours of continuous night. Each one is a
// real measured figure from the pool rather than a round number: the shortest night any site
// achieves, the worst night among the regions NASA published, and the steps in between that
// actually separate sites. Sweeping measured values means every world is a demand some real
// place in this dataset can meet, and the hardest world is exactly as hard as the best ground
// allows -- not harder, which would make every site fail and say nothing.
export const DARK_STEPS = [204, 222, 273, 297, 318, 366, 405];

// The requirement axes. Each entry is a named demand that rank.js already enforces as a hard
// filter, with the two states it can take. Order is fixed so a world index means the same thing
// across runs: the elimination animation steps through worlds in this order and must be
// reproducible.
const AXES = [
  { key: 'continuousComm', label: 'Direct Earth link required' },
  { key: 'craterFloor', label: 'Crater floor access required' },
  { key: 'iceNearby', label: 'Ice within reach required' },
];

// How a world is described to a reader. The wording is deliberately about requirements, not
// about causes: "no relay, so the site must reach Earth directly" is a requirement, while
// "the relay was not approved" would be a story we cannot support with data.
function describe(world) {
  const parts = [`${world.year} arrival`, `night limit ${world.needs.maxDarkH} h`];
  if (world.needs.continuousComm) parts.push('direct Earth link required');
  if (world.needs.craterFloor) parts.push('crater floor required');
  if (world.needs.iceNearby) parts.push('ice within reach required');
  return parts.join(' · ');
}

// Build the world set. Deterministic: same inputs, same worlds, in the same order, so a run can
// be replayed and an animation can be scrubbed. Years are spread evenly across the ephemeris
// rather than sampled randomly, so no year is over-represented by luck.
export function buildWorlds({ startYear, endYear, count = 100 }) {
  const years = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);
  const worlds = [];
  // Walk the three boolean axes as a binary counter and the two measured axes as cycles. Every
  // combination of the booleans appears, and the year and darkness axes advance underneath so
  // the set spreads over both rather than repeating one year eight times in a row.
  for (let i = 0; worlds.length < count; i++) {
    const bits = i % 8;
    const needs = {
      continuousComm: !!(bits & 1),
      craterFloor: !!(bits & 2),
      iceNearby: !!(bits & 4),
      maxDarkH: DARK_STEPS[Math.floor(i / 8) % DARK_STEPS.length],
    };
    const year = years[i % years.length];
    const world = { id: worlds.length, year, needs };
    world.label = describe(world);
    worlds.push(world);
    if (i > count * 4) break;        // guard: the axes always supply enough, but never loop away
  }
  return worlds;
}

// Run every world and count survivals per site.
//
// Returns, per site: how many worlds it met every requirement in, which worlds killed it and
// why, and its mean score across all worlds (reported for context only -- the ranking here is
// by survival count, which is the whole point of the exercise).
export function runWorlds(pool, zones, worlds) {
  const tally = new Map();
  for (const s of pool) {
    tally.set(s.id, { site: s, survived: 0, scoreSum: 0, deaths: [], firstDeath: null });
  }
  // Per-world eliminations, in world order, which is what the animation plays back.
  const timeline = worlds.map((world) => {
    const ranked = rankSites(pool, zones, world.year, world.needs);
    const alive = [], dead = [];
    for (const entry of ranked) {
      const rec = tally.get(entry.site.id);
      if (!rec) continue;
      rec.scoreSum += entry.score;
      if (entry.meetsAll) {
        rec.survived += 1;
        alive.push(entry.site.id);
      } else {
        dead.push({ id: entry.site.id, why: entry.fails });
        rec.deaths.push({ world: world.id, why: entry.fails });
        if (rec.firstDeath == null) rec.firstDeath = world.id;
      }
    }
    return { world, alive, dead, winner: ranked.find((e) => e.meetsAll)?.site.id || null };
  });

  const sites = [...tally.values()].map((rec) => ({
    site: rec.site,
    survived: rec.survived,
    worlds: worlds.length,
    survivalPct: (rec.survived / worlds.length) * 100,
    meanScore: rec.scoreSum / worlds.length,
    deaths: rec.deaths,
    // The single most common reason this site was ruled out, which is more useful than a list:
    // it names the one requirement the site cannot absorb.
    weakness: commonest(rec.deaths.flatMap((d) => d.why.map(reasonKey))),
  }));

  // Survival first, then mean score only to break ties. A site that survives more worlds
  // outranks a higher-scoring site that survives fewer, which is the claim this module exists
  // to make.
  sites.sort((a, b) => (b.survived - a.survived) || (b.meanScore - a.meanScore)
    || (a.site.id < b.site.id ? -1 : 1));

  return { worlds, timeline, sites, survivorCount: sites.filter((s) => s.survived === worlds.length).length };
}

// Collapse a rank.js failure message to the requirement it belongs to, so failures can be
// counted. The messages themselves carry the measured figure and stay intact for display.
function reasonKey(message) {
  if (/Earth link/.test(message)) return 'Earth link';
  if (/Longest dark/.test(message)) return 'Night length';
  if (/crater floor|too steep/.test(message)) return 'Crater floor';
  if (/shadow|ice/.test(message)) return 'Ice distance';
  return 'Other';
}

function commonest(list) {
  if (!list.length) return null;
  const n = new Map();
  for (const k of list) n.set(k, (n.get(k) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// The one-line answer, worded so it cannot be read as a probability. "Survived 94 of 100
// requirement sets" is a count over a set we chose; "94% likely to work" would be a claim about
// the world that nothing here supports.
export function summarise(result) {
  const top = result.sites[0];
  if (!top) return 'No sites to compare.';
  if (top.survived === 0) {
    return `No site met every requirement in any of the ${result.worlds.length} requirement sets tested.`;
  }
  const runner = result.sites[1];
  const lead = runner && runner.survived < top.survived
    ? ` The next most durable, ${runner.site.en}, met ${runner.survived}.`
    : '';
  return `${top.site.en} met every requirement in ${top.survived} of ${result.worlds.length} `
    + `requirement sets.${lead} Ranked by how often a site survives, not by its best single score.`;
}
