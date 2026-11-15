import { candidatePool, rankSites } from './rank.js';

// These are the measured inputs consumed by rankSites. Other annual fields are optional.
const RANK_FIELDS = ['sun_visible_pct', 'earth_visible_pct', 'both_pct', 'longest_dark_h'];

function metadataYears(data) {
  const range = data?.sites?.stats_years;
  if (!Array.isArray(range) || range.length !== 2 ||
      !range.every(Number.isSafeInteger) || range[1] < range[0]) {
    throw new TypeError('Annual statistics require an inclusive integer stats_years range.');
  }
  const years = [];
  for (let year = range[0]; year <= range[1]; year++) years.push(year);
  return years;
}

function annualAvailability(site, year) {
  const annual = site.stats_by_year;
  if (!annual || !Object.hasOwn(annual, String(year)) || !annual[String(year)]) {
    return { known: false, reason: `Annual statistics are missing for ${year}.` };
  }
  const stats = annual[String(year)];
  const missing = RANK_FIELDS.filter(field => !Number.isFinite(stats[field]));
  return missing.length
    ? { known: false, reason: `Annual statistics are incomplete for ${year}: ${missing.join(', ')}.` }
    : { known: true };
}

/**
 * Build an annual comparison from measured per-year statistics, without changing the
 * mission, site selection, ranking rules, or the caller's data. Annual feasibility is
 * not a launch-window calculation and does not imply that every day of a year is usable.
 */
export function buildAnnualPlan({ data, zones, needs = {}, fromYear } = {}) {
  const years = metadataYears(data);
  const firstYear = fromYear ?? years[0];
  if (!Number.isSafeInteger(firstYear)) throw new TypeError('The planning start year must be an integer.');
  if (!zones || typeof zones.atLatLon !== 'function') throw new TypeError('Annual planning requires ground classifications.');
  const pool = candidatePool(data);
  const rows = pool.map(site => ({ site, cells: [] }));
  const rowBySite = new Map(rows.map(row => [row.site, row]));
  const yearSummaries = [];

  for (const year of years) {
    const availability = new Map(pool.map(site => [site, annualAvailability(site, year)]));
    // statsFor deliberately falls back to overall figures elsewhere in the application.
    // Exclude missing annual entries here so that fallback cannot become annual evidence.
    const ranked = rankSites(pool.filter(site => availability.get(site).known), zones, year, needs);
    const cells = ranked.map((entry, index) => ({
      ...entry, entry, year, rank: index + 1,
      status: entry.meetsAll ? 'feasible' : 'infeasible'
    }));
    for (const site of pool) {
      const available = availability.get(site);
      if (available.known) continue;
      cells.push({
        site, year, rank: null, status: 'unknown', entry: null,
        stats: null, score: null, meetsAll: null, ground: null,
        fails: [], notes: [], verdicts: [], unknownReason: available.reason
      });
    }
    for (const cell of cells) rowBySite.get(cell.site).cells.push(cell);
    const feasible = cells.filter(cell => cell.status === 'feasible');
    const unknownCount = cells.filter(cell => cell.status === 'unknown').length;
    const infeasibleCount = cells.length - feasible.length - unknownCount;
    const noFit = cells.length > 0 && feasible.length === 0 && unknownCount === 0;
    yearSummaries.push({
      year, cells, feasibleCount: feasible.length, infeasibleCount, unknownCount,
      complete: unknownCount === 0, noFit,
      status: feasible.length ? 'feasible' : noFit ? 'no-fit' : 'unknown',
      bestFeasible: feasible[0] ?? null
    });
  }

  for (const row of rows) {
    const feasible = row.cells.filter(cell => cell.status === 'feasible');
    const bestScore = feasible.length ? Math.max(...feasible.map(cell => cell.score)) : null;
    row.feasibleYears = feasible.map(cell => cell.year);
    row.bestCells = feasible.filter(cell => cell.score === bestScore);
    row.bestYears = row.bestCells.map(cell => cell.year);
    row.bestYear = row.bestYears[0] ?? null;
    row.unknownYears = row.cells.filter(cell => cell.status === 'unknown').map(cell => cell.year);
    row.allYearsMeet = feasible.length === years.length;
  }

  const eligible = yearSummaries
    .filter(summary => summary.year >= firstYear)
    .flatMap(summary => summary.cells.filter(cell => cell.status === 'feasible'));
  const recommendation = [...eligible].sort((a, b) =>
    b.score - a.score || a.year - b.year || a.rank - b.rank)[0] ?? null;
  // An earliest option is kept separately from the best-scoring option; the UI can offer
  // it when waiting matters without silently changing the requested planning start year.
  const earliestFeasible = eligible[0] ?? null;

  return {
    years, fromYear: firstYear, rows, yearSummaries, recommendation, earliestFeasible,
    noFitYears: yearSummaries.filter(summary => summary.noFit).map(summary => summary.year),
    unknownYears: yearSummaries.filter(summary => summary.unknownCount > 0).map(summary => summary.year),
    robustSites: rows.filter(row => row.allYearsMeet)
  };
}
