// Historical evidence is not a site-safety classifier. No accident-derived veto thresholds
// are asserted where spacecraft design, descent trajectory or sensor telemetry are absent.
const advisors = [
  {
    id: 'hakuto-r-m1', mission: 'HAKUTO-R Mission 1', year: 2023,
    source: 'https://www.ispace-inc.com/2023/05/26/ispace-announces-results-of-the-hakuto-r-mission-1-lunar-landing/',
    evidence: 'ispace identified incorrect altitude estimation as the most likely cause: software rejected sensor readings after a crater-rim elevation change; descent continued until propellant exhaustion.',
    question: 'Has the navigation system been tested against terrain-driven altitude discontinuities along the entire descent path?',
    fields: ['elev_m', 'horizon_cdeg'], scope: 'Terrain context only',
    limit: 'Site elevation and a horizon profile do not describe the descent path or validate the altitude estimator. The report is not a universal terrain-height limit.',
  },
  {
    id: 'mars-polar-lander', mission: 'Mars Polar Lander', year: 1999,
    source: 'https://ntrs.nasa.gov/api/citations/20000032458/downloads/20000032458.pdf',
    evidence: 'The review identified premature engine shutdown from spurious touchdown signals during landing-leg deployment as the most probable failure mechanism.',
    question: 'Can landing-leg deployment generate a false touchdown signal that shuts down propulsion?',
    fields: [], scope: 'Engineering review required (Mars analogue)',
    limit: 'No touchdown-sensor logic, leg-deployment telemetry or propulsion interlocks are present in the site dataset. Selecting another location cannot establish that this failure is prevented.',
  },
  {
    id: 'peregrine-one', mission: 'Peregrine Mission One', year: 2024,
    source: 'https://www.astrobotic.com/wp-content/uploads/2024/08/PM1_Post-Mission-Report_2.4_Web.pdf',
    evidence: 'The review board attributed the anomaly most likely to loss of sealing in helium pressure-control valve PCV2, with vibration-related relaxation of internal threaded components.',
    question: 'Has the pressure-control valve retained sealing performance after representative launch vibration?',
    fields: [], scope: 'Engineering review required',
    limit: 'Valve construction, qualification and pressure telemetry are absent. Landing-site light, slope and Earth visibility cannot test this mechanism.',
  },
];
// Contract: pass is true/false only when a sourced test is conclusive, null otherwise.
// All current cases require engineering evidence absent from this landing-site dataset.
// This function does not modify its inputs, rankSites results, scores or requirement verdicts.
//
// `entry` is part of the agreed signature and deliberately unread today. It carries the rankSites
// result for the site (stats, ground, fails, verdicts), which is what a future rule would need to
// observe something the raw site record does not hold -- a measured slope from the zone grid, say.
// Keeping it in the signature means adding such a rule does not change the contract or the call
// site. It is not read now because no sourced case here has a test that ground data can settle.
export function reviewSite(site = {}, entry = {}) {
  return advisors.map(rule => {
    const observations = [];
    if (rule.id === 'hakuto-r-m1') {
      if (Number.isFinite(site.elev_m)) observations.push(`Site elevation: ${site.elev_m.toFixed(0)} m.`);
      const horizon = Array.from(site.horizon_cdeg || []).filter(Number.isFinite);
      if (horizon.length) observations.push(`Horizon elevation range: ${(Math.min(...horizon)/100).toFixed(2)} to ${(Math.max(...horizon)/100).toFixed(2)} degrees.`);
    }
    return {
      mission: rule.mission,
      year: rule.year,
      source: rule.source,
      failure: rule.evidence,
      field: rule.fields.length ? rule.fields.join(', ') : 'No applicable site-data field',
      pass: null,
      value: observations.length ? observations.join(' ') : 'No applicable measurements available',
      // Joined with a sentence break after each part. A plain ' ' join ran the scope straight
      // into the limit ("Terrain context only Site elevation and a horizon profile do not..."),
      // which reads as one broken sentence and leaves a caller no way to separate the parts.
      note: [rule.question, rule.scope, rule.limit,
        'Not verified. No official universal threshold is asserted; no safety score or failure probability is inferred.']
        .map((part) => (/[.?!]$/.test(part) ? part : `${part}.`)).join(' '),
    };
  });
}
