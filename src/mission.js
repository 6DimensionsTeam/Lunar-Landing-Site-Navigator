import { createLaunchFilm } from './launch-film.js';
import { candidatePool } from './rank.js';

// P2 owns this module and its #mission mount only. P1 keeps its scene and shaders.
// All persistent mission times are hours from the injected ephemeris epoch.
export const dateToHours = (date, eph) => (date.getTime() - eph.start) / 3600e3;
// Product minimum for this planner, not a universal physical or Artemis requirement.
export const MIN_STAY_H = 24;

export function getMissionBounds(eph) {
  const { startYear, endYear, start, stepH, count, maxH } = eph;
  if (![startYear, endYear, start, stepH, count, maxH].every(Number.isFinite) ||
      !Number.isInteger(count) || count < 2 || stepH <= 0 || maxH <= 0 ||
      endYear < startYear || typeof eph.hoursToDate !== 'function') {
    throw new TypeError('The mission requires complete ephemeris metadata and hoursToDate().');
  }
  const firstDate = `${startYear}-01-01`;
  const lastCalendarDate = `${endYear}-12-31`;
  const maxArrivalH = maxH - MIN_STAY_H;
  if (maxArrivalH < 0) throw new RangeError('The ephemeris must cover at least one day for a mission stay.');
  const lastArrivalDate = eph.hoursToDate(maxArrivalH).toISOString().slice(0, 10);
  return {
    minH: 0, maxH, maxArrivalH, minDate: firstDate,
    maxDate: lastArrivalDate < lastCalendarDate ? lastArrivalDate : lastCalendarDate,
    label: startYear === endYear ? String(startYear) : `${startYear}–${endYear}`
  };
}

export function buildMissionConfig(eph, { arriveH, stayH, needs = {} }) {
  const { maxH, maxArrivalH } = getMissionBounds(eph);
  if (!Number.isFinite(arriveH) || arriveH < 0 || arriveH > maxArrivalH) {
    throw new RangeError('Choose an arrival that leaves at least one day within the available mission window.');
  }
  if (!Number.isFinite(stayH) || stayH < MIN_STAY_H) throw new RangeError('The minimum planned stay is one day (24 hours).');
  if (arriveH + stayH > maxH) {
    throw new RangeError('The planned stay extends beyond the ephemeris. Choose an earlier arrival or a shorter stay.');
  }
  // 318 h is the measured longest continuous night at Malapert Massif, which NASA published as
  // an Artemis candidate region. A lander able to fly to Malapert has to survive that night, so
  // the default asks no more endurance than NASA's own candidate set already asks -- and it is a
  // figure with a source, which the previous two defaults were not. 216 h was calibrated against
  // the best-measured site (Shackleton Rim, 204 h), which is a pass mark set at the top scorer
  // and left 18 of 19 sites failing before the user touched a setting; 72 h before it sat an
  // order of magnitude under anything the terrain offers. The candidate pool is screened against
  // this same figure in tools/prep_candidates.py, so every pre-selected site clears it by
  // construction.
  const maxDarkH = needs.maxDarkH ?? 318;
  if (!Number.isFinite(maxDarkH) || maxDarkH < 0) throw new RangeError('Maximum darkness must be zero or more hours.');
  // 84 hours is the assumed flight time used by the transfer estimate, not an optimized launch window.
  // A departure near the dataset start is shortened to keep animation samples in range.
  return {
    arriveH,
    launchH: Math.max(0, arriveH - 84),
    stayH,
    needs: {
      craterFloor: Boolean(needs.craterFloor),
      iceNearby: Boolean(needs.iceNearby),
      continuousComm: normaliseComm(needs.continuousComm),
      maxDarkH
    }
  };
}

// The Earth-link requirement is a boolean ("asked for, at the default bar") or a percentage ("asked
// for, at this bar"). Keeping it one field means the needs contract still has the same four keys.
// A number outside (0, 100] is rejected rather than clamped: 0 would mean "no bar" while still
// counting as requested, and anything above 100 can never be met, which is the kind of input the
// darkness field already refuses to pretend is a valid answer.
function normaliseComm(value) {
  if (typeof value !== 'number') return Boolean(value);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new RangeError('Earth link must be a percentage above 0 and at most 100.');
  }
  return value;
}

// Proposed P2 catalogue preview only. P3 owns selected-window assessment/ranking.
// Pass data.sites as catalog and the validated mission configuration's needs.
export function catalogFeedback(catalog, needs) {
  if (!Array.isArray(catalog?.sites)) throw new TypeError('A candidate-site catalogue is required.');
  if (!Number.isFinite(needs?.maxDarkH) || needs.maxDarkH < 0) {
    throw new TypeError('A nonnegative darkness limit is required.');
  }
  const years = catalog.stats_years;
  const periodLabel = Array.isArray(years) && years.length === 2 && years.every(Number.isInteger) && years[0] <= years[1]
    ? `${years[0]}–${years[1]}` : 'catalogue period';
  const rows = catalog.sites.map(site => {
    const raw = site.stats?.longest_dark_h;
    const longestDarkH = Number.isFinite(raw) && raw >= 0 ? raw : null;
    return { id: site.id, name: site.en, longestDarkH,
      withinBaselineLimit: longestDarkH === null ? null : longestDarkH <= needs.maxDarkH };
  });
  const total = rows.length;
  const unverified = key => ({ requested: needs[key] === true, matchCount: null, unknownCount: total });
  return {
    total, periodLabel, selectedWindowAssessed: false,
    baselineDarkness: {
      label: `Longest dark spell over ${periodLabel}; not the selected stay`,
      maxDarkH: needs.maxDarkH,
      passCount: rows.filter(row => row.withinBaselineLimit === true).length,
      failCount: rows.filter(row => row.withinBaselineLimit === false).length,
      unknownCount: rows.filter(row => row.withinBaselineLimit === null).length,
      rows,
    },
    craterFloor: unverified('craterFloor'),
    iceNearby: unverified('iceNearby'),
    continuousComm: unverified('continuousComm'),
  };
}

// P2 owns layout styles; shared frame/grid/panel/rows/tag components and keyframes
// deliberately retain the visual vocabulary of the home and orbit screens.
const styles = `
#mission{--p2-pad:clamp(22px,2.8vw,48px);--p2-line:#f2f4f538;--p2-dim:#b4bdc4;--p2-red:var(--red,#e2200f);position:fixed;inset:0;z-index:30;color:var(--fg,#f2f4f5);font-family:var(--sans,Rajdhani,Arial,sans-serif);font-weight:500;overflow:hidden;pointer-events:auto;font-size:15px;-webkit-font-smoothing:antialiased}
#mission[hidden],#mission [hidden]{display:none!important}#mission.out{opacity:0;transition:opacity .45s}#mission.out,#mission.out *{pointer-events:none!important}#mission *{box-sizing:border-box}#mission button,#mission input{font:inherit;color:inherit}#mission button{cursor:pointer}#mission button:disabled{opacity:.4;cursor:not-allowed}#mission button:focus-visible,#mission input:focus-visible,#mission summary:focus-visible{outline:2px solid white;outline-offset:4px}#mission h1:focus{outline:none}#mission a{color:inherit}
#mission .p2-canvas,#mission .p2-film,#mission .p2-shade,#mission .p2-black{position:absolute;inset:0;width:100%;height:100%}#mission .p2-canvas{display:block;background:#000}#mission .p2-film{object-fit:contain;background:#000;pointer-events:none}#mission .p2-grid{opacity:.62;pointer-events:none}#mission .p2-shade{pointer-events:none;background:linear-gradient(90deg,#000b,transparent 65%),linear-gradient(0deg,#000c,transparent 34%,transparent 72%,#0009)}
#mission[data-stage=orbit] .p2-shade{background:linear-gradient(90deg,#000b,transparent 42%),linear-gradient(0deg,#000b,transparent 40%,transparent 75%,#0008)}#mission[data-stage=flight] .p2-grid{opacity:.18}#mission[data-stage=flight] .p2-shade{background:linear-gradient(0deg,#000d,transparent 45%,transparent 70%,#0008)}
#mission .p2-black{background:#000;z-index:40;pointer-events:none;opacity:0}#mission .p2-frame{position:absolute;inset:0;pointer-events:none;z-index:8}#mission .p2-edge-scale{position:absolute;left:44px;right:44px;height:8px;background:repeating-linear-gradient(90deg,#fff7 0 1px,transparent 1px 64px),repeating-linear-gradient(90deg,#fff3 0 1px,transparent 1px 16px);border-top:1px solid #fff2}#mission .p2-edge-scale.top{top:10px}#mission .p2-edge-scale.bottom{bottom:10px;transform:rotate(180deg)}
#mission .p2-header{position:absolute;top:30px;left:var(--p2-pad);right:var(--p2-pad);display:flex;align-items:center;gap:24px;z-index:6}#mission .p2-brand{border:0;border-left:3px solid var(--p2-red);background:none;text-align:left;padding:0 0 0 12px;display:grid;gap:5px}#mission .p2-brand b{font-size:16px;letter-spacing:.16em}#mission .p2-brand small{font-size:12px;letter-spacing:.18em;color:#bdc5ca}#mission .p2-header-line{height:7px;flex:1;border-inline:1px solid var(--p2-line);background:linear-gradient(90deg,var(--p2-line),transparent 30%,transparent 70%,var(--p2-line)) center/100% 1px no-repeat}#mission .p2-system{font-size:13px;letter-spacing:.12em;display:flex;gap:12px;align-items:center}#mission .p2-system:before{content:'';width:5px;height:5px;background:var(--p2-red)}#mission .p2-system b{border:1px solid #fff5;padding:5px 8px;font-weight:600}
#mission .p2-stage{position:absolute;inset:0}#mission .p2-stage.in h1{animation:wipeR .72s .08s both var(--ease)}#mission .p2-stage.in .p2-eyebrow{animation:wipeR .5s both var(--ease)}#mission .p2-stage.in .panel,#mission .p2-stage.in .p2-cta,#mission .p2-stage.in .p2-timeline{animation:riseIn .7s .16s both var(--ease)}#mission .p2-stage.in .ret{animation:retIn .65s .15s both var(--ease)}#mission .p2-stage.in .lead polyline{animation:draw .55s .4s both var(--ease)}#mission .p2-stage.in .lbl{animation:wipe .6s .5s both var(--ease)}
#mission[data-transition] .p2-stage{opacity:0;transform:translateY(-9px);filter:blur(2px);transition:opacity .2s,transform .3s var(--ease),filter .2s;pointer-events:none}#mission[data-transition] button{pointer-events:none}#mission .p2-stage{transition:opacity .2s,transform .3s var(--ease),filter .2s}
#mission .p2-eyebrow{display:flex;align-items:center;gap:12px;font-size:13px;letter-spacing:.2em;margin:0 0 15px;color:#c5cdd2}#mission .p2-eyebrow b{background:var(--p2-red);padding:5px 7px;color:#fff}#mission h1{font-size:clamp(38px,3.6vw,59px);font-weight:700;line-height:1.06;letter-spacing:.02em;margin:0;text-shadow:0 2px 20px #0009}#mission .p2-subtitle{font-size:13px;letter-spacing:.2em;color:#b6c0c7;margin:16px 0 24px}#mission .p2-heading{position:absolute;left:var(--p2-pad);top:112px;max-width:70%}#mission .p2-heading h1{font-size:34px}#mission .p2-back{background:none;border:0;padding:0;color:#bec8cf;font-size:14px;margin-bottom:17px}#mission .p2-heading .p2-subtitle{margin:12px 0}
#mission .p2-intro-content{position:absolute;left:7%;top:23%;width:min(480px,40%)}#mission .p2-date-box{border-block:1px solid #fff6;padding:14px 14px 12px;background:linear-gradient(90deg,#0009,#0002)}#mission .p2-date-label{display:flex;justify-content:space-between;font-size:15px;letter-spacing:.08em}#mission .p2-date-label small{font-size:12px;color:var(--p2-dim)}#mission .p2-arrival{font-size:36px;width:100%;border:0;background:none;padding:9px 0 6px;color-scheme:dark}#mission input::-webkit-calendar-picker-indicator{cursor:pointer;opacity:.75}#mission .p2-time-row{display:flex;align-items:center;justify-content:space-between;min-height:28px}#mission .p2-link{border:0;background:none;padding:0;font-size:14px;color:var(--p2-dim)}#mission .p2-link small{font-size:12px;margin-left:8px}#mission .p2-time-wrap{display:flex;gap:6px;align-items:center;font-size:13px}#mission .p2-time-wrap input{background:none;border:0;font-size:16px;width:100px;color-scheme:dark}
#mission .p2-cta{width:100%;display:grid;gap:7px;justify-items:center;padding:16px;background:#0b0c0e;border:1px solid #e2200fc0;box-shadow:inset 3px 0 var(--p2-red),inset -3px 0 var(--p2-red);transition:background .2s}#mission .p2-cta:hover:enabled{background:var(--p2-red)}#mission .p2-cta b{font-size:21px;letter-spacing:.12em}#mission .p2-cta span{font-size:12px;letter-spacing:.18em}#mission .p2-intro-content .p2-cta{margin-top:16px}#mission .p2-window{display:flex;align-items:center;gap:10px;font-size:14px;color:#bec8cf;margin:14px 0;letter-spacing:.04em}#mission .p2-window i{background:var(--p2-red);width:3px;height:3px}#mission .p2-error{font-size:15px;line-height:1.5;color:#ff9a8b;margin:10px 0}#mission .p2-error:empty{display:none}
#mission .panel{background:#05080bdc;padding:0 16px 14px;font-size:15px}#mission .p2-panel-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:0 -16px 13px;padding:10px 16px;border-bottom:1px solid var(--p2-line);text-transform:uppercase;letter-spacing:.12em;font-size:14px}#mission .p2-panel-head>span:before{content:'▪';color:var(--p2-red);margin-right:8px}#mission .p2-panel-head small{font-size:11px;letter-spacing:.08em;color:var(--p2-dim)}#mission .rows{margin:0}#mission .rows>div{display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:1px solid #fff1;padding:7px 0}#mission .rows dt{font-size:13px;color:var(--p2-dim);letter-spacing:.02em}#mission .rows dd{margin:0;font-size:15px;text-align:right;font-variant-numeric:tabular-nums}#mission .p2-note{font-size:13px;line-height:1.5;letter-spacing:.025em;color:var(--p2-dim);margin:12px 0 0}#mission .p2-reference{position:absolute;right:7%;top:24%;width:286px}#mission .p2-reference .p2-catalog{margin-top:17px}#mission .p2-catalog-row{display:grid;grid-template-columns:15px 1fr 35px;align-items:center;gap:9px;margin:8px 0;font-size:13px}#mission .p2-catalog-row i{height:3px;background:#fff2;position:relative}#mission .p2-catalog-row i:after{content:'';display:block;height:100%;width:var(--sun);background:#c9cfd3}#mission .p2-catalog-row b{font-weight:500;color:var(--p2-dim)}#mission .p2-terrain-tag{position:absolute;right:12%;bottom:15%;transition:top .2s;border-bottom:1px solid #fff7;padding:10px 0 10px 24px;display:grid;gap:6px;font-size:13px;letter-spacing:.12em}#mission .p2-terrain-tag:before{content:'+';position:absolute;left:0;top:4px;font-size:24px}#mission .p2-terrain-tag span{font-size:12px;color:var(--p2-dim)}
#mission .p2-orbit-metrics{position:absolute;left:var(--p2-pad);top:274px;width:258px}#mission .p2-orbit-metrics .rows>div{padding:6px 0}#mission .p2-preview{position:absolute;right:var(--p2-pad);top:114px;width:240px}#mission .p2-preview .p2-panel-head{margin-bottom:6px}#mission .p2-tags{pointer-events:none}#mission .p2-tag{font-size:13px}#mission .p2-tag .ret{width:26px;height:26px;left:-13px;top:-13px}#mission .p2-tag .ret circle{stroke:var(--p2-red)}#mission .p2-tag .lbl{background:#020405b8;padding:6px 8px;gap:4px}#mission .p2-tag .lbl b{font-size:14px}#mission .p2-tag .lbl span{font-size:12px}#mission .p2-tag .lead polyline{stroke-dasharray:3 4;stroke:#fff8}#mission .p2-launch-anchor{border:0;background:none;position:absolute;inset:0 auto auto 0;padding:0;pointer-events:auto;text-align:left;color:white}#mission .p2-launch-anchor .lbl{cursor:pointer;border-bottom-color:var(--p2-red);background:#0b0d10ed;min-width:175px}#mission .p2-launch-anchor:hover .lbl{background:#8e1c15}#mission .p2-launch-anchor:focus-visible .lbl{outline:2px solid #fff}#mission .p2-launch-anchor .ret{stroke:var(--p2-red)}
#mission .p2-orbit-bottom{position:absolute;left:var(--p2-pad);right:var(--p2-pad);bottom:77px;display:grid;grid-template-columns:258px 1fr;gap:26px;align-items:end}#mission .p2-model-details{font-size:13px;color:#ccd2d8;line-height:1.5;position:relative}#mission .p2-model-details summary{cursor:pointer;padding:8px 0;border-top:1px solid #fff5}#mission .p2-model-details p{position:absolute;bottom:25px;width:320px;max-width:82vw;background:#05080bf5;border:1px solid #fff5;padding:15px;z-index:10}#mission .p2-scale-note{font-size:12px;line-height:1.6;color:var(--p2-dim);margin:0 0 8px}
#mission .p2-timeline{border:1px solid var(--p2-line);background:#05080be6;padding:14px 16px;min-width:0}#mission .p2-timeline-head{display:flex;justify-content:space-between;gap:8px;font-size:13px;letter-spacing:.1em;margin-bottom:14px}#mission .p2-timeline-head span{color:var(--p2-dim);font-size:12px}#mission .p2-time-axis{position:relative;height:38px;display:flex;background:repeating-linear-gradient(90deg,#fff3 0 1px,transparent 1px 5%) bottom/100% 6px no-repeat;border-bottom:1px solid #fff4}#mission .p2-time-segment{height:22px;border:1px solid #fff6;position:relative;min-width:0;overflow:hidden}#mission .p2-time-segment.transfer{background:repeating-linear-gradient(135deg,#ffffff18 0 1px,transparent 1px 5px)}#mission .p2-time-segment.surface{background:#e2200f24;border-color:#dc4b40}#mission .p2-time-segment span{display:block;white-space:nowrap;font-size:13px;padding:3px 8px}#mission .p2-arrival-pin{position:absolute;top:-5px;height:34px;width:1px;background:#ff5848;pointer-events:none}#mission .p2-arrival-pin:before{content:'';position:absolute;left:-3px;top:-2px;width:7px;height:7px;background:var(--p2-red);border:1px solid #ffafa5}#mission .p2-time-labels{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:10px}#mission .p2-time-labels>div{min-width:0}#mission .p2-time-labels>div:last-child{text-align:right}#mission .p2-time-labels small{display:block;font-size:11px;color:var(--p2-dim);letter-spacing:.09em}#mission .p2-time-labels time{font-size:14px;line-height:1.6;white-space:nowrap}#mission .p2-time-legend{display:flex;justify-content:space-between;gap:8px;margin-top:8px;font-size:13px;color:var(--p2-dim)}
#mission .p2-pad-layout{position:absolute;left:var(--p2-pad);right:var(--p2-pad);top:245px;bottom:77px;display:flex;justify-content:space-between;gap:24px;pointer-events:none}#mission .p2-config,#mission .p2-launch-side{width:clamp(280px,26vw,360px);max-height:100%;overflow-y:auto;scrollbar-width:thin;pointer-events:auto}#mission .p2-config{padding-bottom:12px}#mission fieldset{border:0;border-bottom:1px solid var(--p2-line);padding:0 0 16px;margin:0 0 15px;min-width:0}#mission fieldset:last-of-type{border-bottom:0;margin-bottom:0;padding-bottom:0}#mission legend{font-size:16px;padding:0 0 13px;letter-spacing:.02em;display:flex;align-items:center;width:100%;gap:9px}#mission legend b{font-size:12px;color:#d34f43;border:1px solid #c743373b;padding:3px}#mission legend>span{margin-left:auto;font-size:11px;color:var(--p2-dim);letter-spacing:.08em}#mission .p2-duration-value{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}#mission .p2-duration-value input,#mission .p2-dark-value input{background:#ffffff08;border:0;border-bottom:1px solid #fff7;width:80px;text-align:center;font-size:29px;padding:3px;font-variant-numeric:tabular-nums}#mission .p2-duration-value span{font-size:14px;color:var(--p2-dim)}#mission .p2-duration-value small{margin-left:auto;color:var(--p2-dim);font-size:12px}
#mission .p2-range{width:100%;accent-color:var(--p2-red);height:22px;margin:0;cursor:pointer}#mission .p2-range-ticks{position:relative;height:25px;margin:0 7px;border-top:1px solid #fff3;background:repeating-linear-gradient(90deg,#fff4 0 1px,transparent 1px 7.14%) top/100% 4px no-repeat}#mission .p2-range-ticks span{position:absolute;top:7px;font-size:12px;color:var(--p2-dim);transform:translateX(-50%);white-space:nowrap}#mission .p2-range-ticks span:first-child{transform:none}#mission .p2-range-ticks span:last-child{transform:translateX(-100%)}#mission .p2-field-note{font-size:13px;line-height:1.5;color:var(--p2-dim);margin:8px 0 0}#mission .p2-field-note b{display:block;font-weight:600;color:#f0f2f4;font-size:15px}
#mission .p2-check{display:grid;grid-template-columns:15px 1fr auto;gap:9px;align-items:center;padding:10px 0;border-bottom:1px solid #fff2;font-size:15px;cursor:pointer}#mission .p2-check input{accent-color:var(--p2-red);margin:0;width:14px;height:14px}#mission .p2-check small{font-size:11px;color:var(--p2-dim);letter-spacing:.05em}#mission .p2-check:has(input:checked){color:#fff}#mission .p2-check:has(input:checked) small{color:#ff8f81}#mission .p2-dark-label{display:flex;align-items:center;justify-content:space-between;font-size:15px;margin-top:16px}#mission .p2-dark-value{display:flex;align-items:baseline;gap:6px}#mission .p2-dark-value input{font-size:21px;width:64px}#mission .p2-dark-value span{font-size:13px;color:var(--p2-dim)}#mission .p2-dark-scale{position:relative;height:67px;margin:25px 5px 0;border-top:1px solid #fff6;background:repeating-linear-gradient(90deg,#fff4 0 1px,transparent 1px 10%) top/100% 5px no-repeat}#mission .p2-dark-site{position:absolute;top:0;width:1px;height:13px;background:#f2f4f5}#mission .p2-dark-site span{position:absolute;top:16px;left:0;transform:translateX(-50%);font-size:12px;white-space:nowrap}#mission .p2-dark-site:nth-child(even){height:35px}#mission .p2-dark-site:nth-child(even) span{top:38px}#mission .p2-dark-site.pass{background:#ff8072}#mission .p2-dark-site.pass span{color:#ff9b90}#mission .p2-dark-cursor{position:absolute;top:-14px;height:72px;border-left:1px dashed #ed5648;pointer-events:none}#mission .p2-dark-cursor span{position:absolute;top:-12px;font-size:11px;color:#ff9488;white-space:nowrap;transform:translateX(-50%)}#mission .p2-bar-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:2px 0 0 24px;font-size:13px;color:var(--p2-dim)}#mission .p2-bar-input{display:flex;align-items:baseline;gap:4px}#mission .p2-bar-input input{width:56px;font-size:17px}#mission .p2-bar-input b{font-weight:500;color:var(--p2-dim)}#mission .p2-bar-note{margin:4px 0 8px 24px;font-size:12px;line-height:1.45;color:var(--p2-dim)}#mission .p2-candidate-feedback{margin:6px 0 0;padding:9px 10px;border-left:2px solid var(--p2-red);background:#ffffff07;font-size:14px;line-height:1.4}#mission .p2-candidate-feedback small{display:block;font-size:12px;color:var(--p2-dim);margin-top:4px}#mission .p2-impossible{display:block;color:#ff9a8b;font-weight:600;margin-top:6px}#mission .p2-reference-range{display:flex;justify-content:space-between;margin-top:-4px;font-size:11px;color:var(--p2-dim)}
#mission .p2-launch-side{display:flex;flex-direction:column;gap:15px;background:#030609ec;padding:14px;border:1px solid #fff4}#mission .p2-launch-side .panel,#mission .p2-launch-side .p2-timeline{background:none;border:none;padding:0}#mission .p2-launch-side .panel:before,#mission .p2-launch-side .panel:after{display:none}#mission .p2-launch-side .p2-panel-head{margin:0 0 12px;padding:0 0 10px}#mission .p2-launch-side .p2-time-labels{grid-template-columns:1fr;gap:7px}#mission .p2-launch-side .p2-time-labels>div{display:flex;align-items:baseline;justify-content:space-between;text-align:left}#mission .p2-launch-side .p2-time-labels time{font-size:15px}#mission .p2-launch-side .p2-cta{margin-top:auto;background:#c32216}#mission .p2-launch-side .p2-cta:hover:enabled{background:#ee3424}#mission .p2-launch-disclaimer{font-size:12px;letter-spacing:.04em;color:var(--p2-dim);text-align:center;margin:0}#mission .p2-rocket-label{position:absolute;left:51%;top:39%;border-bottom:1px solid #fff7;display:grid;gap:5px;padding:8px 10px;background:#0204059c;font-size:13px;letter-spacing:.1em;pointer-events:none}#mission .p2-rocket-label:before{content:'+';position:absolute;left:-22px;top:8px;font-size:20px}#mission .p2-rocket-label small{font-size:11px;color:var(--p2-dim)}
#mission .p2-flight-heading{position:absolute;left:var(--p2-pad);top:120px}#mission .p2-flight-heading h1{font-size:34px}#mission .p2-skip{position:absolute;right:var(--p2-pad);top:113px;border:1px solid #fff9;background:#030609ce;padding:11px 17px;font-size:15px}#mission .p2-flight-reference{position:absolute;right:var(--p2-pad);bottom:245px;width:230px}#mission .p2-flight-reference .rows dd{font-size:14px}#mission .p2-flight-clock{position:absolute;left:var(--p2-pad);bottom:107px;width:420px;background:#020507c9;padding:15px;border:1px solid #fff5}#mission .p2-flight-clock>span{display:flex;justify-content:space-between;font-size:12px;letter-spacing:.1em;color:var(--p2-dim)}#mission .p2-flight-clock time{display:block;font-size:27px;margin:8px 0 13px;font-variant-numeric:tabular-nums}#mission .p2-flight-track{height:3px;background:#fff3;position:relative}#mission .p2-flight-track i{display:block;height:100%;background:var(--p2-red);width:0;transition:width .23s linear}#mission .p2-film-events{display:flex;justify-content:space-between;gap:8px;margin-top:10px;font-size:11px;color:#8d9aa3;letter-spacing:.07em}#mission .p2-film-events .active{color:white}#mission .p2-film-count{font-size:35px;line-height:1;font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:8px;margin:12px 0}#mission .p2-film-count small{font-size:12px;color:var(--p2-dim)}#mission .p2-footage-credit{position:absolute;right:var(--p2-pad);bottom:100px;max-width:290px;padding:10px;background:#030609d9;font-size:12px;letter-spacing:.04em;line-height:1.6;text-align:right}#mission .p2-film-error{position:absolute;left:var(--p2-pad);bottom:280px;max-width:420px;padding:14px;background:#000e;border:1px solid #e2200f;font-size:17px;z-index:15}#mission .p2-film-error button{display:block;margin-top:10px;border:1px solid #fff8;padding:8px 14px;background:#111}
#mission .p2-footer{position:absolute;bottom:30px;left:var(--p2-pad);right:var(--p2-pad);display:flex;justify-content:space-between;align-items:center;gap:20px;font-size:12px;letter-spacing:.08em;z-index:5}#mission .p2-steps{display:flex;align-items:center;gap:14px}#mission .p2-steps>li{display:flex;align-items:center;gap:6px;color:#83909b}#mission .p2-steps>li.active{color:#fff}#mission .p2-steps b{font-size:12px;color:#8d9ba5}#mission .p2-steps .active b{color:#ff6959}#mission .p2-footer-credit{color:#83909b;font-size:11px}
#mission .p2-boot{position:absolute;inset:0;z-index:50;display:grid;place-items:center;background:#020407}#mission .p2-boot.out{opacity:0;visibility:hidden;transition:opacity .5s,visibility .5s}#mission .p2-boot-box{width:min(610px,84vw)}#mission .p2-boot-head{display:flex;align-items:center;gap:16px;border-bottom:1px solid #fff5;padding-bottom:15px;letter-spacing:.15em;font-size:16px}#mission .p2-boot-head b{background:var(--p2-red);padding:8px;font-size:18px}#mission .p2-boot-head span{margin-left:auto;font-size:12px;color:var(--p2-dim)}#mission .p2-boot-log{list-style:none;padding:12px 0;min-height:230px;font-size:16px}#mission .p2-boot-log li{display:flex;gap:12px;margin:10px 0;animation:logIn .3s both}#mission .p2-boot-log time{color:#84939e;min-width:42px;font-size:14px}#mission .p2-boot-log .message{flex:1}#mission .p2-boot-log small{font-size:13px;color:#aeb9c1}#mission .p2-boot-log .error{color:#ff8373}#mission .p2-boot-track{height:2px;background:#fff2}#mission .p2-boot-track i{display:block;height:100%;background:var(--p2-red);width:0;transition:width .3s}#mission .p2-boot-foot{display:flex;justify-content:space-between;color:var(--p2-dim);font-size:12px;letter-spacing:.12em}#mission .p2-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media(max-width:1100px){#mission .p2-footer-credit{display:none}#mission .p2-orbit-metrics{width:228px;top:258px}#mission .p2-orbit-metrics .rows>div{padding:5px 0}#mission .p2-orbit-bottom{grid-template-columns:228px 1fr;gap:18px}#mission .p2-preview{width:207px}#mission .p2-config,#mission .p2-launch-side{width:285px}#mission .p2-pad-layout{gap:12px}#mission .p2-reference{right:6%;width:260px}}
@media(max-width:900px),(max-height:650px){#mission .p2-header{top:24px}#mission .p2-heading{top:98px}#mission .p2-heading h1{font-size:28px}#mission .p2-heading .p2-subtitle{font-size:11px}#mission .p2-intro-content{left:var(--p2-pad);width:45%;top:23%}#mission .p2-reference{right:var(--p2-pad);top:23%;width:240px}#mission [data-view=pad]{overflow-y:auto;padding:330px var(--p2-pad) 90px}#mission .p2-pad-layout{position:relative;inset:auto;display:grid;grid-template-columns:1fr 1fr;align-items:start;gap:16px}#mission .p2-config,#mission .p2-launch-side{width:100%;max-height:none;overflow:visible}#mission .p2-rocket-label{left:auto;right:var(--p2-pad);top:244px}#mission .p2-footer{bottom:23px}#mission[data-stage=pad] .p2-footer{left:0;right:0;bottom:0;padding:20px var(--p2-pad);background:#030609f5;border-top:1px solid #fff2}#mission .p2-preview{top:98px;width:190px}#mission .p2-orbit-metrics{top:237px;width:212px}#mission .p2-orbit-metrics .rows>div{padding:4px 0}#mission .p2-orbit-metrics .p2-note{font-size:12px;margin-top:8px}#mission .p2-orbit-bottom{bottom:66px;grid-template-columns:212px 1fr;gap:12px}#mission .p2-timeline{padding:12px}#mission .p2-time-labels time{font-size:12px}#mission .p2-orbit-bottom .p2-time-labels{grid-template-columns:1fr 1fr}#mission .p2-orbit-bottom .p2-time-labels>div:last-child{display:none}}
@media(max-width:650px){#mission{--p2-pad:24px}#mission .p2-header{top:24px;gap:14px}#mission .p2-brand b{font-size:16px}#mission .p2-brand small{font-size:11px}#mission .p2-system>span{display:none}#mission .p2-system b{font-size:12px}#mission .p2-stage[data-view=intro]{inset:91px 0 67px;overflow-y:auto;padding:22px var(--p2-pad)}#mission .p2-intro-content{position:relative;inset:auto;width:100%;max-width:470px}#mission .p2-intro-content h1{font-size:39px}#mission .p2-intro-content .p2-subtitle{font-size:12px;letter-spacing:.12em}#mission .p2-reference{position:relative;inset:auto;width:100%;margin-top:24px}#mission .p2-reference .p2-catalog{display:none}#mission .p2-terrain-tag{display:none}#mission .p2-heading{top:100px;max-width:85%}#mission .p2-heading h1{font-size:27px}#mission .p2-heading .p2-back{margin-bottom:13px}#mission .p2-eyebrow{font-size:12px;margin-bottom:11px}#mission .p2-heading .p2-subtitle{margin-top:9px}#mission .p2-preview{display:none}#mission .p2-orbit-metrics{top:auto;bottom:206px;width:calc(100% - 2 * var(--p2-pad));padding-bottom:7px;background:#030609e9}#mission .p2-orbit-metrics .p2-panel-head{margin-bottom:4px;padding-block:7px}#mission .p2-orbit-metrics .rows{display:grid;grid-template-columns:1fr 1fr;column-gap:14px}#mission .p2-orbit-metrics .rows>div{gap:5px;padding:4px 0}#mission .p2-orbit-metrics .rows dt{font-size:12px}#mission .p2-orbit-metrics .rows dd{font-size:13px}#mission .p2-orbit-metrics .p2-note{display:none}#mission .p2-orbit-bottom{bottom:70px;display:block}#mission .p2-model-wrap{display:none}#mission .p2-orbit-bottom .p2-timeline{padding:10px 12px}#mission .p2-timeline-head{margin-bottom:10px;font-size:12px}#mission .p2-time-axis{height:30px}#mission .p2-time-labels{margin-top:7px}#mission .p2-time-legend{margin-top:6px;font-size:12px}#mission .p2-tag:not([data-anchor=launch]){display:none}#mission .p2-launch-anchor .lbl{min-width:158px}#mission .p2-launch-anchor .lbl b{font-size:13px}#mission .p2-pad-layout{display:flex;flex-direction:column;gap:20px}#mission [data-view=pad]{padding-top:360px}#mission .p2-rocket-label{top:275px;font-size:12px}#mission .p2-rocket-label small{font-size:11px}#mission .p2-steps{gap:7px;font-size:11px}#mission .p2-steps>li{gap:4px}#mission .p2-flight-heading{top:145px}#mission .p2-flight-heading h1{font-size:28px}#mission .p2-skip{top:96px;padding:8px 11px;font-size:14px}#mission .p2-flight-reference{right:var(--p2-pad);bottom:278px;width:185px;padding-bottom:9px}#mission .p2-flight-reference .rows{display:none}#mission .p2-flight-reference .p2-note{margin:0;font-size:11px}#mission .p2-flight-reference .p2-panel-head{margin-bottom:6px}#mission .p2-film-count{font-size:27px;margin:8px 0}#mission .p2-flight-clock{bottom:127px;width:calc(100% - 2 * var(--p2-pad))}#mission .p2-flight-clock time{font-size:25px}#mission .p2-footage-credit{bottom:64px;font-size:11px;max-width:calc(100% - 2 * var(--p2-pad));padding:6px 8px}#mission .p2-boot-log{font-size:14px}#mission .p2-boot-head{font-size:13px;gap:8px}#mission .p2-boot-head span{font-size:11px}#mission .p2-boot-log li{gap:7px}#mission .p2-boot-log time{font-size:12px;min-width:34px}#mission .p2-boot-foot{font-size:11px}}
@media(max-height:740px) and (max-width:650px){#mission .p2-orbit-metrics{bottom:192px}#mission .p2-orbit-metrics .rows>div:nth-child(n+5){display:none}#mission .p2-orbit-bottom{bottom:62px}#mission .p2-heading .p2-subtitle{display:none}#mission .p2-orbit-metrics .p2-panel-head small{display:none}}
@media(max-height:520px) and (min-width:651px){#mission .p2-header{top:20px}#mission .p2-heading{top:86px}#mission .p2-heading h1{font-size:24px}#mission .p2-heading .p2-subtitle,#mission .p2-preview,#mission .p2-orbit-bottom .p2-model-wrap{display:none}#mission .p2-heading .p2-back{margin-bottom:9px}#mission [data-view=intro]{inset:80px 0 56px;overflow-y:auto;padding:15px var(--p2-pad)}#mission .p2-intro-content{position:relative;inset:auto;width:48%}#mission .p2-intro-content h1{font-size:30px}#mission .p2-reference{top:15px;width:40%}#mission .p2-reference .p2-catalog{display:none}#mission .p2-terrain-tag{display:none}#mission .p2-orbit-metrics{top:207px;bottom:58px;width:244px;overflow-y:auto}#mission .p2-orbit-metrics .p2-note{display:none}#mission .p2-orbit-bottom{left:auto;width:44%;bottom:58px;display:block}#mission .p2-orbit-bottom .p2-timeline{padding:10px}#mission .p2-footer{bottom:22px}#mission [data-view=pad]{padding-top:240px}#mission .p2-rocket-label{top:170px}#mission .p2-flight-heading{top:92px}#mission .p2-flight-heading h1{font-size:24px}#mission .p2-flight-heading .p2-subtitle{display:none}#mission .p2-flight-reference{bottom:75px;width:190px}#mission .p2-flight-reference .rows,#mission .p2-flight-reference .p2-note{display:none}#mission .p2-flight-clock{bottom:66px;width:310px;padding:11px}#mission .p2-flight-clock time{font-size:23px;margin:7px 0}#mission .p2-footage-credit{bottom:39px;padding:2px 8px;font-size:11px}#mission .p2-skip{top:90px}#mission .p2-boot{overflow-y:auto;place-items:start center;padding:20px 0}}
@media(max-width:340px){#mission{--p2-pad:19px}#mission .p2-intro-content h1{font-size:33px}#mission .p2-arrival{font-size:30px}#mission .p2-steps{gap:5px;font-size:11px}#mission .p2-steps b{font-size:11px}#mission .p2-heading h1{font-size:24px}#mission .p2-time-labels time{font-size:11px}}

#mission .p2-launch-anchor{width:26px;height:26px}
#mission .p2-orbit-bottom{left:calc(var(--p2-pad) + 284px);display:block}
#mission .p2-orbit-metrics{top:262px}
#mission .p2-orbit-metrics .rows>div{padding:5px 0}
#mission .p2-orbit-metrics .p2-model-wrap{margin-top:10px}
#mission .p2-scale-note{font-size:12px;line-height:1.5}
#mission .p2-model-details summary{padding:6px 0 0}
@media(max-width:1100px){#mission .p2-orbit-bottom{left:calc(var(--p2-pad) + 246px)}#mission .p2-orbit-metrics{top:252px}}
@media(max-width:900px),(max-height:650px){#mission .p2-orbit-bottom{left:calc(var(--p2-pad) + 228px)}#mission .p2-orbit-metrics{top:235px}#mission .p2-orbit-metrics .rows>div{padding:4px 0}}
@media(max-width:650px){#mission .p2-orbit-bottom{left:var(--p2-pad)}#mission .p2-orbit-metrics{top:auto}#mission .p2-orbit-metrics .p2-model-wrap{display:none}}
@media(max-height:520px) and (min-width:651px){#mission .p2-orbit-bottom{left:auto}#mission .p2-orbit-metrics{top:207px}#mission .p2-orbit-metrics .p2-model-wrap{display:none}}


#mission .p2-dark-site,#mission .p2-dark-cursor{font-style:normal}
#mission .p2-config::-webkit-scrollbar,#mission .p2-launch-side::-webkit-scrollbar{width:4px}
#mission .p2-config::-webkit-scrollbar-thumb,#mission .p2-launch-side::-webkit-scrollbar-thumb{background:#9da8b080}
#mission .p2-launch-side>.panel .rows>div:nth-child(-n+3){display:none}
#mission .p2-launch-side>.panel .p2-note{font-size:12px;line-height:1.4;margin-top:8px}
#mission .p2-launch-side{gap:12px}
#mission .p2-launch-side .p2-cta{position:sticky;bottom:0;flex-shrink:0;z-index:2;padding:13px}
#mission .p2-launch-side .p2-time-labels{gap:5px}
#mission .p2-launch-side .p2-time-labels time{font-size:14px}
#mission .p2-launch-side .p2-timeline-head{margin-bottom:11px}
#mission .p2-launch-side .p2-time-axis{height:32px}
#mission .p2-launch-side .p2-panel-head{margin-bottom:6px}
#mission .p2-config .p2-panel-head{position:sticky;top:0;background:#090d11;z-index:2}
#mission .p2-config legend{padding-bottom:9px}
#mission .p2-config .p2-duration-value{margin-bottom:2px}
#mission .p2-config .p2-duration-value input{font-size:26px;padding:0}
#mission .p2-config fieldset{padding-bottom:11px;margin-bottom:11px}
#mission .p2-config .p2-check{padding:8px 0}
#mission .p2-config .p2-field-note{margin-top:6px}
#mission[data-config-valid=false] [data-view=pad] .p2-timeline{opacity:.4}


@media(max-width:900px),(max-height:650px){
#mission [data-view=pad]{inset:90px 0 64px;padding:250px var(--p2-pad) 26px}
#mission [data-view=pad] .p2-heading{top:8px}
#mission .p2-config .p2-panel-head{position:static}
#mission .p2-launch-side .p2-cta{position:sticky}
#mission .p2-rocket-label{top:180px}
}
@media(max-height:520px) and (min-width:651px){
#mission [data-view=pad]{inset:78px 0 56px;padding-top:162px}
#mission .p2-rocket-label{top:100px}
}


@media(max-width:650px) and (max-height:740px){
#mission .p2-flight-reference{top:226px;bottom:auto;width:220px;padding-bottom:8px}
#mission .p2-flight-reference .p2-note{display:none}
#mission .p2-flight-reference .p2-panel-head{padding-block:8px}
#mission .p2-flight-reference .p2-film-count{margin:5px 0;font-size:25px}
}


#mission .p2-launch-anchor{pointer-events:none}
#mission .p2-launch-anchor .lbl{pointer-events:auto;border:0;border-bottom:1px solid var(--p2-red);border-radius:0;color:#fff;text-align:left;transform:translateY(-100%)}
@media(max-height:520px) and (min-width:651px){
#mission .p2-tag:not([data-anchor=launch]){display:none}
#mission .p2-orbit-metrics .p2-panel-head{font-size:12px;white-space:nowrap;margin-bottom:4px;padding-block:8px}
#mission .p2-orbit-metrics .p2-panel-head small{display:none}
#mission .p2-orbit-metrics .rows{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}
#mission .p2-orbit-metrics .rows>div:nth-child(n+5){display:none}
#mission .p2-orbit-metrics .rows>div{gap:5px}
#mission .p2-orbit-metrics .rows dt,#mission .p2-orbit-metrics .rows dd{font-size:11px}
}


#mission .p2-steps{list-style:none;padding:0;margin:0}
#mission .p2-steps>li{white-space:nowrap}
#mission .p2-steps>li+li:before{content:'';width:18px;height:1px;background:#fff3;margin-right:8px}
#mission .p2-steps>li.complete{color:#bdc5ca}
#mission .p2-orbit-actions{display:flex;justify-content:flex-end;gap:10px;margin-bottom:10px}
#mission .p2-orbit-actions button{padding:10px 14px;background:#05080bf2;font-size:14px;letter-spacing:.06em}
#mission .p2-orbit-actions [data-ui=configure-mission]{border-color:var(--p2-red)}
@media(max-width:650px){
#mission .p2-footer>nav{width:100%}
#mission .p2-steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px;text-align:center;font-size:11px;letter-spacing:0}
#mission .p2-steps>li{flex-direction:column;gap:4px}
#mission .p2-steps>li+li:before{display:none}
#mission .p2-orbit-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
#mission .p2-orbit-actions button{padding:10px 6px;font-size:13px}
#mission .p2-orbit-metrics{bottom:260px}
}
@media(max-width:650px) and (max-height:740px){#mission .p2-orbit-metrics{bottom:246px}}
@media(max-width:340px){#mission .p2-steps{font-size:11px}}

@media(prefers-reduced-motion:reduce){#mission *,#mission *:before,#mission *:after{animation:none!important;transition:none!important}}
`;

function anchorMarkup(name, title, subtitle, interactive = false) {
  const label = interactive ? 'button' : 'span';
  return `<div class="tag p2-tag ${interactive ? 'p2-launch-anchor' : ''} off" data-anchor="${name}" ${interactive ? '' : 'aria-hidden="true"'}>
    <svg class="ret" viewBox="0 0 26 26"><circle cx="13" cy="13" r="7"/><path d="M13 0v6m0 14v6M0 13h6m14 0h6"/></svg>
    <svg class="lead"><polyline pathLength="1" points="0,0 20,-20 60,-20"/></svg>
    <${label} class="lbl" ${interactive ? 'data-ui="launch-marker" aria-label="Configure mission at the Earth launch site"' : ''}><b>${title}</b><span>${subtitle}</span></${label}>
  </div>`;
}
function timelineMarkup(name) {
  return `<section class="p2-timeline" data-timeline="${name}" aria-label="Proportional mission timeline">
    <div class="p2-timeline-head"><b>MISSION SEQUENCE</b><span>DURATION TO SCALE</span></div>
    <div class="p2-time-axis" aria-hidden="true"><div class="p2-time-segment transfer" data-segment="transfer"><span>TRANSFER</span></div><div class="p2-time-segment surface" data-segment="stay"><span>SURFACE</span></div><i class="p2-arrival-pin"></i></div>
    <div class="p2-time-labels"><div><small>01 / DEPARTURE</small><time data-time="launch"></time></div><div><small>02 / LUNAR ARRIVAL</small><time data-time="arrival"></time></div><div><small>03 / MISSION END</small><time data-time="end"></time></div></div>
    <div class="p2-time-legend"><span data-duration="transfer"></span><span data-duration="stay"></span></div>
  </section>`;
}
const markup = `
<video class="p2-film" data-ui="film" aria-label="NASA Artemis II launch footage" muted playsinline preload="none" hidden></video>
<canvas class="p2-canvas" data-ui="transit" aria-label="Independent Earth–Moon transit visualization" hidden></canvas>
<div class="p2-shade" aria-hidden="true"></div><div class="grid p2-grid" aria-hidden="true"></div>
<div class="frame p2-frame" aria-hidden="true"><i></i><i></i><i></i><i></i><span class="p2-edge-scale top"></span><span class="p2-edge-scale bottom"></span></div>
<div class="p2-black" data-ui="blackout" aria-hidden="true"></div>
<header class="p2-header"><button class="p2-brand" data-ui="restart" aria-label="Restart mission planning"><b>LUNAR LANDING</b><small>SITE NAVIGATOR · DEPARTURE</small></button><div class="p2-header-line"></div><div class="p2-system"><span>MISSION CONTROL</span><b data-ui="mission-id">LLN–P2</b></div></header>
<section id="mission-date" class="p2-stage" data-view="intro">
  <div class="p2-intro-content"><p class="p2-eyebrow"><b>01</b><span>ARRIVAL EPOCH / UTC</span></p><h1 tabindex="-1">When do you want<br>to reach the Moon?</h1><p class="p2-subtitle"><span data-ui="candidate-intro"></span></p>
    <form data-ui="arrival-form" novalidate><div class="p2-date-box"><label class="p2-date-label" for="p2-arrival-date">Arrival date <small>UTC · MISSION TIME</small></label><input class="p2-arrival" id="p2-arrival-date" data-ui="arrival-date" type="date" required><div class="p2-time-row"><button class="p2-link" data-ui="toggle-time" type="button" aria-expanded="false" aria-controls="p2-arrival-time-wrap">＋ Add a time <small>OPTIONAL</small></button><div class="p2-time-wrap" id="p2-arrival-time-wrap" data-ui="time-wrap" hidden><input data-ui="arrival-time" type="time" value="12:00" aria-label="Arrival time in UTC"><span>UTC</span></div></div></div><p class="p2-error" data-ui="arrival-error" role="alert"></p><button class="p2-cta" data-ui="plan" type="submit" disabled><b>Plan my journey</b><span>COMPUTE ARRIVAL GEOMETRY ↗</span></button></form>
    <p class="p2-window"><span data-ui="window-label"></span><i></i><span>All times in UTC</span></p>
  </div>
  <aside class="panel p2-reference"><div class="p2-panel-head"><span>Mission reference</span><small>DATA READY</small></div><dl class="rows"><div><dt>Destination</dt><dd>LUNAR SOUTH POLE</dd></div><div><dt>Ephemeris</dt><dd>JPL DE421</dd></div><div><dt>Sample interval</dt><dd data-ui="ephem-step"></dd></div><div><dt>Available samples</dt><dd data-ui="ephem-count"></dd></div><div><dt>Mission window</dt><dd data-ui="ephem-window"></dd></div><div><dt>Candidate pool</dt><dd data-ui="catalog-count"></dd></div></dl><div class="p2-catalog"><div class="p2-panel-head"><span>NASA region reference</span><small>SUN VISIBILITY</small></div><div data-ui="catalog-bars"></div><p class="p2-note" data-ui="catalog-period"></p></div></aside>
  <div class="p2-terrain-tag" aria-hidden="true"><b>SHACKLETON · SOUTH POLE</b><span>LRO / LOLA · MEASURED TERRAIN</span></div>
</section>
<section id="mission-space" class="p2-stage" data-view="orbit" hidden>
  <div class="p2-heading"><button class="p2-back" data-ui="edit-date">← Edit arrival date</button><p class="p2-eyebrow"><b>02</b><span>EARTH–MOON SYSTEM</span></p><h1 tabindex="-1">Departure geometry.</h1><p class="p2-subtitle">JPL DE421 / ARRIVAL EPOCH</p></div>
  <section class="panel p2-orbit-metrics"><div class="p2-panel-head"><span>Transfer solution</span><small>EARTH TWO-BODY</small></div><dl class="rows"><div><dt>Transfer time</dt><dd data-metric="durationH">—</dd></div><div><dt>Parking altitude</dt><dd data-metric="parkingAltitudeKm">—</dd></div><div><dt>Injection Δv</dt><dd data-metric="injectionDeltaVKmS">—</dd></div><div><dt>Injection speed</dt><dd data-metric="departureSpeedKmS">—</dd></div><div><dt>Target speed</dt><dd data-metric="arrivalSpeedKmS">—</dd></div><div><dt>Earth perigee alt.</dt><dd data-metric="perigeeAltitudeKm">—</dd></div><div><dt>Earth apogee alt.</dt><dd data-metric="apogeeAltitudeKm">—</dd></div><div><dt>Target distance</dt><dd data-metric="arrivalDistanceKm">—</dd></div></dl><div class="p2-model-wrap"><p class="p2-scale-note" data-ui="transfer-note"></p><details class="p2-model-details"><summary>MODEL / DATA NOTES ＋</summary><p>The Earth two-body solution starts at an assumed 200 km parking orbit and targets the DE421 lunar position. It excludes lunar and solar gravity, powered ascent, vehicle limits and lunar capture. Earth perigee/apogee refer to the fitted geocentric orbit, not lunar apsides. Launch-site placement and body sizes are illustrative. NASA textures are historical composites, not a weather forecast.</p></details></div></section>
  <section class="panel p2-preview"><div class="p2-panel-head"><span>Route preview</span><small>NOT LIVE FLIGHT</small></div><dl class="rows"><div><dt>Elapsed transfer</dt><dd data-ui="preview-hours">—</dd></div><div><dt>Earth-centre range</dt><dd data-ui="preview-distance">—</dd></div><div><dt>Geocentric speed</dt><dd data-ui="preview-speed">—</dd></div></dl><p class="p2-note">Moving marker follows the computed samples. Bodies enlarged.</p></section>
  <div class="tags p2-tags">${anchorMarkup('earth','EARTH','DE421 ARRIVAL GEOMETRY')}${anchorMarkup('moon','MOON','ARRIVAL TARGET')}${anchorMarkup('injection','01 / INJECTION','200 KM PARKING ORBIT')}${anchorMarkup('midcourse','02 / MID-TRANSFER','50% OF TRANSFER TIME')}${anchorMarkup('arrival','03 / ARRIVAL','LUNAR-CENTRE TARGET')}${anchorMarkup('launch','EARTH / LAUNCH SITE','Configure your mission ↗',true)}</div>
  <div class="p2-orbit-bottom"><div class="p2-orbit-actions" role="group" aria-label="Orbit navigation"><button class="cta2" data-ui="recenter-orbit" type="button">Recenter view</button><button class="cta2" data-ui="configure-mission" type="button">Configure mission ↗</button></div>${timelineMarkup('orbit')}</div>
</section>
<section id="mission-site" class="p2-stage" data-view="pad" hidden>
  <div class="p2-heading"><button class="p2-back" data-ui="back-orbit">← Back to the Earth–Moon view</button><p class="p2-eyebrow"><b>03</b><span>LAUNCH COMPLEX / PRE-FLIGHT</span></p><h1 tabindex="-1">Prepare for departure.</h1><p class="p2-subtitle">LUNAR HEAVY LIFT · MISSION CONFIGURATION</p></div>
  <div class="p2-rocket-label" aria-hidden="true"><b>LUNAR HEAVY LIFT</b><small>CORE + TWIN SOLID BOOSTERS</small><small>PAD MODEL / ILLUSTRATIVE</small></div>
  <div class="p2-pad-layout">
    <section class="panel p2-config"><div class="p2-panel-head"><span>Mission settings</span><small class="p2-scroll-hint">SETTINGS ↓</small></div><form data-ui="config-form" novalidate>
      <fieldset><legend><b>01</b> Stay on the Moon <span>DURATION</span></legend>
        <div class="p2-duration-value"><input data-ui="stay-days" type="number" min="1" step="any" value="7" aria-label="Planned stay in days" aria-describedby="p2-stay-end"><span>days</span><small>EXACT DURATION</small></div>
        <input class="p2-range" data-ui="stay-range" type="range" min="24" max="336" step="1" value="168" aria-label="Stay duration in hours" aria-describedby="p2-stay-end"><div class="p2-range-ticks" data-ui="stay-ticks" aria-hidden="true"></div>
        <p class="p2-field-note" id="p2-stay-end">Minimum 1 day. Mission ends <b data-ui="mission-end">—</b></p>
      </fieldset>
      <fieldset><legend><b>02</b> Mission requirements <span>OPTIONAL</span></legend>
        <label class="p2-check"><input data-ui="crater-floor" type="checkbox"><span>Reach a crater floor</span><small data-need="craterFloor">NOT REQUESTED</small></label>
        <label class="p2-check"><input data-ui="ice-nearby" type="checkbox"><span>Water ice nearby</span><small data-need="iceNearby">NOT REQUESTED</small></label>
        <label class="p2-check"><input data-ui="continuous-comm" type="checkbox"><span>Earth link share</span><small data-need="continuousComm">NOT REQUESTED</small></label><div class="p2-bar-row"><label for="p2-comm-pct">Share of the period Earth must be visible</label><span class="p2-bar-input"><input id="p2-comm-pct" data-ui="comm-pct" type="number" min="1" max="100" step="1" value="80" inputmode="numeric" aria-describedby="p2-comm-note"><b>%</b></span></div><p class="p2-bar-note" id="p2-comm-note">This was labelled &ldquo;continuous Earth link&rdquo;, which a share cannot express: a site can see Earth for 85% of the period and still be out of contact for days at a stretch. Malapert Massif measures 84.8% and loses Earth for 123 hours; Shackleton Rim measures 51.9% and loses it for 336. The share is filtered on here; the unbroken outage each site actually suffers is listed beside it, and is the figure a relay has to cover. 80 is a demo level, not a published requirement.</p>
        <div class="p2-dark-label"><label for="p2-max-dark">Longest acceptable night</label><div class="p2-dark-value"><input id="p2-max-dark" data-ui="max-dark" type="number" min="0" step="any" value="318"><span>hours</span></div></div>
        <div class="p2-dark-scale" data-ui="dark-scale" aria-label="Catalog longest-night reference ruler"></div><div class="p2-reference-range"><span>0 HOURS</span><span data-ui="dark-scale-max"></span></div>
        <div class="p2-candidate-feedback" data-ui="candidate-feedback" role="status" aria-live="polite" aria-atomic="true"></div>
        <p class="p2-field-note" data-ui="needs-feedback">Window-specific checks run after arrival.</p>
      </fieldset><p class="p2-error" data-ui="config-error" role="alert"></p>
    </form></section>
    <aside class="p2-launch-side">${timelineMarkup('pad')}<section class="panel"><div class="p2-panel-head"><span>Readiness record</span><small>UTC</small></div><dl class="rows"><div><dt>Arrival epoch / hours</dt><dd data-ui="arrival-epoch">—</dd></div><div><dt>Surface duration</dt><dd data-ui="summary-stay">—</dd></div><div><dt>Transfer duration</dt><dd data-ui="summary-transfer">—</dd></div><div><dt>Requested conditions</dt><dd data-ui="needs-count">0 / 3</dd></div><div><dt>Site qualification</dt><dd>AFTER ARRIVAL</dd></div></dl><p class="p2-note">Launch footage is historical. Your dates and requirements continue into lunar site selection.</p></section><button class="p2-cta" data-ui="launch" disabled><b>LAUNCH</b><span>BEGIN THE JOURNEY ↑</span></button><p class="p2-launch-disclaimer">9.5-second NASA film · Skip at any time</p></aside>
  </div>
</section>
<section id="mission-launch" class="p2-stage" data-view="flight" hidden>
  <div class="p2-flight-heading"><p class="p2-eyebrow"><b>NASA ARCHIVE</b><span data-ui="flight-phase">ARTEMIS II · LAUNCH</span></p><h1 tabindex="-1">Earth departure.</h1><p class="p2-subtitle">REAL FOOTAGE / EDITED SEQUENCE</p></div><button class="p2-skip" data-ui="skip">Skip to arrival ⏭</button>
  <section class="panel p2-flight-reference"><div class="p2-panel-head"><span>Sequence clock</span><small>PLAYBACK</small></div><div class="p2-film-count"><output data-ui="film-remaining" aria-live="off">09.5</output><small>SECONDS TO ARRIVAL VIEW</small></div><dl class="rows"><div><dt>Altitude / speed</dt><dd>NOT IN THIS CLIP</dd></div><div><dt>Booster separation</dt><dd>+02:08 / REF.</dd></div><div><dt>Core engine cutoff</dt><dd>+08:06 / REF.</dd></div></dl><p class="p2-note">Reference event times: Artemis II press kit. Separation is not shown in this montage.</p></section>
  <div class="p2-flight-clock"><span>YOUR PLANNED DEPARTURE · UTC <b data-ui="film-elapsed">00.0 / 09.5 s</b></span><time data-ui="flight-date"></time><div class="p2-flight-track" data-ui="flight-progress" role="progressbar" aria-label="Launch footage progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-ui="flight-bar"></i></div><div class="p2-film-events"><span data-film-phase="0">01 / LIFTOFF</span><span data-film-phase="1">02 / ASCENT</span><span data-film-phase="2">03 / EARTH VIEW</span></div></div>
  <div class="p2-film-error" data-ui="film-error" role="alert" hidden><span data-ui="film-error-text"></span><button data-ui="film-retry">Play launch footage</button></div>
  <p class="p2-footage-credit"><a href="https://svs.gsfc.nasa.gov/31385" target="_blank" rel="noopener noreferrer">NASA · Artemis II launch ↗</a><br>Historical footage · Edited sequence<br><a href="https://www.nasa.gov/artemis-ii-press-kit/" target="_blank" rel="noopener noreferrer">Reference event timeline ↗</a></p>
</section>
<p class="p2-sr-only" data-ui="flight-status" role="status" aria-live="polite" aria-atomic="true"></p>
<footer class="p2-footer"><nav aria-label="Mission progress"><ol class="p2-steps"><li data-step="intro" class="active" aria-current="step"><b>01</b> Arrival date</li><li data-step="orbit"><b>02</b> Earth–Moon</li><li data-step="pad"><b>03</b> Mission setup</li><li data-step="flight"><b>04</b> Launch</li><li data-step="handoff"><b>05</b> Site selection</li></ol></nav><span class="p2-footer-credit">NASA SPACE APPS / LUNAR LANDING SITE MISSION</span></footer>
<section class="p2-boot out" data-ui="boot" aria-label="System startup" aria-hidden="true"><div class="p2-boot-box"><p class="p2-boot-head"><b>LLN</b> LUNAR MISSION SYSTEMS <span>P2 / DEPARTURE</span></p><ol class="p2-boot-log" data-ui="boot-log" aria-live="polite"></ol><div class="p2-boot-track"><i data-ui="boot-bar"></i></div><p class="p2-boot-foot"><span>INITIALIZING MISSION CONTROL</span><span data-ui="boot-percent">00%</span></p><p class="p2-error" data-ui="boot-error" role="alert"></p></div></section>
`;

export function createMission({ eph, data, onMissionReady }) {
  if (typeof onMissionReady !== 'function') throw new TypeError('onMissionReady must be a function.');
  const bounds = getMissionBounds(eph);
  const existing = document.getElementById('mission');
  const root = existing || document.createElement('div');
  if (existing?.dataset.p2Mounted === 'true') throw new Error('A P2 mission is already mounted.');
  root.id = 'mission';
  root.dataset.p2Mounted = 'true';
  root.dataset.stage = 'boot';
  if (!existing) root.hidden = false;
  root.innerHTML = `<style>${styles}</style>${markup}`;
  if (!existing) document.body.append(root);
  const ui = name => root.querySelector(`[data-ui="${name}"]`);
  const events = new AbortController();
  const listen = (element, event, fn) => element.addEventListener(event, fn, { signal: events.signal });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const catalog = data?.sites ?? { sites: [] };
  const candidates = candidatePool(data ?? {});
  let recentering = false;
  let transitionToken = 0, transitioning = false;
  let transit, film, filmPreloaded = false, preciseTime = false, disposed = false, completed = false, stage = 'boot', currentConfig = null;
  let arriveH = Math.min(Math.max(84, dateToHours(new Date(), eph)), Math.max(0, bounds.maxH - 168));
  const started = performance.now();
  const isoDay = h => eph.hoursToDate(h).toISOString().slice(0, 10);
  const fullDate = h => eph.hoursToDate(h).toISOString().slice(0, 16).replace('T', ' ');
  const bootLines = new Set();
  let transitPerformance = null, profileFrame = 0;
  if (new URLSearchParams(location.search).has('perf')) {
    const output = document.createElement('output');
    output.setAttribute('aria-label', 'Rendering performance');
    output.style.cssText = 'position:absolute;z-index:90;right:20px;bottom:72px;max-width:90vw;padding:8px;background:#000d;color:#fff;font:11px monospace;pointer-events:none';
    root.append(output);
    let start = 0, previous = 0, sampleStage = '', intervals = [];
    const sample = t => {
      if (disposed) return;
      profileFrame = requestAnimationFrame(sample);
      if (sampleStage !== stage) { sampleStage = stage; start = t; previous = t; intervals = []; }
      if (previous && t - start > 1000) intervals.push(t - previous);
      previous = t;
      if (t - start < 5000) return;
      const sorted = [...intervals].sort((a, b) => a - b);
      const mean = intervals.reduce((a, b) => a + b, 0) / Math.max(1, intervals.length);
      output.textContent = JSON.stringify({ stage, rafFps: Number((1000 / mean).toFixed(1)),
        p95Ms: Number((sorted[Math.floor(sorted.length * .95)] ?? 0).toFixed(1)),
        surfaceFps: Number(root.dataset.surfaceFps || 0), ...transitPerformance,
        ...(['flight', 'handoff'].includes(stage) && ui('film').getVideoPlaybackQuality ? { videoFrames: ui('film').getVideoPlaybackQuality().totalVideoFrames, droppedVideoFrames: ui('film').getVideoPlaybackQuality().droppedVideoFrames } : {}) });
      start = t; intervals = [];
    };
    profileFrame = requestAnimationFrame(sample);
  }

  function bootLog(message, status = 'OK') {
    if (disposed || bootLines.has(message)) return;
    bootLines.add(message);
    const row = document.createElement('li');
    const stamp = document.createElement('time');
    stamp.textContent = ((performance.now() - started) / 1000).toFixed(2).padStart(6, '0');
    const text = document.createElement('span'); text.className = 'message'; text.textContent = message;
    const state = document.createElement('small'); state.textContent = status;
    if (status === 'FAIL') row.className = 'error';
    row.append(stamp, text, state); ui('boot-log').append(row);
  }
  function progress(percent) {
    ui('boot-bar').style.width = `${percent}%`;
    ui('boot-percent').textContent = `${String(Math.round(percent)).padStart(2, '0')}%`;
  }
  const pause = ms => new Promise(resolve => setTimeout(resolve, reducedMotion.matches ? 0 : ms));
  function clearTransition() {
    delete root.dataset.transition;
    ui('blackout').style.opacity = '0';
    ui('transit').style.filter = '';
    ui('transit').style.transform = '';
  }
  function updateSteps(next) {
    let passed = true;
    root.querySelectorAll('[data-step]').forEach(step => {
      const active = step.dataset.step === next;
      if (active) passed = false;
      step.classList.toggle('active', active);
      step.classList.toggle('complete', passed && next !== 'boot');
      if (active) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
  }
  function applyStage(next) {
    stage = next;
    root.dataset.stage = next;
    root.querySelectorAll('[data-view]').forEach(section => {
      section.hidden = section.dataset.view !== next;
      section.classList.remove('in');
      section.inert = section.hidden || transitioning;
    });
    updateSteps(next);
    ui('transit').hidden = next !== 'orbit' && next !== 'pad';
    ui('film').hidden = next !== 'flight';
    if (next === 'pad' && !filmPreloaded) {
      filmPreloaded = true; ui('film').preload = 'auto'; ui('film').load();
    }
    root.dispatchEvent(new CustomEvent('missionstagechange', { bubbles: true, detail: { stage: next } }));
  }
  async function setStage(next) {
    if (disposed || transitioning || (completed && next !== 'intro')) return;
    const previous = stage, token = ++transitionToken;
    transitioning = true;
    root.dataset.transition = 'depart';
    root.querySelector(`[data-view="${previous}"]`)?.setAttribute('inert', '');
    const spatial = ['orbit', 'pad'].includes(next);
    if (spatial) {
      // The outgoing HUD retires before the camera moves; the next HUD waits for settle.
      if (previous !== 'boot') await pause(170);
      if (token !== transitionToken || disposed) return;
      applyStage(next);
      const result = await transit?.show(next, arriveH);
      if (result?.cancelled) return;
    } else if (previous !== 'boot' && !reducedMotion.matches) {
      ui('blackout').style.transition = 'opacity .28s var(--ease)';
      ui('blackout').style.opacity = '1';
      ui('transit').style.transition = 'transform .28s var(--ease), filter .28s';
      ui('transit').style.transform = 'scale(1.04)';
      ui('transit').style.filter = 'blur(3px)';
      await pause(280);
      if (token !== transitionToken || disposed) return;
      applyStage(next);
      await pause(180);
      if (token !== transitionToken || disposed) return;
      ui('blackout').style.opacity = '0';
      await pause(280);
    } else applyStage(next);
    if (token !== transitionToken || disposed) return;
    transitioning = false;
    clearTransition();
    const section = root.querySelector(`[data-view="${next}"]`);
    section?.classList.add('in');
    section?.removeAttribute('inert');
    requestAnimationFrame(() => section?.querySelector('h1')?.focus({ preventScroll: true }));
  }
  function updateTimeline(config) {
    const transferH = config.arriveH - config.launchH;
    const share = transferH / (transferH + config.stayH) * 100;
    root.querySelectorAll('[data-timeline]').forEach(timeline => {
      timeline.hidden = false;
      timeline.querySelector('[data-segment="transfer"]').style.width = `${share}%`;
      timeline.querySelector('[data-segment="stay"]').style.width = `${100 - share}%`;
      timeline.querySelector('.p2-arrival-pin').style.left = `${share}%`;
      for (const [key, h] of [['launch', config.launchH], ['arrival', config.arriveH], ['end', config.arriveH + config.stayH]]) {
        const time = timeline.querySelector(`[data-time="${key}"]`);
        time.textContent = fullDate(h);
        time.dateTime = eph.hoursToDate(h).toISOString();
      }
      timeline.querySelector('[data-duration="transfer"]').textContent = `TRANSFER / ${Number(transferH.toFixed(2))} h`;
      timeline.querySelector('[data-duration="stay"]').textContent = `SURFACE / ${Number(config.stayH.toFixed(2))} h`;
      timeline.setAttribute('aria-label', `Mission timeline: ${transferH} hours transfer, ${config.stayH} hours on the surface. End ${fullDate(config.arriveH + config.stayH)} UTC.`);
    });
  }
  function updateStayRange(stayH) {
    const available = bounds.maxH - arriveH;
    const requested = Number.isFinite(stayH) ? Math.max(MIN_STAY_H, stayH) : MIN_STAY_H;
    const max = Math.min(available, Math.max(336, Math.ceil(requested / 24) * 24));
    const min = MIN_STAY_H;
    ui('stay-range').min = String(min);
    ui('stay-range').max = String(max);
    ui('stay-range').step = Number.isInteger(stayH) && Number.isInteger(min) && Number.isInteger(max) ? '1' : 'any';
    ui('stay-range').value = String(Math.max(min, Math.min(max, requested)));
    const valid = Number.isFinite(stayH) && stayH >= min && stayH <= available;
    ui('stay-range').setAttribute('aria-valuetext', valid
      ? `${Number(stayH.toFixed(3))} hours; ends ${fullDate(arriveH + stayH)} UTC`
      : `Duration needs correction. Choose at least ${min} hours, within the remaining mission window.`);
    const marks = [{ h: 24, text: '24 h' }, { h: 72, text: '3 d' }, { h: 168, text: '7 d' }, { h: max, text: `${Number((max / 24).toFixed(1))} d` }];
    const accepted = [];
    ui('stay-ticks').replaceChildren();
    for (const mark of marks) {
      const ratio = max === min ? 0 : (mark.h - min) / (max - min);
      if (ratio < 0 || ratio > 1 || accepted.some(x => Math.abs(x - ratio) < .055)) continue;
      const label = document.createElement('span'); label.textContent = mark.text;
      label.style.left = `${ratio * 100}%`; ui('stay-ticks').append(label); accepted.push(ratio);
    }
  }
  function updateCandidates(needs) {
    const feedback = catalogFeedback(catalog, needs);
    const values = feedback.baselineDarkness.rows;
    const max = Math.max(24, Math.ceil(Math.max(0, ...values.map(row => row.longestDarkH ?? 0)) / 24) * 24);
    const scale = ui('dark-scale'); scale.replaceChildren();
    for (const row of values) {
      if (row.longestDarkH === null) continue;
      const tick = document.createElement('i'); tick.className = `p2-dark-site${row.withinBaselineLimit ? ' pass' : ''}`;
      tick.style.left = `${row.longestDarkH / max * 100}%`;
      const label = document.createElement('span'); label.textContent = `${row.id} / ${row.longestDarkH} h`;
      tick.title = `${row.name}: ${row.longestDarkH} hours longest darkness over ${feedback.periodLabel}`;
      tick.append(label); scale.append(tick);
    }
    const cursor = document.createElement('i'); cursor.className = 'p2-dark-cursor';
    cursor.style.left = `${Math.min(1, needs.maxDarkH / max) * 100}%`;
    const label = document.createElement('span'); label.textContent = `${needs.maxDarkH} h LIMIT`; cursor.append(label); scale.append(cursor);
    scale.setAttribute('aria-label', values.map(row => `${row.name}: ${row.longestDarkH ?? 'unknown'} hours`).join('; '));
    ui('dark-scale-max').textContent = `${max} HOURS`;
    // "sites" unqualified read as the whole pool, which is larger than this preview:
    // catalogFeedback is deliberately scoped to the published regions (see its own note), so the
    // count has to name them or it undercounts the candidates by the data-selected ones.
    const text = document.createElement('span'); text.textContent = `${feedback.baselineDarkness.passCount} / ${feedback.total} NASA regions within this darkness limit`;
    const note = document.createElement('small'); note.textContent = `${feedback.periodLabel} NASA region reference. This is not a result for your selected stay; the full candidate pool is ranked after arrival.`;
    // When the limit admits nothing, say so here rather than letting the flow carry on in
    // silence. The requirement is not rejected -- asking "what if I can tolerate no darkness at
    // all" is a fair thing to ask of this tool -- but launching against a limit the measured
    // ground cannot meet should not look the same as launching against one it can.
    const impossible = feedback.baselineDarkness.passCount === 0 && feedback.total > 0;
    if (impossible) {
      const warn = document.createElement('strong');
      warn.className = 'p2-impossible';
      warn.textContent = `No published region survives ${needs.maxDarkH} h of darkness. `
        + `The shortest measured night in the catalogue is ${Math.min(...values.map((r) => r.longestDarkH ?? Infinity))} h, `
        + `so this mission cannot be met as configured.`;
      // Appended, not prepended: the count and its note keep their positions so nothing reading
      // this panel by child index has to know whether a warning is present.
      ui('candidate-feedback').replaceChildren(text, note, warn);
    } else ui('candidate-feedback').replaceChildren(text, note);
    const keys = ['craterFloor', 'iceNearby', 'continuousComm'];
    for (const key of keys) root.querySelector(`[data-need="${key}"]`).textContent = needs[key] ? 'PENDING ANALYSIS' : 'NOT REQUESTED';
    const requested = keys.filter(key => needs[key]).length;
    ui('needs-count').textContent = `${requested} / 3`;
    ui('needs-feedback').textContent = requested ? 'Requested conditions saved. Crater-floor and confirmed-ice classifications are not in this catalog; communication needs your mission window analysis.' : 'Select requirements to pass them to the lunar site analysis.';
  }
  function positionAnchor(name, anchor) {
    const tag = root.querySelector(`[data-anchor="${name}"]`);
    if (!tag) return;
    const visible = anchor.visible && stage === 'orbit';
    tag.classList.toggle('off', !visible);
    if (!visible) return;
    const { x, y } = anchor, w = root.clientWidth, h = root.clientHeight;
    let dx = name === 'earth' ? -95 : name === 'moon' ? 48 : name === 'launch' ? 40 : 45;
    let dy = name === 'launch' ? 72 : name === 'midcourse' ? -40 : -42;
    if (w <= 650 && name === 'launch') { dx = 28; dy = -25; }
    const label = tag.querySelector('.lbl'), width = label.offsetWidth || 180, height = label.offsetHeight || 41;
    let lx = Math.max(24, Math.min(w - width - 24, x + dx));
    let ly = Math.max(110 + height, Math.min(h - (w <= 650 ? 340 : h <= 520 ? 220 : 196), y + dy));
    // Keep the launch control above the orbit data dock on compact displays.
    if (name === 'launch' && w <= 650) ly = Math.min(ly, h - (h <= 740 ? 285 : 370));
    tag.style.transform = `translate(${x}px,${y}px)`;
    label.style.left = `${lx - x}px`; label.style.top = `${ly - y}px`;
    const endX = lx - x + (lx < x ? width : 0), endY = ly - y;
    tag.querySelector('polyline').setAttribute('points', `0,0 ${endX * .35},${endY} ${endX},${endY}`);
  }
  function syncArrivalTimeBounds() {
    const day = ui('arrival-date').value;
    ui('arrival-time').min = day === isoDay(0) ? fullDate(0).slice(11) : '00:00';
    ui('arrival-time').max = day === isoDay(bounds.maxArrivalH) ? fullDate(bounds.maxArrivalH).slice(11) : '23:59';
  }
  function readArrival() {
    const day = ui('arrival-date').value;
    const time = preciseTime && ui('arrival-time').value ? ui('arrival-time').value : '00:00';
    const h = dateToHours(new Date(`${day}T${time}:00Z`), eph);
    if (!Number.isFinite(h) || h < bounds.minH || h > bounds.maxArrivalH) {
      throw new RangeError(`Choose an arrival between ${bounds.minDate} and ${fullDate(bounds.maxArrivalH)} UTC to leave at least one day for your stay.`);
    }
    return h;
  }
  function updateConfig() {
    ui('arrival-epoch').textContent = `${Number(arriveH.toFixed(3))} h`;
    ui('mission-id').textContent = `LLN-${isoDay(arriveH).replaceAll('-', '')}`;
    ui('summary-transfer').innerHTML = `${Number(Math.min(84, arriveH).toFixed(2))} <small>hours · planned</small>`;
    updateStayRange(Number(ui('stay-days').value) * 24);
    try {
      if (!ui('stay-days').value || !ui('max-dark').value) throw new RangeError('Enter the stay duration and maximum darkness.');
      currentConfig = buildMissionConfig(eph, {
        arriveH, stayH: Number(ui('stay-days').value) * 24,
        needs: { craterFloor: ui('crater-floor').checked, iceNearby: ui('ice-nearby').checked,
          continuousComm: ui('continuous-comm').checked ? Number(ui('comm-pct').value) : false, maxDarkH: Number(ui('max-dark').value) }
      });
      root.dataset.configValid = 'true';
      ui('config-error').textContent = '';
      ui('mission-end').textContent = `${fullDate(arriveH + currentConfig.stayH)} UTC`;
      updateTimeline(currentConfig);
      updateCandidates(currentConfig.needs);
      ui('summary-stay').innerHTML = `${Number((currentConfig.stayH / 24).toFixed(3))} <small>days</small>`;
      ui('launch').disabled = !transit;
    } catch (error) {
      currentConfig = null;
      root.dataset.configValid = 'false';
      ui('config-error').textContent = error.message;
      ui('launch').disabled = true;
      ui('mission-end').textContent = 'Outside the mission window';
      ui('summary-stay').textContent = 'Needs correction';
      root.querySelectorAll('[data-timeline]').forEach(timeline => { timeline.hidden = true; });
    }
  }
  async function finishMission(config) {
    if (completed || disposed) return;
    completed = true;
    updateSteps('handoff');
    const token = ++transitionToken;
    root.dataset.transition = 'depart';
    ui('blackout').style.transition = 'opacity .3s var(--ease)';
    ui('blackout').style.opacity = '1';
    await pause(300);
    if (disposed || token !== transitionToken) return;
    // The host owns its clock and screen transitions at this boundary.
    stage = 'handoff';
    root.dataset.stage = stage;
    ui('transit').hidden = true;
    film?.cancel(); ui('film').hidden = true;
    if (!existing) root.hidden = true;
    root.dispatchEvent(new CustomEvent('missionstagechange', { bubbles: true, detail: { stage } }));
    onMissionReady(config);
  }
  function restart() {
    if (stage === 'flight' || transitioning) return;
    completed = false;
    if (!existing) root.hidden = false;
    setStage('intro');
  }
  function hideMission() {
    if (disposed) return;
    completed = true;
    film?.cancel();
    transitionToken++; transitioning = false;
    clearTransition();
    applyStage('handoff');
    ui('transit').hidden = true;
    if (!existing) root.hidden = true;
  }

  ui('ephem-step').textContent = `${eph.stepH} HOURS`;
  ui('ephem-count').textContent = countLabel(eph.count);
  ui('ephem-window').textContent = bounds.label;
  ui('catalog-count').textContent = `${candidates.length} CANDIDATES`;
  ui('candidate-intro').textContent = `ONE MOMENT. ${candidates.length} POSSIBLE LANDING SITES.`;
  ui('catalog-period').textContent = `${catalog.sites.length} NASA regions · ${catalog.stats_years?.join('–') || 'Catalog period'} means. The full pool also includes data-selected candidates.`;
  for (const site of catalog.sites) {
    const row = document.createElement('div'); row.className = 'p2-catalog-row'; row.title = site.en;
    const id = document.createElement('span'); id.textContent = site.id;
    const bar = document.createElement('i'); bar.style.setProperty('--sun', `${Math.max(0, Math.min(100, site.stats?.sun_visible_pct || 0))}%`);
    const value = document.createElement('b'); value.textContent = `${site.stats?.sun_visible_pct ?? '—'}%`;
    row.append(id, bar, value); ui('catalog-bars').append(row);
  }
  ui('arrival-date').min = bounds.minDate;
  ui('arrival-date').max = bounds.maxDate;
  ui('arrival-date').value = isoDay(arriveH);
  syncArrivalTimeBounds();
  ui('window-label').textContent = `Mission window ${bounds.label}`;
  listen(ui('toggle-time'), 'click', () => {
    preciseTime = !preciseTime;
    ui('time-wrap').hidden = !preciseTime;
    ui('toggle-time').setAttribute('aria-expanded', String(preciseTime));
    ui('toggle-time').innerHTML = `${preciseTime ? '− Hide time' : '＋ Add a time'} <small>OPTIONAL</small>`;
  });
  listen(ui('arrival-form'), 'submit', event => {
    event.preventDefault();
    if (!transit || transitioning) return;
    try {
      arriveH = readArrival();
      ui('arrival-error').textContent = '';
      ui('stay-days').max = String((bounds.maxH - arriveH) / 24);
      // Preserve the user's duration; an out-of-range stay must be corrected explicitly.
      updateConfig();
      setStage('orbit');
    } catch (error) { ui('arrival-error').textContent = error.message; }
  });
  listen(ui('arrival-date'), 'input', () => { syncArrivalTimeBounds(); ui('arrival-error').textContent = ''; });
  // The terrain caption is decoration on the map art. With a fixed bottom offset it collided with
  // the reference panel whenever the panel's text wrapped to more lines (narrow windows), so it
  // is placed under the panel's real bottom edge instead, or hidden if there is no room left.
  const placeTag = () => {
    const tag = root.querySelector('.p2-terrain-tag'), ref = root.querySelector('.p2-reference');
    if (!tag || !ref || getComputedStyle(tag).display === 'none' || getComputedStyle(ref).position !== 'absolute') return;
    const host = root.getBoundingClientRect(), r = ref.getBoundingClientRect();
    const top = r.bottom - host.top + 16, room = host.height - 70;   // keep clear of the step footer
    tag.style.bottom = 'auto';
    tag.style.top = `${top}px`;
    tag.style.visibility = top + tag.offsetHeight > room ? 'hidden' : '';
  };
  window.addEventListener('resize', placeTag, { signal: events.signal });
  requestAnimationFrame(placeTag);
  setTimeout(placeTag, 600);   // after the catalogue rows and fonts have settled the panel height
  listen(ui('arrival-time'), 'input', () => { ui('arrival-error').textContent = ''; });
  listen(ui('edit-date'), 'click', () => setStage('intro'));
  listen(ui('launch-marker'), 'click', () => setStage('pad'));
  // A fixed HUD route stays reachable even when the projected launch label is hidden.
  listen(ui('configure-mission'), 'click', () => setStage('pad'));
  listen(ui('recenter-orbit'), 'click', async () => {
    if (!transit || stage !== 'orbit' || transitioning || recentering || disposed) return;
    recentering = true;
    ui('recenter-orbit').disabled = true;
    try {
      const result = await transit.recenterOrbit();
      if (!disposed && stage === 'orbit' && !result.cancelled) ui('flight-status').textContent = 'Earth–Moon view recentered. Mission settings are unchanged.';
    } finally {
      recentering = false;
      if (!disposed) ui('recenter-orbit').disabled = false;
    }
  });
  listen(ui('back-orbit'), 'click', () => setStage('orbit'));
  listen(ui('restart'), 'click', restart);
  listen(ui('config-form'), 'submit', event => event.preventDefault());
  listen(ui('config-form'), 'input', event => {
    if (event.target === ui('stay-range')) ui('stay-days').value = String(Number(event.target.value) / 24);
    updateConfig();
  });
  const launchVideo = ui('film');
  launchVideo.src = new URL('./scene/assets/artemis-launch.mp4', import.meta.url).href;
  launchVideo.muted = true;
  launchVideo.playsInline = true;
  film = createLaunchFilm({
    video: launchVideo,
    onProgress({ progress, currentTime, duration }) {
      const percent = Math.round(progress * 100);
      const phase = currentTime < 4 ? 'LIFTOFF' : currentTime < 7 ? 'POWERED ASCENT' : 'ONBOARD EARTH VIEW';
      const total = duration || 9.5;
      ui('film-remaining').textContent = Math.max(0, total - currentTime).toFixed(1).padStart(4, '0');
      ui('film-elapsed').textContent = `${currentTime.toFixed(1).padStart(4, '0')} / ${total.toFixed(1)} s`;
      root.querySelectorAll('[data-film-phase]').forEach(node => node.classList.toggle('active', Number(node.dataset.filmPhase) === (currentTime < 4 ? 0 : currentTime < 7 ? 1 : 2)));
      ui('flight-bar').style.width = `${progress * 100}%`;
      ui('flight-progress').setAttribute('aria-valuenow', String(percent));
      ui('flight-progress').setAttribute('aria-valuetext', `${percent}% of launch footage`);
      if (ui('flight-phase').textContent !== phase) {
        ui('flight-phase').textContent = phase;
        // Announce meaningful phases, rather than every media time update.
        if (progress < 1) ui('flight-status').textContent = currentTime < 4
          ? 'Launch footage started. Liftoff. You can skip to lunar arrival.'
          : currentTime < 7 ? 'Powered ascent.' : 'Earth and cloud view.';
      }
    },
    onComplete() {
      ui('flight-status').textContent = 'Opening lunar site selection.';
      ui('restart').disabled = false;
      finishMission(currentConfig);
    },
    onError() {
      ui('film-error-text').textContent = 'Launch footage could not play. Try again, or skip to lunar arrival.';
      ui('film-error').hidden = false;
    }
  });
  listen(ui('film-retry'), 'click', () => { ui('film-error').hidden = true; ui('flight-phase').textContent = ''; film.play(); });
  listen(ui('launch'), 'click', async () => {
    updateConfig();
    if (!currentConfig || !transit || completed || transitioning || stage !== 'pad') return;
    const config = currentConfig;
    await setStage('flight');
    if (disposed || completed || stage !== 'flight') return;
    ui('restart').disabled = true;
    ui('flight-date').textContent = fullDate(config.launchH);
    ui('flight-bar').style.width = '0%';
    ui('flight-phase').textContent = '';
    ui('film-error').hidden = true;
    film.play();
  });
  listen(ui('skip'), 'click', () => { if (stage === 'flight') film?.skip(); });
  listen(root, 'keydown', event => {
    // Keep date entry and Escape local; the host has its own navigation keys.
    event.stopPropagation();
    if (transitioning || event.key !== 'Escape' || /INPUT|SELECT/.test(event.target.tagName)) return;
    if (stage === 'flight') film?.skip();
    else if (stage === 'pad') setStage('orbit');
    else if (stage === 'orbit') setStage('intro');
  });

  bootLog(`Ephemeris ${bounds.label} / ${countLabel(eph.count)} samples / ${eph.stepH} h step`);
  bootLog('Validate UTC mission clock and sample bounds');
  bootLog(`Receive ${candidates.length} candidate sites from host`);
  progress(18);
  const ready = (async () => {
    const { createTransit } = await import('./scene/transit.js');
    if (disposed) return;
    transit = await createTransit({
      canvas: ui('transit'), eph, data,
      onPerformance(stats) { transitPerformance = { transitFps: Number(stats.fps.toFixed(1)), drawCalls: stats.drawCalls, triangles: stats.triangles, pixelRatio: Number(stats.pixelRatio.toFixed(2)), targetFps: stats.targetFps }; },
      onTransfer(info) {
        if (!info.available) for (const field of ['preview-hours', 'preview-distance', 'preview-speed']) ui(field).textContent = 'UNAVAILABLE';
        const units = { durationH: 'h', parkingAltitudeKm: 'km', injectionDeltaVKmS: 'km/s', departureSpeedKmS: 'km/s', arrivalSpeedKmS: 'km/s', perigeeAltitudeKm: 'km', apogeeAltitudeKm: 'km', arrivalDistanceKm: 'km' };
        root.querySelectorAll('[data-metric]').forEach(node => {
          const key = node.dataset.metric, value = info[key];
          node.textContent = !info.available ? 'UNAVAILABLE' : Number.isFinite(value) ? `${key.endsWith('KmS') ? value.toFixed(3) : countLabel(Math.round(value))} ${units[key]}` : key === 'apogeeAltitudeKm' && info.bound === false ? 'UNBOUND' : '—';
        });
        ui('transfer-note').textContent = info.available
          ? 'Two-body transfer estimate · 200 km parking orbit · DE421 arrival target · Bodies enlarged'
          : `Transfer estimate unavailable: ${info.reason || 'choose a later arrival date'}. Arrival geometry still uses DE421.`;
      },
      onProgress({ loaded, total, label }) { bootLog(label); progress(Math.min(94, 18 + loaded / Math.max(1, total) * 76)); },
      onTransition({ phase, blackout, blurPx }) {
        if (disposed || !transitioning) return;
        root.dataset.transition = phase;
        ui('blackout').style.transition = 'none';
        ui('blackout').style.opacity = String(blackout);
        ui('transit').style.transition = 'none';
        ui('transit').style.filter = blurPx ? `blur(${Math.min(3, blurPx)}px)` : '';
      },
      onAnchors(anchors) { if (!disposed) for (const [name, anchor] of Object.entries(anchors)) positionAnchor(name, anchor); },
      onRouteProgress({ elapsedH, distanceKm, speedKmS }) {
        if (disposed || stage !== 'orbit') return;
        ui('preview-hours').textContent = `${elapsedH.toFixed(1)} h`;
        ui('preview-distance').textContent = `${countLabel(Math.round(distanceKm))} km`;
        ui('preview-speed').textContent = `${speedKmS.toFixed(3)} km/s`;
      }
    });
    if (disposed) { transit.dispose(); return; }
    bootLog('Compile transit shaders and verify first frame');
    progress(97);
    // No minimum on-screen time any more. This used to hold a second start-up screen up for at
    // least 2.3 s, but the application's own start-up has already run and faded by the time this
    // does, so the visitor saw two boot sequences back to back. The loading above is real and
    // still gates the Plan button; only the staged delay for show is gone.
    if (disposed) return;
    bootLog('SYSTEMS NOMINAL'); progress(100);
    await new Promise(resolve => setTimeout(resolve, 380));
    if (disposed) return;
    ui('boot').classList.add('out');
    if (stage !== 'handoff') setStage('intro');
    ui('plan').disabled = false;
  })().catch(error => {
    if (disposed) return;
    bootLog('Mission initialization failed', 'FAIL');
    ui('boot-error').textContent = `${error.message} Refresh to retry.`;
    // The start-up screen is hidden from the first frame now, so a failure has to bring it back:
    // the message lives inside it, and an error nobody can see is a screen that just never loads.
    ui('boot').classList.remove('out');
    ui('boot').removeAttribute('aria-hidden');
    throw error;
  });
  return {
    ready,
    show: restart,
    hide: hideMission,
    get stage() { return stage; },
    getConfiguration() { return currentConfig ? structuredClone(currentConfig) : null; },
    getGeometrySnapshot() { return transit?.getGeometrySnapshot(); },
    destroy() {
      if (disposed) return;
      hideMission();
      disposed = true;
      cancelAnimationFrame(profileFrame);
      events.abort();
      film?.destroy();
      launchVideo.removeAttribute('src'); launchVideo.load();
      transit?.dispose();
      root.replaceChildren();
      if (!existing) root.hidden = true;
      delete root.dataset.p2Mounted;
      if (!existing) root.remove();
    }
  };
}

function countLabel(count) { return new Intl.NumberFormat('en-US').format(count); }
