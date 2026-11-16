// Advisory Board. Opens from the floating launcher button, the calendar's
// "Advisory Board" button, a second click on a site row, or the #board URL hash.
// The discussion is simulated: every opinion is generated from the selected site's figures and
// cites a real mission. It is labelled as such on screen, because the people pictured are real.

import seat1 from './assets/board-1.jpg';
import seat2 from './assets/board-2.jpg';
import seatUllman from './assets/board-ullman.jpg';
import seat4 from './assets/board-4.jpg';
import seat5 from './assets/board-5.jpg';

// Seat order follows the Artemis stage photo, left to right; Jeffrey Ullman takes the centre seat.
const MEMBERS = [
  { key: 'cmdr', name: 'Commander', photo: seat1, role: 'Astronaut · Board seat 1', focus: 'Terrain & touchdown safety' },
  { key: 'ops', name: 'Operations Lead', photo: seat2, role: 'ESA astronaut · Board seat 2', focus: 'Operations & Earth link' },
  { key: 'ullman', name: 'Jeffrey Ullman', photo: seatUllman, role: 'Computer scientist · Stanford University', focus: 'Data, algorithms & uncertainty' },
  { key: 'fe', name: 'Flight Engineer', photo: seat4, role: 'Astronaut · Board seat 4', focus: 'Power & surviving the night' },
  { key: 'pilot', name: 'Test Pilot', photo: seat5, role: 'Astronaut · Board seat 5', focus: 'Precision landing & approach' },
];

const FACTORS = [
  { key: 'terrain', label: 'Terrain & slope' },
  { key: 'nav', label: 'Navigation & software' },
  { key: 'power', label: 'Sunlight & night' },
  { key: 'comms', label: 'Earth link' },
  { key: 'hardware', label: 'Hardware' },
];

// Real missions. factors: 'risk' = contributed to trouble, 'proof' = demonstrated the capability.
const EVIDENCE = {
  apollo11: {
    mission: 'Apollo 11', year: 1969, agency: 'NASA', lat: 0.7, region: 'Mare Tranquillitatis', outcome: 'success',
    what: 'Armstrong took manual control to fly past a boulder-strewn crater while 1201/1202 computer alarms sounded. Eagle touched down with only seconds of descent-fuel margin left.',
    lesson: 'Even a surveyed site can hide hazards in the last minute — a landing needs margin to re-target.',
    factors: { terrain: 'risk', nav: 'risk' }, src: 'https://en.wikipedia.org/wiki/Apollo_11',
  },
  apollo12: {
    mission: 'Apollo 12', year: 1969, agency: 'NASA', lat: -3.0, region: 'Oceanus Procellarum', outcome: 'success',
    what: 'Intrepid landed about 180 m from the Surveyor 3 probe — the first pinpoint landing on the Moon.',
    lesson: 'Landing at a chosen point was proven in 1969, so a site can be chosen precisely.',
    factors: { nav: 'proof' }, src: 'https://en.wikipedia.org/wiki/Apollo_12',
  },
  apollo15: {
    mission: 'Apollo 15', year: 1971, agency: 'NASA', lat: 26.1, region: 'Hadley–Apennine', outcome: 'success',
    what: 'Falcon came to rest with one footpad in a small crater, tilted about 11° — close to what the Lunar Module was designed to tolerate.',
    lesson: 'Slope inside the landing ellipse eats directly into touchdown margin.',
    factors: { terrain: 'risk' }, src: 'https://en.wikipedia.org/wiki/Apollo_15',
  },
  change4: {
    mission: "Chang'e 4", year: 2019, agency: 'CNSA', lat: -45.5, region: 'Von Kármán crater, far side', outcome: 'success',
    what: 'First landing on the far side. With no direct line of sight to Earth, every command and image passed through the Queqiao relay satellite beyond the Moon.',
    lesson: 'A site without direct Earth visibility can work — but only with a dedicated relay.',
    factors: { comms: 'proof' }, src: 'https://en.wikipedia.org/wiki/Chang%27e_4',
  },
  chandrayaan3: {
    mission: 'Chandrayaan-3', year: 2023, agency: 'ISRO', lat: -69.4, region: 'South polar highlands', outcome: 'success',
    what: 'Vikram and the Pragyan rover landed farther south than any earlier lander and worked through one lunar day on solar power. Neither woke up after the lunar night.',
    lesson: 'Near the pole, surviving the night — not the landing — sets how long a mission lasts.',
    factors: { power: 'risk', nav: 'proof' }, src: 'https://en.wikipedia.org/wiki/Chandrayaan-3',
  },
  luna25: {
    mission: 'Luna 25', year: 2023, agency: 'Roscosmos', lat: -69.5, region: 'Boguslawsky crater (target)', outcome: 'failed', latNote: 'target',
    what: 'An orbit-lowering engine burn ran longer than commanded, and the spacecraft crashed before it could attempt its south-polar landing.',
    lesson: 'Many failures happen before site conditions matter at all.',
    factors: { hardware: 'risk', nav: 'risk' }, src: 'https://en.wikipedia.org/wiki/Luna_25',
  },
  hakuto: {
    mission: 'HAKUTO-R M1', year: 2023, agency: 'ispace', lat: 47.5, region: 'Atlas crater', outcome: 'failed',
    what: 'After the lander crossed a crater rim, its software rejected altimeter readings that were actually correct. It believed it was lower than it was and ran out of fuel above the surface.',
    lesson: 'Rugged terrain along the approach path can confuse altitude estimation.',
    factors: { terrain: 'risk', nav: 'risk' },
    src: 'https://www.ispace-inc.com/2023/05/26/ispace-announces-results-of-the-hakuto-r-mission-1-lunar-landing/',
  },
  slim: {
    mission: 'SLIM', year: 2024, agency: 'JAXA', lat: -13.3, region: 'Shioli crater', outcome: 'partial',
    what: 'Landed inside its 100 m target zone — a precision first — but an engine anomaly left it resting on its nose with solar cells facing west. It only had power when afternoon sun reached them, yet it survived several lunar nights.',
    lesson: 'Precision and power are separate problems; solving one does not solve the other.',
    factors: { nav: 'proof', power: 'risk', hardware: 'risk' }, src: 'https://en.wikipedia.org/wiki/Smart_Lander_for_Investigating_Moon',
  },
  im1: {
    mission: 'IM-1 Odysseus', year: 2024, agency: 'Intuitive Machines', lat: -80.1, region: 'Malapert A', outcome: 'partial',
    what: "Its laser rangefinders couldn't be used because a safety switch had not been enabled, so it landed using an experimental NASA lidar. It touched down moving sideways, broke a leg and tipped over, leaving its antennas poorly pointed at Earth.",
    lesson: 'At the pole, how a lander comes to rest decides both its power and its link to Earth.',
    factors: { nav: 'risk', terrain: 'risk', comms: 'risk' }, src: 'https://en.wikipedia.org/wiki/IM-1',
  },
  peregrine: {
    mission: 'Peregrine M1', year: 2024, agency: 'Astrobotic', lat: null, region: 'Never reached the Moon', outcome: 'failed',
    what: 'A helium pressure-control valve failed shortly after launch, and the spacecraft never attempted a landing.',
    lesson: 'No landing site can compensate for a hardware failure in cruise.',
    factors: { hardware: 'risk' }, src: 'https://www.astrobotic.com/wp-content/uploads/2024/08/PM1_Post-Mission-Report_2.4_Web.pdf',
  },
  im2: {
    mission: 'IM-2 Athena', year: 2025, agency: 'Intuitive Machines', lat: -84.5, region: 'Mons Mouton region', outcome: 'failed', latNote: 'approx.',
    what: 'Came down on its side inside a cold, shadowed crater a few hundred metres from its target. With its solar panels barely lit, the mission was declared over within about a day.',
    lesson: 'A few hundred metres at the pole can be the difference between sunlight and shadow.',
    factors: { terrain: 'risk', power: 'risk', nav: 'risk' }, src: 'https://en.wikipedia.org/wiki/IM-2',
  },
  blueghost: {
    mission: 'Blue Ghost M1', year: 2025, agency: 'Firefly', lat: 18.6, region: 'Mare Crisium', outcome: 'success',
    what: 'Its hazard-avoidance system guided a clean, upright landing. It then operated through a full lunar day and recorded sunset from the surface.',
    lesson: 'Onboard hazard avoidance turns a good site into a safe touchdown.',
    factors: { nav: 'proof', power: 'proof' }, src: 'https://en.wikipedia.org/wiki/Blue_Ghost_Mission_1',
  },
};
const EV_ORDER = Object.keys(EVIDENCE).sort((a, b) => EVIDENCE[a].year - EVIDENCE[b].year);

const STANCE = {
  support: { label: 'SUPPORTS', cls: 'support' },
  conditional: { label: 'CONDITIONAL', cls: 'conditional' },
  prefers: { label: 'PREFERS', cls: 'prefers' },
  undecided: { label: 'ABSTAINS', cls: 'undecided' },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const fin = Number.isFinite;
const pct = (v) => (fin(v) ? `${v.toFixed(1)}%` : '—');
const hrs = (v) => (fin(v) ? `${Math.round(v)} h` : '—');
const deg = (v) => (fin(v) ? `${v.toFixed(1)}°` : '—');
const pretty = (s) => (s && s === s.toUpperCase() && /[A-Z]{3}/.test(s)
  ? s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : s);
const nm = (e) => pretty(e?.site?.en || e?.site?.name || e?.site?.id || '—');

// ── Opinion engine ─────────────────────────────────────────────────────────────

function buildCtx(site, entry, ranked, year) {
  const pool = ranked.length ? ranked : [entry];
  const st = entry?.stats || {};
  const g = entry?.ground || null;
  const others = pool.filter((e) => e.site.id !== site.id);
  const best = (key, dir, list = others.filter((e) => e.meetsAll)) => {
    const src = (list.length ? list : others).filter((e) => fin(key(e)));
    return src.sort((a, b) => dir * (key(a) - key(b)))[0] || null;
  };
  const rank = pool.findIndex((e) => e.site.id === site.id) + 1;
  return {
    name: pretty(site.en || site.name || site.id), site, entry, year, pool,
    sun: st.sun_visible_pct, earth: st.earth_visible_pct, dark: st.longest_dark_h, blind: st.longest_blind_h,
    slope: g?.slopeDeg, ice: g?.iceDistKm, hasGround: !!g && fin(g.slopeDeg),
    meets: !!entry?.meetsAll, fails: entry?.fails || [],
    top: pool[0], isTop: pool[0]?.site.id === site.id, rank: rank || null, size: pool.length,
    source: site.source,
    flattest: best((e) => e.ground?.slopeDeg, 1),
    bestEarth: best((e) => e.stats?.earth_visible_pct, -1),
    shortestNight: best((e) => e.stats?.longest_dark_h, 1),
    yearLabel: year ? `${year} annual means` : '2026–2040 averages',
  };
}

const JUDGES = {
  cmdr(c) {
    if (!c.hasGround) return {
      stance: 'undecided', ev: ['hakuto'], condition: 'a slope survey of the landing ellipse',
      text: `There's no ground classification under ${c.name}, so I can't tell you what slope the crew would land on. HAKUTO-R is the warning: uncharacterised terrain along the approach is what fooled its altimeter. I won't vote until we have slope data.`,
    };
    if (c.slope <= 5) return {
      stance: 'support', ev: ['apollo15'],
      text: `The first number I look at is slope: ${deg(c.slope)} at ${c.name}. Apollo 15 came to rest tilted about 11° with a footpad in a crater — survivable, but that's margin spent before anyone opens the hatch. At ${deg(c.slope)} we keep it. I support this site.`,
    };
    if (c.slope <= 10) return {
      stance: 'conditional', ev: ['apollo11'], condition: 'hazard avoidance with re-targeting margin',
      text: `${c.name} sits at ${deg(c.slope)}. Landable, but not forgiving. Apollo 11 only got down because Armstrong could fly past a boulder field by hand with seconds of fuel left. I'll support it if the lander carries hazard avoidance with real re-targeting margin.`,
    };
    return {
      stance: 'prefers', alt: c.flattest, ev: ['apollo15', 'im1'],
      text: `${deg(c.slope)} is steeper than the 11° Apollo 15 ended up at, and that was near the limit. IM-1 touched down moving sideways and tipped over. I'd rather fly ${nm(c.flattest)} at ${deg(c.flattest?.ground?.slopeDeg)}.`,
    };
  },
  ops(c) {
    const outage = fin(c.blind) ? ` The longest outage is ${hrs(c.blind)}.` : '';
    if (c.earth >= 80) return {
      stance: 'support', ev: ['change4'],
      text: `${c.name} sees Earth ${pct(c.earth)} of the time.${outage} Chang'e 4 needed a relay satellite beyond the Moon just to talk to its lander; we wouldn't. For operations, this is as good as it gets. Support.`,
    };
    if (c.earth >= 50) return {
      stance: 'conditional', ev: ['change4', 'im1'], condition: 'relay coverage or critical ops scheduled inside Earth-visibility windows',
      text: `At ${pct(c.earth)} Earth visibility we're out of direct contact roughly ${(100 - c.earth).toFixed(0)}% of the year.${outage} Chang'e 4 shows a relay solves that; IM-1 shows how fast a weak link turns surface time into lost time. I'll support it with a relay plan.`,
    };
    return {
      stance: 'prefers', alt: c.bestEarth, ev: ['change4', 'im1'],
      text: `${pct(c.earth)} Earth visibility is too little to run a surface mission directly. Chang'e 4 managed only because a relay was built for it. Unless we're paying for one, I'd go to ${nm(c.bestEarth)} at ${pct(c.bestEarth?.stats?.earth_visible_pct)}.`,
    };
  },
  ullman(c) {
    const intro = `Before we argue, let's be clear what these numbers are: ${c.yearLabel} from a horizon model sampled every 3 hours, not measurements on the ground. A model can be confidently wrong — HAKUTO-R's software threw out altimeter readings that were correct because they didn't fit what it expected.`;
    const scan = c.source === 'data' ? ` I do like that ${c.name} came out of a systematic grid scan rather than being hand-picked; that's reproducible.` : '';
    if (c.isTop) return {
      stance: 'conditional', ev: ['hakuto'], condition: 'publishing the model uncertainty alongside the ranking',
      text: `${intro}${scan} That said, the method is consistent: ${c.name} ranks first of ${c.size}. I'll back it if we publish the uncertainty with the score.`,
    };
    return {
      stance: 'prefers', alt: c.top, ev: ['hakuto'],
      text: `${intro}${scan} And by the method we agreed on, ${c.name} ranks #${c.rank} of ${c.size}; ${nm(c.top)} ranks first. If we override the ranking, we should write down why.`,
    };
  },
  fe(c) {
    if (c.dark <= 150 && c.sun >= 70) return {
      stance: 'support', ev: ['chandrayaan3'],
      text: `The night is what kills landers. Chandrayaan-3 did excellent work for one lunar day and never woke up again. ${c.name}'s worst night is ${hrs(c.dark)}, with the Sun up ${pct(c.sun)} of the time — a night we can carry on batteries. Support.`,
    };
    if (c.dark <= 300) return {
      stance: 'conditional', ev: ['slim', 'chandrayaan3'], condition: `batteries and heaters sized for ${hrs(c.dark)} of darkness`,
      text: `${c.name}'s worst night is ${hrs(c.dark)}, Sun up ${pct(c.sun)}. Long, but SLIM survived several lunar nights even lying on its nose, while Chandrayaan-3, not built for the night, never woke. I'll support it if the power budget is sized for ${hrs(c.dark)} with margin.`,
    };
    return {
      stance: 'prefers', alt: c.shortestNight, ev: ['im2', 'chandrayaan3'],
      text: `${hrs(c.dark)} of darkness is mission-ending unless we bring a heat source. IM-2 ended up in a cold, shadowed crater and was finished within about a day. I'd go with ${nm(c.shortestNight)}, worst night ${hrs(c.shortestNight?.stats?.longest_dark_h)}.`,
    };
  },
  pilot(c) {
    if (c.isTop) return {
      stance: 'support', ev: ['apollo12', 'slim', 'blueghost'],
      text: `Precision isn't the problem it was. Apollo 12 set down about 180 m from Surveyor 3; SLIM landed inside a 100 m target zone; Blue Ghost brought itself down clean and upright. If we can hit a point, pick the best point — on the data, that's ${c.name}.`,
    };
    if (c.meets) return {
      stance: 'prefers', alt: c.top, ev: ['apollo12', 'slim'],
      text: `${c.name} meets every requirement, so I can fly it. But it ranks #${c.rank}; ${nm(c.top)} ranks first. Apollo 12 and SLIM proved we can land where we aim — so let's aim at the best site.`,
    };
    return {
      stance: 'prefers', alt: c.top, ev: ['apollo12'],
      text: `${c.name} fails ${c.fails.length} mission requirement${c.fails.length === 1 ? '' : 's'}: ${(c.fails[0] || '').replace(/\.$/, '').toLowerCase()}. Precision landing doesn't fix a site that doesn't meet the mission. I'd fly ${nm(c.top)}.`,
    };
  },
};

// Round 2: each member answers one colleague. Picked so that disagreements are aired first.
const REBUTTALS = {
  ops: { to: 'cmdr', ev: ['im1'], text: () => `A perfect touchdown with no link is a silent touchdown. IM-1 survived its landing, but the way it came to rest pointed its antennas badly and cost it days of data.` },
  ullman: { to: 'fe', ev: [], text: (c) => `You're quoting the worst case. ${hrs(c.dark)} is the single longest night across 2026–2040; most years are milder. Decide on the spread across years, not just the extreme — though the extreme is what the batteries must survive.` },
  cmdr: { to: 'ullman', ev: ['apollo11', 'blueghost'], text: () => `Agreed the model can be wrong — which is exactly why I want a lander that can change its mind near the ground. Apollo 11 and Blue Ghost both got down because something on board, a pilot or a hazard-avoidance system, could re-target.` },
  fe: { to: 'pilot', ev: ['slim'], text: (c) => `Precision gets us to the right spot; it doesn't keep the batteries warm. SLIM landed where it aimed and still lived on whatever afternoon sun reached its panels. At ${c.name}, the ${hrs(c.dark)} night is the real constraint.` },
  pilot: { to: 'ops', ev: ['luna25'], text: () => `Comm windows can be scheduled; a bad descent can't be undone. Luna 25 never even reached its landing attempt — one engine burn that ran long ended it. Get the descent right first.` },
};

function runDebate(c) {
  const opinions = {};
  for (const m of MEMBERS) opinions[m.key] = JUDGES[m.key](c);
  const order = [...MEMBERS].sort((a, b) => (opinions[a.key].stance === 'support') - (opinions[b.key].stance === 'support'));
  const differs = (k) => opinions[k].stance !== opinions[REBUTTALS[k].to].stance;
  const replies = [...order.filter((m) => differs(m.key)), ...order.filter((m) => !differs(m.key))].slice(0, 3)
    .map((m) => ({ from: m.key, to: REBUTTALS[m.key].to, ev: REBUTTALS[m.key].ev, text: REBUTTALS[m.key].text(c) }));
  const count = { support: 0, conditional: 0, prefers: 0, undecided: 0 };
  for (const o of Object.values(opinions)) count[o.stance]++;
  const yes = count.support + count.conditional;
  const conditions = MEMBERS.map((m) => opinions[m.key].condition).filter(Boolean);
  const altVotes = {};
  for (const o of Object.values(opinions)) if (o.stance === 'prefers' && o.alt) altVotes[nm(o.alt)] = (altVotes[nm(o.alt)] || 0) + 1;
  const favAlt = Object.entries(altVotes).sort((a, b) => b[1] - a[1])[0]?.[0];
  const decision = yes >= 3
    ? { cls: count.conditional ? 'conditional' : 'support', label: count.conditional ? 'APPROVED WITH CONDITIONS' : 'APPROVED' }
    : { cls: 'prefers', label: favAlt ? `NOT APPROVED — MAJORITY LEANS TO ${favAlt.toUpperCase()}` : 'NOT APPROVED' };
  return { opinions, replies, count, yes, conditions, decision };
}

function weakFactors(c) {
  const w = new Set();
  if (!c.hasGround || c.slope > 5) w.add('terrain');
  if (!(c.sun >= 70) || !(c.dark <= 150)) w.add('power');
  if (!(c.earth >= 80)) w.add('comms');
  return w;
}

// ── DOM ─────────────────────────────────────────────────────────────────────────

let _boardEl = null;
let _proceed = null;
let _ranked = [];
const $ = (id) => document.getElementById(id);
const member = (k) => MEMBERS.find((m) => m.key === k);

// Scroll a child into view inside its own scrolling container only, so the fixed-height
// dashboard frame never shifts.
function scrollWithin(container, el, axis = 'y') {
  if (!container || !el) return;
  const c = container.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (axis === 'x') container.scrollTo({ left: container.scrollLeft + r.left - c.left - 12, behavior: 'smooth' });
  else container.scrollTo({ top: container.scrollTop + r.top - c.top - 12, behavior: 'smooth' });
}

export function mountBoard(boardEl) {
  _boardEl = boardEl;
  if (!boardEl) return;
  $('bd-close')?.addEventListener('click', hideBoard);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !_boardEl.hidden) hideBoard();
  });
  for (const tab of boardEl.querySelectorAll('.hi-tab')) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  }
  // A vertical mouse wheel over the mission strip scrolls it sideways.
  boardEl.addEventListener('wheel', (ev) => {
    const strip = ev.target.closest('.hi-strip');
    if (!strip || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
    strip.scrollLeft += ev.deltaY;
    ev.preventDefault();
  }, { passive: false });
  boardEl.addEventListener('click', (ev) => {
    const nav = ev.target.closest('[data-strip]');
    if (nav) { boardEl.querySelector('.hi-strip')?.scrollBy({ left: Number(nav.dataset.strip) * 340, behavior: 'smooth' }); return; }
    const chip = ev.target.closest('[data-ev]');
    if (chip) { showEvidence(chip.dataset.ev); return; }
    const seat = ev.target.closest('[data-seat]');
    if (seat && !$('bd-session').hidden) {
      selectTab('disc');
      const msg = $(`bd-msg-${seat.dataset.seat}`);
      scrollWithin(msg?.closest('.hi-round-body'), msg);
      flash(msg);
    }
  });
}

export function hideBoard() {
  if (!_boardEl) return;
  _boardEl.hidden = true;
  document.body.classList.remove('board-open');
}

function selectTab(name) {
  for (const tab of _boardEl.querySelectorAll('.hi-tab')) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    $(tab.getAttribute('aria-controls')).hidden = !on;
  }
}

function flash(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function showEvidence(key) {
  selectTab('hist');
  const card = $(`bd-ev-${key}`);
  requestAnimationFrame(() => scrollWithin(card?.closest('.hi-strip'), card, 'x'));
  flash(card);
}

function evChip(key) {
  const e = EVIDENCE[key];
  return `<button type="button" class="p2-ev-chip" data-ev="${key}" title="Open in Historical evidence"><i class="p2-dot ${e.outcome}"></i><b>${esc(e.mission)}</b><span>${e.year}</span></button>`;
}

function avatar(m, size = '') {
  return `<img class="p2-avatar ${size}" src="${m.photo}" alt="" loading="lazy">`;
}

function stanceTag(o) {
  const s = STANCE[o.stance];
  const alt = o.stance === 'prefers' && o.alt ? ` ${esc(o.alt.site.id)}` : '';
  return `<span class="p2-stance ${s.cls}">${s.label}${alt}</span>`;
}

function renderPanel(debate) {
  $('bd-panel').innerHTML = MEMBERS.map((m) => {
    const o = debate?.opinions[m.key];
    return `<button type="button" class="hi-seat ${o ? STANCE[o.stance].cls : 'pending'}" data-seat="${m.key}" title="${o ? 'Show opening statement' : ''}">
      ${avatar(m, 'seat')}
      <span class="hi-seat-txt"><b>${esc(m.name)}</b><small>${esc(m.focus)}</small></span>
      ${o ? stanceTag(o) : '<span class="p2-stance pending">SEALED</span>'}
    </button>`;
  }).join('');
}

export function showBoard({ site, entry, year, dateLabel, ranked, onProceed }) {
  if (!_boardEl) return;
  _ranked = ranked || [];
  _proceed = onProceed;
  _boardEl.hidden = false;
  document.body.classList.add('board-open');

  const c = buildCtx(site, entry, _ranked, year);
  $('bd-site-id').textContent = site.id;
  $('bd-site-name').textContent = c.name;
  $('bd-site-meta').innerHTML = [
    dateLabel ? `<b>Arrival ${esc(dateLabel)}</b>` : year ? `<b>Arrival year ${year}</b>` : '<b>No arrival date yet</b> · 2026–2040 averages',
    c.rank ? `Ranked #${c.rank} of ${c.size}` : null,
    c.meets ? 'Meets mission requirements' : 'Fails mission requirements',
  ].filter(Boolean).join('<i></i>');

  renderPanel(null);
  renderMetrics(c);
  $('bd-verdict').innerHTML = '<span class="hi-verdict-label">PANEL VERDICT</span><b class="hi-verdict-decision sealed">Votes sealed</b><span class="hi-verdict-sub">Make your call to reveal how the panel votes.</span>';
  $('bd-gate').hidden = false;
  $('bd-session').hidden = true;
  $('bd-cert').disabled = true;
  $('bd-proceed').disabled = true;

  const choicesEl = $('bd-choices');
  const submitBtn = $('bd-submit');
  choicesEl.textContent = '';
  submitBtn.disabled = true;
  let userChoice = null;
  const pool = _ranked.length ? _ranked : [entry];
  for (const e of pool.slice(0, 6)) {
    const s = e.site;
    const btn = document.createElement('button');
    btn.className = `hi-choice${e.meetsAll ? '' : ' fails'}${s.id === site.id ? ' current' : ''}`;
    btn.type = 'button';
    btn.innerHTML = `<i>${esc(s.id)}</i><span><b>${esc(pretty(s.en))}</b><small>${pct(e.stats?.sun_visible_pct)} sun · ${pct(e.stats?.earth_visible_pct)} link · ${hrs(e.stats?.longest_dark_h)} dark</small>${e.meetsAll ? '' : '<em>Fails requirements</em>'}</span>`;
    btn.addEventListener('click', () => {
      userChoice = s.id;
      submitBtn.disabled = false;
      for (const b of choicesEl.children) b.classList.toggle('selected', b === btn);
    });
    choicesEl.appendChild(btn);
  }
  submitBtn.onclick = () => userChoice && buildSession(c, userChoice);
  $('bd-skip').onclick = () => buildSession(c, null);
}

function buildSession(c, userChoice) {
  const { site, entry, year } = c;
  $('bd-gate').hidden = true;
  $('bd-session').hidden = false;
  const debate = runDebate(c);
  renderPanel(debate);
  selectTab('disc');

  const topId = c.top?.site.id ?? site.id;
  const correct = userChoice === topId;
  const resultEl = $('bd-result');
  resultEl.className = `hi-result ${userChoice == null ? 'skip' : correct ? 'pass' : 'diff'}`;
  resultEl.innerHTML = userChoice == null
    ? `<b>Quiz skipped</b><span>Data ranks ${esc(nm(c.top))} first</span>`
    : correct
      ? `<b>Your pick matches the data</b><span>${esc(nm(c.top))} ranks first</span>`
      : `<b>You picked ${esc(userChoice)}</b><span>Data ranks ${esc(nm(c.top))} first</span>`;

  renderVerdict(debate, c);
  renderThread(debate, c);
  renderHistory(c, debate);

  $('bd-cert').disabled = false;
  $('bd-proceed').disabled = false;
  $('bd-cert').onclick = () => downloadCert({ site, entry, year, correct, userChoice, topSiteId: topId, decision: debate.decision.label });
  $('bd-proceed').onclick = () => {
    hideBoard();
    if (_proceed) _proceed();
  };
}

function renderMetrics(c) {
  const vals = (f) => c.pool.map(f).filter(fin).sort((a, b) => a - b);
  const card = ({ label, value, v, scale, best, median, mark, markLabel, note }) => {
    const p = (x) => Math.max(0, Math.min(100, (x / scale) * 100)).toFixed(1);
    return `<div class="hi-metric">
      <span class="hi-metric-label">${label}</span>
      <span class="hi-metric-value">${value}</span>
      <div class="hi-metric-track">
        ${fin(v) ? `<i class="hi-metric-fill" style="width:${p(v)}%"></i>` : ''}
        ${fin(median) ? `<i class="hi-tick median" style="left:${p(median)}%" title="Pool median"></i>` : ''}
        ${fin(best) ? `<i class="hi-tick best" style="left:${p(best)}%" title="Best in pool"></i>` : ''}
        ${fin(mark) ? `<i class="hi-tick mark" style="left:${p(mark)}%" title="${markLabel}"></i>` : ''}
      </div>
      <span class="hi-metric-note">${note}</span>
    </div>`;
  };
  const sun = vals((e) => e.stats?.sun_visible_pct);
  const earth = vals((e) => e.stats?.earth_visible_pct);
  const dark = vals((e) => e.stats?.longest_dark_h);
  const slope = vals((e) => e.ground?.slopeDeg);
  const med = (a) => a[Math.floor(a.length / 2)];
  $('bd-metrics').innerHTML = [
    card({ label: 'SUN VISIBLE', value: pct(c.sun), v: c.sun, scale: 100, best: sun.at(-1), median: med(sun), note: 'Power' }),
    card({ label: 'EARTH LINK', value: pct(c.earth), v: c.earth, scale: 100, best: earth.at(-1), median: med(earth), mark: 80, markLabel: '80% continuous-contact line', note: 'Line = 80%' }),
    card({ label: 'LONGEST DARK', value: hrs(c.dark), v: c.dark, scale: Math.max(dark.at(-1) || 1, c.dark || 1), best: dark[0], median: med(dark), note: 'Lower is better' }),
    card({ label: 'SLOPE', value: deg(c.slope), v: c.slope, scale: 15, best: slope[0], median: med(slope), mark: 11, markLabel: 'Apollo 15 rest tilt (~11°)', note: 'Line = Apollo 15' }),
  ].join('');
  $('bd-metrics-legend').innerHTML = '<span><i class="hi-tick best"></i>Best in pool</span><span><i class="hi-tick median"></i>Median</span><span><i class="hi-tick mark"></i>Reference</span>';
}

function renderVerdict(debate) {
  const seg = MEMBERS.map((m) => {
    const o = debate.opinions[m.key];
    return `<i class="${STANCE[o.stance].cls}" title="${esc(m.name)}: ${STANCE[o.stance].label}"></i>`;
  }).join('');
  const legend = Object.entries(debate.count).filter(([, n]) => n)
    .map(([k, n]) => `<span><i class="p2-dot ${STANCE[k].cls}"></i>${n} ${STANCE[k].label.toLowerCase()}</span>`).join('');
  $('bd-verdict').innerHTML = `
    <span class="hi-verdict-label">PANEL VERDICT</span>
    <b class="hi-verdict-decision ${debate.decision.cls}">${esc(debate.decision.label)}</b>
    <div class="hi-tally">${seg}</div>
    <div class="hi-tally-legend">${legend}</div>`;
}

function renderThread(debate, c) {
  const msg = (key, o, { id = '', reply = null } = {}) => {
    const m = member(key);
    return `<article class="hi-msg${reply ? ' reply' : ''}" ${id ? `id="${id}"` : ''}>
      <header>${avatar(m, 'sm')}<span class="hi-who"><b>${esc(m.name)}</b>${reply ? `<small>↳ to ${esc(member(reply).name)}</small>` : `<small>${esc(m.focus)}</small>`}</span>${o.stance ? stanceTag(o) : ''}</header>
      <p>${esc(o.text)}</p>
      <div class="hi-msg-ev">${o.ev?.length ? o.ev.map(evChip).join('') : '<em>Method note — no mission cited</em>'}</div>
    </article>`;
  };
  const final = (key) => {
    const m = member(key);
    const o = debate.opinions[key];
    const line = {
      support: `Votes for ${c.name}.`,
      conditional: `Votes for ${c.name} if: ${o.condition}.`,
      prefers: `Votes for ${nm(o.alt)} instead.`,
      undecided: `Abstains until: ${o.condition}.`,
    }[o.stance];
    return `<li class="hi-final ${STANCE[o.stance].cls}">${avatar(m, 'sm')}<span class="hi-who"><b>${esc(m.name)}</b><small>${esc(line)}</small></span>${stanceTag(o)}</li>`;
  };
  const pool = c.pool.slice(0, 6);
  const votes = {};
  if (pool[0]) votes[pool[0].site.id] = 2;
  if (pool[1]) votes[pool[1].site.id] = 1;
  const volunteers = pool.map((e) => {
    const n = votes[e.site.id] || 0;
    return `<div class="hi-vol${e.site.id === c.site.id ? ' cur' : ''}"><i>${esc(e.site.id)}</i><span class="hi-vol-track"><b style="width:${(n / 3) * 100}%"></b></span><em>${n}</em></div>`;
  }).join('');
  $('bd-thread').innerHTML = `
    <section class="hi-round">
      <h3><span>1</span>Opening positions<small>${MEMBERS.length} statements</small></h3>
      <div class="hi-round-body">${MEMBERS.map((m) => msg(m.key, debate.opinions[m.key], { id: `bd-msg-${m.key}` })).join('')}</div>
    </section>
    <section class="hi-round">
      <h3><span>2</span>Challenge &amp; rebuttal<small>${debate.replies.length} replies</small></h3>
      <div class="hi-round-body">${debate.replies.map((r) => msg(r.from, { text: r.text, ev: r.ev }, { reply: r.to })).join('')}</div>
    </section>
    <section class="hi-round">
      <h3><span>3</span>Final vote<small>${debate.yes} of ${MEMBERS.length} back it</small></h3>
      <div class="hi-round-body">
        <div class="hi-chair ${debate.decision.cls}">
          <b>${esc(debate.decision.label)}</b>
          ${debate.conditions.length ? `<ul>${debate.conditions.map((x) => `<li>${esc(x.charAt(0).toUpperCase() + x.slice(1))}</li>`).join('')}</ul>` : '<span>No conditions attached.</span>'}
        </div>
        <ul class="hi-finals">${MEMBERS.map((m) => final(m.key)).join('')}</ul>
        <div class="hi-vols"><h4>Layer 2 · Qualified volunteers <small>3 votes · ≥85% on virtual tests</small></h4>${volunteers}</div>
      </div>
    </section>`;
}

function renderHistory(c, debate) {
  const weak = weakFactors(c);
  const citedBy = {};
  for (const m of MEMBERS) for (const k of debate.opinions[m.key].ev || []) (citedBy[k] ||= new Set()).add(m.key);
  for (const r of debate.replies) for (const k of r.ev) (citedBy[k] ||= new Set()).add(r.from);

  // Latitude dot plot: 50°N on the left to the south pole on the right.
  const xOf = (lat) => (((50 - lat) / 140) * 100).toFixed(2);
  const latTxt = (lat) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
  const landed = EV_ORDER.filter((k) => fin(EVIDENCE[k].lat)).sort((a, b) => EVIDENCE[b].lat - EVIDENCE[a].lat);
  const siteLat = c.site.lat;
  const latRows = landed.map((k) => {
    const e = EVIDENCE[k];
    return `<div class="p2-lat-row" data-ev="${k}"><span class="p2-lat-name">${esc(e.mission)}</span><span class="p2-lat-track"><i class="p2-lat-dot ${e.outcome}" style="left:${xOf(e.lat)}%"></i></span><span class="p2-lat-val">${latTxt(e.lat)}</span></div>`;
  }).join('');
  const siteRow = fin(siteLat) ? `<div class="p2-lat-row cur"><span class="p2-lat-name">${esc(c.name)}</span><span class="p2-lat-track"><i class="p2-lat-dot cur" style="left:${xOf(siteLat)}%"></i></span><span class="p2-lat-val">${latTxt(siteLat)}</span></div>` : '';
  const southmost = Math.min(...landed.map((k) => EVIDENCE[k].lat));
  const latNote = fin(siteLat) && siteLat < southmost
    ? `${esc(c.name)} is farther south than any lander has reached. The closest precedents, IM-1 and IM-2, both ended up on their sides.`
    : 'Landers have reached this latitude before; the records below show how they fared.';

  const matrix = `
    <table class="p2-matrix">
      <thead><tr><th></th>${FACTORS.map((f) => `<th class="${weak.has(f.key) ? 'watch' : ''}">${f.label}${weak.has(f.key) ? '<em>watch</em>' : ''}</th>`).join('')}</tr></thead>
      <tbody>${EV_ORDER.map((k) => {
        const e = EVIDENCE[k];
        return `<tr data-ev="${k}"><th><i class="p2-dot ${e.outcome}"></i>${esc(e.mission)}<small>${e.year}</small></th>${FACTORS.map((f) => {
          const v = e.factors[f.key];
          return `<td class="${weak.has(f.key) ? 'watch' : ''}">${v ? `<i class="p2-cell ${v}">${v === 'risk' ? '✕' : '✓'}</i>` : ''}</td>`;
        }).join('')}</tr>`;
      }).join('')}</tbody>
    </table>`;

  const cards = EV_ORDER.map((k) => {
    const e = EVIDENCE[k];
    const who = [...(citedBy[k] || [])];
    const tags = FACTORS.filter((f) => e.factors[f.key]).map((f) => `<span class="p2-tag ${e.factors[f.key]}${weak.has(f.key) ? ' watch' : ''}">${f.label}</span>`).join('');
    return `<article class="p2-ev-card ${e.outcome}${who.length ? ' cited' : ''}" id="bd-ev-${k}">
      <header><span class="p2-outcome ${e.outcome}">${e.outcome.toUpperCase()}</span><b>${esc(e.mission)}</b><small>${e.year} · ${esc(e.agency)}</small></header>
      <p class="p2-ev-where">${esc(e.region)}${fin(e.lat) ? ` · ${latTxt(e.lat)}${e.latNote ? ` (${e.latNote})` : ''}` : ''}</p>
      <div class="hi-ev-scroll">
        <p>${esc(e.what)}</p>
        <p class="p2-ev-lesson"><span>Lesson</span>${esc(e.lesson)}</p>
      </div>
      <div class="p2-ev-tags">${tags}</div>
      <footer>${who.length ? `<span class="p2-ev-who">Cited by ${who.map((mk) => avatar(member(mk), 'xs')).join('')}</span>` : '<span class="p2-ev-who">Not cited here</span>'}<a href="${e.src}" target="_blank" rel="noopener noreferrer">Source ↗</a></footer>
    </article>`;
  }).join('');

  $('bd-history').innerHTML = `
    <section class="hi-panel hi-lat">
      <h3>How far south have landers gone?</h3>
      <p class="hi-sub">${latNote}</p>
      <div class="hi-panel-scroll">
        <div class="p2-lat-row p2-lat-axis"><span></span><span class="p2-lat-scale"><em style="left:0">50°N</em><em style="left:35.7%">Equator</em><em style="left:67.9%">45°S</em><em style="left:100%">Pole</em></span><span></span></div>
        ${latRows}${siteRow}
      </div>
      <div class="hi-legend"><span><i class="p2-dot success"></i>Success</span><span><i class="p2-dot partial"></i>Partial</span><span><i class="p2-dot failed"></i>Failed</span><span><i class="p2-dot cur"></i>Your site</span></div>
    </section>
    <section class="hi-panel hi-mx">
      <h3>What decided each mission?</h3>
      <p class="hi-sub"><i class="p2-cell risk">✕</i> caused trouble · <i class="p2-cell proof">✓</i> proved it works · <b class="hi-watch">watch</b> = weak point at ${esc(c.name)}</p>
      <div class="hi-panel-scroll">${matrix}</div>
    </section>
    <section class="hi-panel hi-records">
      <header><h3>Mission records</h3><small>${EV_ORDER.length} missions, oldest first · scroll sideways or use the arrows</small>
        <span class="hi-strip-nav"><button type="button" data-strip="-1" aria-label="Previous missions">‹</button><button type="button" data-strip="1" aria-label="Next missions">›</button></span></header>
      <div class="hi-strip">${cards}</div>
    </section>`;
  $('bd-tab-hist-count').textContent = `${EV_ORDER.length} real missions`;
}

function downloadCert({ site, entry, year, correct, userChoice, topSiteId, decision }) {
  const W = 1200, H = 800;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#c0392b';
  ctx.lineWidth = 2;
  ctx.strokeRect(20, 20, W - 40, H - 40);
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = 1;
  ctx.strokeRect(28, 28, W - 56, H - 56);
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(20, 20, W - 40, 4);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e8e8e8';
  ctx.font = 'bold 26px "Courier New", monospace';
  ctx.fillText('LUNAR LANDING ADVISORY CERTIFICATE', W / 2, 95);
  ctx.fillStyle = '#333';
  ctx.fillRect(100, 110, W - 200, 1);
  ctx.fillStyle = '#c0392b';
  ctx.font = 'bold 46px "Courier New", monospace';
  ctx.fillText((site.en || site.name || site.id).toUpperCase(), W / 2, 190);
  ctx.fillRect(W / 2 - 22, 208, 44, 32);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 18px "Courier New", monospace';
  ctx.fillText(site.id, W / 2, 230);
  ctx.fillStyle = '#c3c3c3';
  ctx.font = '18px "Courier New", monospace';
  ctx.fillText(`ARRIVAL YEAR: ${year ?? 'UNSPECIFIED'}`, W / 2, 268);
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(100, 288, W - 200, 1);
  ctx.fillStyle = '#c3c3c3';
  ctx.font = '15px "Courier New", monospace';
  ctx.fillText(`Mission plan reviewed by the 6Dimensions Advisory Board on ${new Date().toISOString().slice(0, 10)}.`, W / 2, 334);
  ctx.fillStyle = '#e8e8e8';
  ctx.font = 'bold 15px "Courier New", monospace';
  ctx.fillText(`PANEL VERDICT: ${decision}`, W / 2, 364);
  ctx.fillStyle = correct ? '#6abf69' : '#e8b84b';
  ctx.font = 'bold 13px "Courier New", monospace';
  ctx.fillText(userChoice == null ? 'TRAINING: QUIZ SKIPPED.'
    : correct ? 'TRAINING: RECOMMENDATION MATCHED THE DATA RANKING.'
      : `TRAINING: USER PICKED ${userChoice}; DATA RANKS ${topSiteId} FIRST.`, W / 2, 394);
  if (entry?.stats) {
    const st = entry.stats;
    ctx.fillStyle = '#e8e8e8';
    ctx.font = '15px "Courier New", monospace';
    ctx.fillText(`SUN VISIBLE: ${pct(st.sun_visible_pct)}   EARTH LINK: ${pct(st.earth_visible_pct)}   LONGEST DARK: ${hrs(st.longest_dark_h)}`, W / 2, 436);
  }
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(100, 458, W - 200, 1);
  ctx.fillStyle = '#555';
  ctx.font = '11px "Courier New", monospace';
  ctx.fillText('Site data: LRO/LOLA terrain · JPL DE421 ephemeris · 3-hour steps · 2026–2040 mission window', W / 2, 486);
  ctx.fillText('Evidence: Apollo 11/12/15 · Chang\'e 4 · Chandrayaan-3 · Luna 25 · HAKUTO-R · SLIM · IM-1 · Peregrine · IM-2 · Blue Ghost', W / 2, 504);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(W - 240, H - 72, 190, 28);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px "Courier New", monospace';
  ctx.fillText('6DIMENSIONS', W - 60, H - 53);
  ctx.fillStyle = '#666';
  ctx.font = '10px "Courier New", monospace';
  ctx.fillText('SMARTER LUNAR DECISIONS', W - 50, H - 32);
  const a = document.createElement('a');
  a.download = `6D-board-cert-${site.id}-${year ?? 'open'}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}
