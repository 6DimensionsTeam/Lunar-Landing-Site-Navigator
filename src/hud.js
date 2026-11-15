// Interface layer: boot log, home HUD (title, body labels, candidate sites, countdown) and the simple explore-mode HUD.
// DOM only; every value is computed in main.js and passed in.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const fmtUTC = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const fmtInt = (v) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const signed = (v, d = 2) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
const fmtSpan = (h) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${Math.round(h)} h`);

// Big number on the countdown card: the largest unit that can be written as “at least 2 units”, rounded down (73.2 days left → 73 days)
const UNITS = [[86400, 'DAYS', 'DAY'], [3600, 'HOURS', 'HOUR'], [60, 'MINUTES', 'MINUTE'], [1, 'SECONDS', 'SECOND']];
function headline(s) {
  const [u, plural, singular] = UNITS.find(([u]) => s >= 2 * u) || UNITS[3];
  const n = Math.floor(s / u);
  return { n, unit: plural, en: n === 1 ? singular : `${singular}S` };
}

// Rajdhani digits are not monospaced. Live readouts (data-tab) put each digit in a cell of equal width so the line does not jitter sideways
function cells(el, text) {
  const frag = document.createDocumentFragment();
  for (const ch of text) {
    const i = document.createElement('i');
    i.className = ch >= '0' && ch <= '9' ? 'dg' : /[a-z]/i.test(ch) ? 'u' : 'sp';
    i.textContent = ch;
    frag.appendChild(i);
  }
  el.replaceChildren(frag);
}

function createBoot(total) {
  const root = $('#boot'), log = $('#boot-log'), bar = $('#boot-bar');
  const t0 = performance.now();
  // Log pacing: on a fast machine keep at least GAP between lines so none flashes past. The timestamp records when it really happened
  const GAP = reducedMotion.matches ? 0 : 60;
  let n = 0, chain = Promise.resolve();
  const ui = (fn) => (chain = chain.then(async () => { fn(); if (GAP) await sleep(GAP); }).catch((e) => console.error(e)));
  function line(msg) {
    const h = {}, at = performance.now();
    ui(() => {
      const li = document.createElement('li');
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = ((at - t0) / 1000).toFixed(2).padStart(6, '0');
      const m = document.createElement('span');
      m.className = 'msg';
      m.textContent = msg;
      const st = document.createElement('span');
      st.className = 'st';
      st.textContent = '···';
      li.append(ts, m, st);
      log.appendChild(li);
      Object.assign(h, { li, st });
    });
    return h;
  }
  function done(h, detail) {
    ui(() => {
      h.st.textContent = 'OK';
      h.st.classList.add('ok');
      if (detail) {
        const d = document.createElement('span');
        d.className = 'dt';
        d.textContent = detail;
        h.li.insertBefore(d, h.st);
      }
      n += 1;
      bar.style.transform = `scaleX(${Math.min(1, n / total)})`;
    });
  }
  // Get this line on screen first (two rAFs), then do the possibly heavy synchronous work
  async function run(msg, fn) {
    const l = line(msg);
    await nextFrame();
    await nextFrame();
    done(l, await fn());
  }
  function fail(err) {
    const h = line(`Start-up failed: ${(err && err.message) || err}`);
    ui(() => {
      h.li.classList.add('err');
      h.st.textContent = 'ERR';
      // A failed load has no later step to hand off to and nothing here will self-heal --
      // the only way out is to try again, so offer that instead of leaving the screen stuck.
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'boot-retry mini';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => location.reload());
      root.querySelector('.boot-box').appendChild(retry);
    });
  }
  async function finish() {
    done(line('SYSTEMS NOMINAL'), '');
    await chain;
    await sleep(reducedMotion.matches ? 150 : 480);
    root.classList.add('out');
    setTimeout(() => { root.hidden = true; }, 1100);
  }
  return { line, done, run, fail, finish };
}

// Label leader: diagonal length and candidate side (-1 up-left, 1 up-right). Flip to the other side when it does not fit; if neither fits, keep only the reticle
const LEADS = {
  earth: { len: 44, dirs: [-1, 1] }, sun: { len: 56, dirs: [1, -1] }, crater: { len: 50, dirs: [1, -1] },
  core: { len: 46, dirs: [-1, 1] }, ring: { len: 52, dirs: [1, -1] }, array: { len: 40, dirs: [1, -1] }, engine: { len: 40, dirs: [-1, 1] }, ocrater: { len: 44, dirs: [1, -1] },
};

export function createHud({ bootSteps }) {
  const boot = createBoot(bootSteps);
  const home = $('#home'), explore = $('#explore'), orbit = $('#orbit'), rover = $('#rover'), veilEl = $('#veil'), card = $('.card', home);
  const tags = Object.fromEntries([...$$('.tag', home), ...$$('.tag', orbit)].map((el) => [el.dataset.tag, el]));
  let sec = home;                       // the screen whose occluder region is being measured (home or relay)
  const sigs = {}, dirs = {}, lblSize = {}, labelW = {};
  const markers = {};
  const cache = new Map();
  let blockers = [], nFrame = 0;

  // Regions a label may not cover: title text, the text at both ends of the top bar and the hairline between them, the bottom panel
  // (measured every 30 frames, read then write, so no layout jitter)
  const textRect = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); return rg.getBoundingClientRect(); };
  function measure() {
    const tb = $('.topbar', sec).getBoundingClientRect(), mid = (tb.top + tb.bottom) / 2;
    blockers = [
      ...$$('.title > *, .ttl > *', sec).map(textRect),
      ...$$('.topbar > *, .dock > *', sec).map((el) => el.getBoundingClientRect()),
      new DOMRect(tb.left, mid - 4, tb.width, 8),
    ].filter((r) => r.width > 0);
    for (const [k, el] of Object.entries(tags)) { const l = $('.lbl', el); lblSize[k] = [l.offsetWidth, l.offsetHeight]; }
    for (const [id, mk] of Object.entries(markers)) labelW[id] = $('span', mk).offsetWidth;
  }
  let extra = [];                       // extra occluders added per frame (Earth and Sun in the relay view)
  function fits(x0, y0, x1, y1) {
    if (x0 < 8 || y0 < 8 || x1 > window.innerWidth - 8 || y1 > window.innerHeight - 8) return false;
    const hit = (b) => x1 > b.left - 6 && x0 < b.right + 6 && y1 > b.top - 6 && y0 < b.bottom + 6;
    return !blockers.some(hit) && !extra.some(hit);
  }

  function bind(k, text) {
    if (cache.get(k) === text) return;
    cache.set(k, text);
    for (const el of $$(`[data-k="${k}"]`)) {
      if (el.hasAttribute('data-tab')) cells(el, text);
      else el.textContent = text;
    }
  }
  function pill(k, on, text) {
    const el = $(`[data-pill="${k}"]`);
    el.dataset.state = on ? 'on' : 'off';
    el.textContent = text;
  }

  const elbow = (key, r, dx) => { const d = Math.SQRT1_2 * (r + 4 + LEADS[key].len); return [dx * d, -d]; };

  // Re-lay the reticle and leader from the reticle radius and side (only when they change)
  function layoutTag(key, r, dx) {
    const sig = `${Math.round(r * 2)}|${dx}`;
    if (sigs[key] === sig) return;
    sigs[key] = sig;
    const el = tags[key];
    const s = r + 7, box = `${-s} ${-s} ${2 * s} ${2 * s}`;
    const ret = $('.ret', el);
    ret.setAttribute('viewBox', box);
    Object.assign(ret.style, { left: `${-s}px`, top: `${-s}px`, width: `${2 * s}px`, height: `${2 * s}px` });
    if (key === 'earth') {
      $('circle', ret).setAttribute('r', r);
      $('path', ret).setAttribute('d', `M0 ${-r - 6}V${-r + 4}M0 ${r - 4}V${r + 6}M${-r - 6} 0H${-r + 4}M${r - 4} 0H${r + 6}`);
    } else if (key === 'sun') {
      const a = r * 0.42;
      $('path', ret).setAttribute('d', `M${-r} ${-r + a}V${-r}H${-r + a}M${r - a} ${-r}H${r}V${-r + a}M${r} ${r - a}V${r}H${r - a}M${-r + a} ${r}H${-r}V${r - a}`);
    } else {
      $('circle', ret).setAttribute('r', r);
    }
    const s0 = Math.SQRT1_2 * (r + 4);
    const [ex, ey] = elbow(key, r, dx);
    $('.lead polyline', el).setAttribute('points', `${(dx * s0).toFixed(1)},${(-s0).toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`);
    const lbl = $('.lbl', el);
    lbl.style.left = `${ex.toFixed(1)}px`;
    lbl.style.top = `${ey.toFixed(1)}px`;
    lbl.classList.toggle('l', dx < 0);
  }

  function place(el, p) {
    if (!p || !p.vis) {
      el.classList.add('off');
      return;
    }
    el.classList.remove('off');
    el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
  }

  // Pick a side: the current side first (no flipping back and forth), then the candidate order
  function placeTag(key, p, r) {
    const el = tags[key];
    // If the reticle itself falls under a panel or the title, hide the tag entirely (unreadable over a panel, and the leader has nowhere to go)
    if (p && p.vis && blockers.some((b) => p.x > b.left - 4 && p.x < b.right + 4 && p.y > b.top - 4 && p.y < b.bottom + 4)) p = null;
    if (p && p.vis) {
      const [w, h] = lblSize[key] || [0, 0];
      const order = [dirs[key], ...LEADS[key].dirs].filter((d) => d != null);
      let dir = null;
      for (const dx of order) {
        const [ex, ey] = elbow(key, r, dx);
        const x = p.x + ex, y = p.y + ey;
        if (fits(dx < 0 ? x - w : x, y - h, dx < 0 ? x : x + w, y)) { dir = dx; break; }
      }
      el.classList.toggle('nolbl', dir == null);
      if (dir != null) {
        dirs[key] = dir;
        // Labels already placed also count as occluders, so later labels do not cover them
        const [ex, ey] = elbow(key, r, dir), x = p.x + ex, y = p.y + ey;
        extra.push(new DOMRect(dir < 0 ? x - w : x, y - h, w, h));
      }
      layoutTag(key, r, dirs[key] ?? LEADS[key].dirs[0]);
    }
    place(el, p);
  }

  // Orbit view: parts of the station and the crater below
  function frameOrbit(f) {
    if (nFrame++ % 30 === 0) measure();
    extra = f.avoid.filter((a) => a.p && a.p.vis).map((a) => new DOMRect(a.p.x - a.r, a.p.y - a.r, 2 * a.r, 2 * a.r));
    placeTag('ring', f.ring, 5);
    placeTag('core', f.core, 5);
    placeTag('array', f.array, 5);
    placeTag('engine', f.engine, 5);
    placeTag('ocrater', f.crater, 6);
  }

  // Per frame: body, crater and site labels follow the picture (reticle size tracks the viewport)
  function frame(f) {
    if (nFrame++ % 30 === 0) measure();
    extra = [];
    placeTag('earth', f.earth, Math.max(10, f.earthR + 9));
    placeTag('sun', f.sun, Math.min(30, Math.max(14, window.innerHeight * 0.024)));
    placeTag('crater', f.crater, 5);
    for (const s of f.sites) {
      const mk = markers[s.id], p = s.p;
      if (!mk) continue;
      const ok = p && p.vis && fits(p.x - 8, p.y - 14, p.x + 14 + (labelW[s.id] || 0), p.y + 14);
      place(mk, ok ? p : null);
    }
  }

  // Low frequency: live site state
  const cd = { h: null, ev: 'SUNSET', label: '' };
  function set({ sun, earth, next }) {
    bind('earth-data', `${fmtInt(earth.distKm)} km · ${Math.round(earth.illum * 100)}% lit`);
    bind('sun-data', `elev ${signed(sun.el)}° · disk ${Math.round(sun.frac * 100)}%`);
    bind('sun-el', `${signed(sun.el)}°`);
    bind('earth-el', `${signed(earth.el)}°`);
    pill('sun', sun.lit, sun.lit ? 'SUNLIT' : 'NIGHT');
    pill('earth', earth.visible, earth.visible ? 'LINK' : 'BLOCKED');
    const en = sun.lit ? 'SUNSET' : 'SUNRISE';
    if (next.h == null) {
      // null means no flip inside the search window (about one lunar day), not none ever
      cd.label = `NO ${en} AHEAD`;
      bind('cd-en', `NO ${en} WITHIN A LUNAR DAY`);
      bind('cd-next', '');
    } else {
      cd.label = `TIME TO ${en}`;
      bind('cd-next', next.span != null ? `THEN ${sun.lit ? 'NIGHT' : 'SUNLIGHT'} ${fmtSpan(next.span)}` : '');
    }
    bind('cd-label', cd.label);
    card.classList.toggle('none', next.h == null);
    cd.h = next.h;
    cd.ev = en;
  }

  // Per frame: clock and countdown (text written only when it changes)
  function tick(h, date) {
    bind('clock', fmtUTC(date));
    if (cd.h == null) {
      bind('cd-sr', cd.label);
      return;
    }
    const s = Math.max(0, (cd.h - h) * 3600);
    const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
    const hl = headline(s);
    bind('cd-big', String(hl.n));
    bind('cd-unit', hl.unit);
    bind('cd-en', `NEXT ${cd.ev} IN ${hl.n} ${hl.en}`);
    bind('cd', `${pad(d)}d ${pad(hh)}h ${pad(mm)}m ${pad(ss)}s`);
    bind('cd-sr', `${cd.label}, ${d} days ${hh} hours ${mm} minutes`);
  }

  function buildSites(list) {
    const best = {
      sun: Math.max(...list.map((s) => s.stats.sun_visible_pct)),
      earth: Math.max(...list.map((s) => s.stats.earth_visible_pct)),
      dark: Math.min(...list.map((s) => s.stats.longest_dark_h)),
    };
    const body = $('#sites-body');
    body.textContent = '';
    for (const s of list) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      const id = document.createElement('i');
      id.textContent = s.id;
      const nm = document.createElement('span');
      nm.textContent = s.en;
      name.append(id, nm);
      tr.appendChild(name);
      for (const [v, b, txt] of [
        [s.stats.sun_visible_pct, best.sun, `${s.stats.sun_visible_pct.toFixed(1)}%`],
        [s.stats.earth_visible_pct, best.earth, `${s.stats.earth_visible_pct.toFixed(1)}%`],
        [s.stats.longest_dark_h, best.dark, `${s.stats.longest_dark_h} h`],
      ]) {
        const td = document.createElement('td');
        td.textContent = txt;
        if (v === b) {
          td.className = 'best';
          const sr = document.createElement('span');
          sr.className = 'sr';
          sr.textContent = '(best)';
          td.appendChild(sr);
        }
        tr.appendChild(td);
      }
      body.appendChild(tr);

      const mk = document.createElement('div');
      mk.className = 'site off';
      mk.innerHTML = '<i></i><span><b></b></span>';
      $('b', mk).textContent = s.id;
      $('span', mk).append(s.en);
      $('.sites-mk', home).appendChild(mk);
      markers[s.id] = mk;
    }
  }

  // Show/hide: .in plays the entrance animation, .out the exit, then hidden
  const timers = new Map();
  function reveal(el) {
    clearTimeout(timers.get(el));
    el.classList.remove('out', 'in');
    el.hidden = false;
    void el.offsetWidth;                // retrigger the entrance animation
    el.classList.add('in');
  }
  function conceal(el) {
    el.classList.remove('in');
    el.classList.add('out');
    timers.set(el, setTimeout(() => {
      el.hidden = true;
      el.classList.remove('out');
    }, reducedMotion.matches ? 220 : 480));
  }

  // Relay station status (low frequency)
  function setOrbit({ sunEl, sunLit, earthEl, earthVis }) {
    bind('o-sun-el', `${signed(sunEl)}°`);
    bind('o-earth-el', `${signed(earthEl)}°`);
    pill('osun', sunLit, sunLit ? 'SUNLIT' : 'ECLIPSE');
    pill('oearth', earthVis, earthVis ? 'LINK' : 'BLOCKED');
  }

  // ---------- Rover close-up ----------
  const pcard = $('#pcard'), hchip = $('#hchip'), navcam = $('#navcam');
  let pcSel = null;
  // Rover status (low frequency): values all come from rover.state in main.js
  function setRover(t) {
    bind('r-v', `${Math.abs(t.v).toFixed(2)} m/s${t.v < -0.01 ? ' · reverse' : ''}`);
    bind('r-hdg', `${String(Math.round(t.bearing)).padStart(3, '0')}° grid N`);
    bind('r-slope', `${t.slope.toFixed(1)}° · pitch ${signed(t.pitch, 1)}°`);
    bind('r-mode', t.mode);
    bind('r-odo', `${t.odo.toFixed(1)} m · ${t.dist.toFixed(0)} m from A`);
    bind('r-sun', `${signed(t.sunEl)}°`);
    pill('rsun', t.lit === 'sun', { sun: 'SUNLIT', shade: 'SHADE', night: 'NIGHT' }[t.lit]);
    bind('r-pow', `${Math.round(t.power * 100)}%`);
    bind('r-warn', t.warn || '');
    $('#rpass').hidden = !t.rockBlocked;
    const lb = $('#rlights');
    lb.textContent = t.hlOn ? 'On' : 'Off';
    lb.setAttribute('aria-pressed', String(t.hlOn));
    $('#rtime').textContent = t.jumped ? 'Back to now' : 'Jump to sunset';
    bind('nc-pan', `${signed(t.pan, 0)}°`);
    bind('nc-tilt', `${signed(t.tilt, 0)}°`);
    bind('nc-rng', t.range == null ? '> 1.5 km' : `${t.range.toFixed(1)} m`);
  }
  // Part card: info = { en, rows: [[label, value]], note }, p = anchor screen coordinates
  function roverCard(info, p) {
    if (!info || !p || !p.vis) { pcard.hidden = true; return; }
    pcard.hidden = false;
    const k = info.en;
    if (pcSel !== k) {
      pcSel = k;
      $('.pc-name', pcard).textContent = info.en;
      $('.pc-note', pcard).textContent = info.note;
      const dl = $('.pc-rows', pcard);
      dl.textContent = '';
      for (const [name] of info.rows) {
        const d = document.createElement('div');
        d.innerHTML = '<dt></dt><dd></dd>';
        $('dt', d).textContent = name;
        dl.appendChild(d);
      }
      // Card goes left or right: whichever side has more room
      pcard.classList.toggle('l', p.x > window.innerWidth * 0.55);
    }
    // Values update every frame; the row labels above are rebuilt only when the selected part changes
    $$('.pc-rows dd', pcard).forEach((dd, i) => { if (dd.textContent !== info.rows[i][1]) dd.textContent = info.rows[i][1]; });
    pcard.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
    const l = pcard.classList.contains('l') ? -1 : 1;
    $('.lead polyline', pcard).setAttribute('points', `${l * 8},-8 ${l * 64},-64 ${l * 70},-64`);
  }
  function roverChip(lbl, x, y) {
    if (!lbl) { hchip.hidden = true; return; }
    hchip.hidden = false;
    if (hchip.dataset.k !== lbl.en) {
      hchip.dataset.k = lbl.en;
      hchip.textContent = lbl.en;
    }
    hchip.style.transform = `translate3d(${(x + 16).toFixed(0)}px, ${(y + 14).toFixed(0)}px, 0)`;
  }

  return {
    boot, bind, set, setOrbit, tick, frame, frameOrbit, buildSites,
    setRover, roverCard, roverChip,
    showRover: () => { reveal(rover); rover.focus({ preventScroll: true }); },
    hideRover: () => { conceal(rover); pcard.hidden = true; pcSel = null; hchip.hidden = true; },
    closeCard: () => { const was = !pcard.hidden; pcard.hidden = true; pcSel = null; return was; },
    navcam: (on) => { if (on != null) navcam.hidden = !on; return !navcam.hidden; },
    navcamRect: () => navcam.getBoundingClientRect(),
    navcamEl: navcam,
    onRover: (fn) => $('#torover').addEventListener('click', fn),
    onRoverBack: (fn) => $('#rback').addEventListener('click', fn),
    onLights: (fn) => { $('#rlights').addEventListener('click', fn); $('#tlights').addEventListener('click', fn); },
    onNavcam: (fn) => $('#tnav').addEventListener('click', fn),
    onTime: (fn) => $('#rtime').addEventListener('click', fn),
    onDriveThrough: (fn) => $('#rpass').addEventListener('click', fn),
    onCardClose: (fn) => $('.pc-x', pcard).addEventListener('click', fn),
    joy: $('#joy'),
    showHome: () => { sec = home; reveal(home); nFrame = 0; },
    hideHome: () => conceal(home),
    showOrbit: () => { sec = orbit; reveal(orbit); nFrame = 0; $('#oback').focus({ preventScroll: true }); },
    hideOrbit: () => conceal(orbit),
    onOrbit: (fn) => $('#toorbit').addEventListener('click', fn),
    onSelect: (fn) => $('#toselect').addEventListener('click', fn),
    onDescend: (fn) => $('#descend').addEventListener('click', fn),
    onOrbitBack: (fn) => $('#oback').addEventListener('click', fn),
    showExplore: () => { reveal(explore); $('#back').focus({ preventScroll: true }); },
    hideExplore: () => conceal(explore),
    focusEnter: () => $('#enter').focus({ preventScroll: true }),
    veil: (on) => veilEl.classList.toggle('on', on),
    onEnter: (fn) => $('#enter').addEventListener('click', fn),
    onBack: (fn) => $('#back').addEventListener('click', fn),

    // Screens under construction, one per work package. Each package shows and hides
    // its own screen through these and leaves the others alone. They use the same
    // reveal/conceal transitions as the finished screens, so a new screen animates in
    // the same way without its owner having to touch the shared machinery above.
    screen: (id) => $(`#${id}`),
    showScreen: (id) => reveal($(`#${id}`)),
    hideScreen: (id) => conceal($(`#${id}`)),
  };
}
