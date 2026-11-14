import { createLaunchFilm } from './launch-film.js';

// P2 owns this module and its #mission mount only. P1 keeps its scene and shaders.
// All persistent mission times are hours from the injected ephemeris epoch.
export const dateToHours = (date, eph) => (date.getTime() - eph.start) / 3600e3;

export function getMissionBounds(eph) {
  const { startYear, endYear, start, stepH, count, maxH } = eph;
  if (![startYear, endYear, start, stepH, count, maxH].every(Number.isFinite) ||
      !Number.isInteger(count) || count < 2 || stepH <= 0 || maxH <= 0 ||
      endYear < startYear || typeof eph.hoursToDate !== 'function') {
    throw new TypeError('The mission requires complete ephemeris metadata and hoursToDate().');
  }
  const firstDate = `${startYear}-01-01`;
  const lastCalendarDate = `${endYear}-12-31`;
  const lastSampleDate = eph.hoursToDate(maxH).toISOString().slice(0, 10);
  return {
    minH: 0, maxH, minDate: firstDate,
    maxDate: lastSampleDate < lastCalendarDate ? lastSampleDate : lastCalendarDate,
    label: startYear === endYear ? String(startYear) : `${startYear}–${endYear}`
  };
}

export function buildMissionConfig(eph, { arriveH, stayH, needs = {} }) {
  const { maxH } = getMissionBounds(eph);
  if (!Number.isFinite(arriveH) || arriveH < 0 || arriveH > maxH) {
    throw new RangeError('Choose an arrival time within the available mission window.');
  }
  if (!Number.isFinite(stayH) || stayH <= 0) throw new RangeError('Enter a stay longer than zero hours.');
  if (arriveH + stayH > maxH) {
    throw new RangeError('The planned stay extends beyond the ephemeris. Choose an earlier arrival or a shorter stay.');
  }
  const maxDarkH = needs.maxDarkH ?? 72;
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
      continuousComm: Boolean(needs.continuousComm),
      maxDarkH
    }
  };
}

// Keep P2 styles inside its lifecycle and scope every selector to #mission.
// This deliberately avoids the shared style.css and the P1/P3 screens.
const styles = `
#mission{--p2-fg:#f2f4f5;--p2-dim:#88969f;--p2-line:#f2f4f536;--p2-red:#e2200f;--p2-pad:clamp(22px,3vw,50px);position:fixed;inset:0;z-index:30;color:var(--p2-fg);font-family:Rajdhani,Arial,sans-serif;font-weight:500;-webkit-font-smoothing:antialiased;overflow:hidden;pointer-events:auto}
#mission[hidden],#mission [hidden]{display:none!important}#mission.out{opacity:0;transition:opacity .45s}#mission.out,#mission.out *{pointer-events:none!important}#mission *{box-sizing:border-box}#mission button,#mission input{font:inherit;color:inherit}#mission button{cursor:pointer}#mission button:disabled{opacity:.35;cursor:not-allowed}#mission button:focus-visible,#mission input:focus-visible{outline:2px solid white;outline-offset:4px}#mission h1:focus{outline:none}
#mission .p2-canvas,#mission .p2-grid,#mission .p2-shade{position:absolute;inset:0;width:100%;height:100%}#mission .p2-canvas{display:block;background:#000}#mission .p2-grid{pointer-events:none;background:linear-gradient(90deg,#f2f4f510 1px,transparent 1px) center/128px 100%,linear-gradient(#f2f4f510 1px,transparent 1px) center/100% 128px;opacity:.55}#mission .p2-shade{pointer-events:none;background:linear-gradient(90deg,#000c,transparent 72%),linear-gradient(0deg,#000d,transparent 23%,transparent 78%,#0008)}
#mission[data-stage=orbit] .p2-shade{background:linear-gradient(0deg,#000a,transparent 30%,transparent 76%,#0007)}
#mission .p2-frame{position:absolute;inset:10px;pointer-events:none;background:linear-gradient(#fff7,#fff7) left top/18px 1px no-repeat,linear-gradient(#fff7,#fff7) left top/1px 18px no-repeat,linear-gradient(#fff7,#fff7) right top/18px 1px no-repeat,linear-gradient(#fff7,#fff7) right top/1px 18px no-repeat,linear-gradient(#fff7,#fff7) right bottom/18px 1px no-repeat,linear-gradient(#fff7,#fff7) right bottom/1px 18px no-repeat,linear-gradient(#fff7,#fff7) left bottom/18px 1px no-repeat,linear-gradient(#fff7,#fff7) left bottom/1px 18px no-repeat;z-index:8}
#mission .p2-header{position:absolute;top:30px;left:var(--p2-pad);right:var(--p2-pad);display:flex;align-items:center;gap:25px;z-index:6}#mission .p2-brand{border:0;border-left:3px solid var(--p2-red);background:none;text-align:left;padding:0 0 0 12px;display:grid;gap:6px}#mission .p2-brand b{font-size:16px;letter-spacing:.16em;font-weight:700}#mission .p2-brand small{font-size:9px;letter-spacing:.2em;color:#bdc5ca}#mission .p2-header-line{height:7px;flex:1;border-left:1px solid var(--p2-line);border-right:1px solid var(--p2-line);background:linear-gradient(90deg,var(--p2-line),transparent 25%,transparent 75%,var(--p2-line)) center/100% 1px no-repeat}#mission .p2-system{font-size:10px;letter-spacing:.16em;display:flex;gap:14px;align-items:center}#mission .p2-system:before{content:'';width:5px;height:5px;background:var(--p2-red)}#mission .p2-system b{border:1px solid #fff5;padding:5px 8px;font-weight:600}
#mission .p2-stage{position:absolute;inset:0;animation:p2-enter .7s both}#mission .p2-intro-content{position:absolute;left:9%;top:21%;width:500px}#mission .p2-eyebrow{display:flex;align-items:center;gap:12px;font-size:10px;letter-spacing:.2em;margin:0 0 23px;color:#c5cdd2}#mission .p2-eyebrow b{background:var(--p2-red);padding:5px 7px;color:#fff;font-weight:700}#mission h1{font-size:clamp(40px,3.7vw,60px);font-weight:700;line-height:1.13;letter-spacing:.015em;margin:0;text-shadow:0 2px 20px #0009}#mission .p2-subtitle{font-size:10px;letter-spacing:.26em;color:#b6c0c7;margin:20px 0 34px}#mission .p2-date-box{border-top:1px solid #fff6;border-bottom:1px solid #fff6;padding:17px 0 13px;position:relative;background:linear-gradient(90deg,#0009,#0001)}#mission .p2-date-box:before,#mission .p2-date-box:after{content:'';position:absolute;top:-4px;height:7px;width:1px;background:#b7c2c8}#mission .p2-date-box:before{left:0}#mission .p2-date-box:after{right:0}#mission .p2-date-label{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#c5ccd1;letter-spacing:.08em}#mission .p2-date-label small{font-size:9px;color:var(--p2-dim);letter-spacing:.14em}#mission .p2-arrival{font-size:39px;font-weight:600;letter-spacing:.04em;width:100%;border:0;background:none;padding:9px 0 5px}#mission input::-webkit-calendar-picker-indicator{cursor:pointer;opacity:.7}#mission .p2-arrival::-webkit-calendar-picker-indicator{width:19px}#mission .p2-time-row{display:flex;align-items:center;justify-content:space-between;min-height:28px}#mission .p2-link{border:0;background:none;padding:0;font-size:11px;letter-spacing:.04em;color:#b9c4cb}#mission .p2-link:hover{color:#fff}#mission .p2-link small{font-size:9px;color:var(--p2-dim);margin-left:8px;letter-spacing:.1em}#mission .p2-time-wrap{display:flex;gap:7px;align-items:center;font-size:10px;color:var(--p2-dim)}#mission .p2-time-wrap input{background:none;border:0;font-size:16px;width:96px}
#mission .p2-cta{width:100%;display:grid;gap:10px;justify-items:center;padding:18px 20px 15px;background:#000a;border:1px solid #e2200fbf;box-shadow:inset 3px 0 var(--p2-red),inset -3px 0 var(--p2-red);transition:background .2s}#mission .p2-cta:hover:enabled{background:var(--p2-red)}#mission .p2-cta b{font-size:21px;font-weight:700;letter-spacing:.12em}#mission .p2-cta span{font-size:10px;letter-spacing:.22em}#mission .p2-intro-content .p2-cta{margin-top:18px}#mission .p2-window{display:flex;align-items:center;gap:12px;font-size:11px;color:#a5b1b9;margin:15px 0 0;letter-spacing:.04em}#mission .p2-window i{background:var(--p2-red);width:3px;height:3px}#mission .p2-error{font-size:12px;line-height:1.5;color:#ff8373;margin:10px 0}#mission .p2-error:empty{display:none}
#mission .p2-terrain-tag{position:absolute;right:15%;bottom:24%;text-shadow:0 1px 6px black;display:grid;gap:6px;border-bottom:1px solid #fff6;padding:0 0 10px 20px}#mission .p2-terrain-tag:before{content:'+';position:absolute;left:0;top:-3px;font-size:20px}#mission .p2-terrain-tag b{font-size:12px;letter-spacing:.12em}#mission .p2-terrain-tag span{font-size:9px;color:#afbbc3;letter-spacing:.15em}
#mission .p2-heading{position:absolute;left:var(--p2-pad);top:118px}#mission .p2-back{background:transparent;border:0;padding:0;color:#bec8cf;font-size:11px;margin-bottom:23px}#mission .p2-heading .p2-eyebrow{margin-bottom:14px}#mission .p2-heading h1{font-size:36px}#mission .p2-heading .p2-subtitle{margin-top:12px;font-size:9px}
#mission .p2-launch-marker{position:absolute;z-index:5;text-align:left;background:#030708c9;border:1px solid #f2f4f56b;border-left:3px solid var(--p2-red);padding:11px 15px 10px 18px;transform:translate(-50%,92px);min-width:186px;backdrop-filter:blur(8px);box-shadow:0 6px 35px #0007}#mission .p2-launch-marker:before{content:'';position:absolute;width:9px;height:9px;background:var(--p2-red);border:1px solid white;left:var(--p2-anchor-x,50%);top:-99px;transform:translateX(-50%)}#mission .p2-launch-marker:after{content:'';position:absolute;left:var(--p2-anchor-x,50%);top:-90px;height:90px;border-left:1px solid #f2f4f570;pointer-events:none}#mission .p2-launch-marker b{font-size:13px;letter-spacing:.12em;display:block;margin-bottom:5px}#mission .p2-launch-marker span{font-size:10px;letter-spacing:.05em;color:#bbc7cf}#mission .p2-launch-marker:hover{background:#e2200fdd;border-color:#ff9b88}#mission .p2-launch-marker:hover span{color:white}
#mission .p2-orbit-bottom{position:absolute;left:var(--p2-pad);right:var(--p2-pad);bottom:112px;display:flex;align-items:end;justify-content:space-between;gap:24px;pointer-events:none}#mission .p2-orbit-note{font-size:12px;letter-spacing:.06em;max-width:300px;color:#d8e0e5;line-height:1.6}#mission .p2-plan{width:430px;border-top:1px solid var(--p2-line);border-bottom:1px solid var(--p2-line);display:flex;justify-content:space-between;padding:17px 0;gap:18px}#mission .p2-plan div{display:grid;gap:7px}#mission .p2-plan small{font-size:9px;letter-spacing:.12em;color:#afbbc3}#mission .p2-plan b{font-size:24px;letter-spacing:.02em;font-weight:600}#mission .p2-plan em{color:var(--p2-red);font-style:normal;font-size:25px;align-self:center}#mission .p2-scale-note{position:absolute;left:var(--p2-pad);bottom:80px;font-size:9px;letter-spacing:.04em;color:#8d9ba4}
#mission .p2-model-details{position:absolute;right:var(--p2-pad);bottom:80px;font-size:10px;color:#bec8cf;max-width:360px;z-index:7}#mission .p2-model-details summary{cursor:pointer;text-align:right}#mission .p2-model-details p{position:absolute;bottom:18px;right:0;width:min(360px,85vw);padding:16px;border:1px solid #ffffff40;background:#05090ff2;line-height:1.65}#mission .p2-pad-heading{top:102px}#mission .p2-pad-heading h1{font-size:29px}#mission .p2-pad-heading .p2-back{margin-bottom:17px}#mission .p2-panel{background:#020609ce;border:1px solid #f2f4f544;backdrop-filter:blur(12px);position:relative}#mission .p2-panel:before,#mission .p2-panel:after{content:'';position:absolute;width:8px;height:8px;border:0 solid #f2f4f5b0;pointer-events:none}#mission .p2-panel:before{left:-1px;top:-1px;border-width:2px 0 0 2px}#mission .p2-panel:after{right:-1px;bottom:-1px;border-width:0 2px 2px 0}#mission .p2-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--p2-line);padding:13px 17px;font-size:12px;letter-spacing:.1em}#mission .p2-panel-head small{font-size:8px;color:var(--p2-dim);letter-spacing:.15em}
#mission .p2-config{position:absolute;top:245px;left:var(--p2-pad);width:325px;max-height:calc(100% - 325px);overflow:auto;scrollbar-width:thin;scrollbar-color:#59646b #030609}#mission .p2-config form{padding:0 17px 17px}#mission .p2-config fieldset{margin:0;padding:18px 0;border:0;border-bottom:1px solid var(--p2-line);min-width:0}#mission .p2-config fieldset:last-of-type{border:0;padding-bottom:0}#mission .p2-config legend{float:left;width:100%;padding:0;display:flex;gap:8px;align-items:center;margin-bottom:13px;font-size:13px;color:#d3dbe0}#mission .p2-config legend b{font-size:12px;color:#f54b39}#mission .p2-config legend span{margin-left:auto;font-size:9px;color:#85949f;letter-spacing:.1em}#mission .p2-config label{font-size:12px;color:#c4cdd4}#mission .p2-input-row{display:flex;align-items:center;gap:12px;clear:both}#mission .p2-input-row input{min-width:0;width:100%;padding:8px 10px;background:#090e12;border:1px solid #ffffff37;font-size:20px;outline-offset:2px}#mission .p2-input-row span{font-size:11px;color:#9eacb6;min-width:28px}#mission .p2-field-note{font-size:10px;line-height:1.6;color:#8f9fa9;margin:9px 0 0;clear:both}#mission .p2-field-note b{font-weight:500;color:#c6d0d7}#mission .p2-shortcuts{display:flex;gap:6px;margin-top:10px}#mission .p2-shortcuts button{flex:1;border:1px solid #ffffff2b;background:#ffffff06;padding:7px;font-size:11px}#mission .p2-shortcuts button:hover{border-color:var(--p2-red)}#mission .p2-check{display:flex;align-items:center;gap:9px;margin:13px 0;clear:both;cursor:pointer}#mission .p2-check input{appearance:none;width:12px;height:12px;background:transparent;border:1px solid #8b9aa4;margin:0;cursor:pointer;display:grid;place-items:center}#mission .p2-check input:checked{background:var(--p2-red);border-color:var(--p2-red)}#mission .p2-check input:checked:after{content:'✓';font-size:10px;color:white}#mission .p2-check small{margin-left:auto;font-size:8px;letter-spacing:.06em;color:#84939e}#mission .p2-dark-label{display:flex;justify-content:space-between;margin:18px 0 8px}#mission .p2-dark-label small{font-size:9px;color:#85939d}
#mission .p2-rocket-label{position:absolute;left:60%;top:27%;border-bottom:1px solid #fff5;padding:0 0 9px 18px;display:grid;gap:7px;text-shadow:0 2px 7px #000}#mission .p2-rocket-label:before{content:'+';position:absolute;left:0;top:-2px}#mission .p2-rocket-label b{font-size:14px;letter-spacing:.2em}#mission .p2-rocket-label small{font-size:9px;color:#b0bec8;letter-spacing:.15em}
#mission .p2-launch-side{position:absolute;right:var(--p2-pad);bottom:110px;width:270px}#mission .p2-launch-side .p2-panel{margin-bottom:22px}#mission .p2-summary{margin:0;padding:16px 17px;display:grid;gap:17px}#mission .p2-summary div{display:grid;gap:5px}#mission .p2-summary dt{font-size:9px;color:var(--p2-dim);letter-spacing:.12em;text-transform:uppercase}#mission .p2-summary dd{margin:0;font-size:21px;line-height:1.2}#mission .p2-summary dd small{font-size:10px;color:#9daab4}#mission .p2-launch-side .p2-cta{background:#e2200f22;padding:20px}#mission .p2-launch-side .p2-cta:hover{background:var(--p2-red)}#mission .p2-launch-side .p2-cta b{font-size:28px;letter-spacing:.25em}#mission .p2-launch-disclaimer{font-size:10px;color:#8b9ba7;text-align:center;line-height:1.6;margin:11px 0 0}
#mission .p2-flight-heading{position:absolute;top:112px;left:var(--p2-pad)}#mission .p2-flight-heading h1{font-size:28px;max-width:330px}#mission .p2-flight-heading .p2-subtitle{display:none}#mission .p2-skip{position:absolute;right:var(--p2-pad);top:115px;background:#000a;border:1px solid #fff6;padding:10px 15px;letter-spacing:.08em;font-size:12px;z-index:7}#mission .p2-flight-clock{position:absolute;left:var(--p2-pad);bottom:120px;width:380px}#mission .p2-flight-clock>span{font-size:10px;letter-spacing:.15em;color:#9fadb7}#mission .p2-flight-clock time{display:block;font-size:32px;letter-spacing:.03em;margin:10px 0 12px}#mission .p2-flight-track{height:2px;background:#fff3}#mission .p2-flight-track i{display:block;height:100%;background:var(--p2-red);width:0}#mission .p2-flight-clock>small{display:flex;justify-content:space-between;margin-top:12px;font-size:10px;letter-spacing:.1em;color:#afbbc4}
#mission .p2-footer{position:absolute;bottom:28px;left:var(--p2-pad);right:var(--p2-pad);display:flex;align-items:center;justify-content:space-between;gap:20px;font-size:9px;color:#7e8d97;letter-spacing:.08em;z-index:6}#mission .p2-steps{display:flex;gap:15px;align-items:center}#mission .p2-steps>span{white-space:nowrap;display:flex;gap:7px;align-items:center}#mission .p2-steps .active{color:#eff5f7}#mission .p2-steps .active b{color:#f44b38}#mission .p2-steps b{font-weight:600}#mission .p2-steps>i{width:18px;height:1px;background:#fff3}#mission .p2-footer-credit{font-size:8px;letter-spacing:.16em}
#mission .p2-boot{position:absolute;inset:0;z-index:20;background:#000;display:grid;place-items:center;transition:opacity .65s,visibility 0s linear .65s}#mission .p2-boot.out{opacity:0;visibility:hidden}#mission .p2-boot-box{width:min(660px,86vw);font-size:13px;line-height:1.75;color:#b8c4cc}#mission .p2-boot-head{display:flex;align-items:center;gap:12px;margin:0 0 24px;font-size:12px;letter-spacing:.15em;color:#f1f4f6}#mission .p2-boot-head b{background:var(--p2-red);padding:3px 8px}#mission .p2-boot-head span{margin-left:auto;font-size:10px;color:#81919c}#mission .p2-boot-log{list-style:none;margin:0;padding:0;min-height:245px}#mission .p2-boot-log li{display:flex;gap:13px;align-items:baseline;margin:4px 0;animation:p2-log .3s both}#mission .p2-boot-log time{color:#70838f;font-size:11px;min-width:45px}#mission .p2-boot-log .message{flex:1;color:#dbe1e5}#mission .p2-boot-log small{font-size:10px;color:#a2b0b9;letter-spacing:.1em}#mission .p2-boot-log li.error .message,#mission .p2-boot-log li.error small{color:#ff5a45}#mission .p2-boot-track{height:2px;background:#ffffff20;margin-top:20px}#mission .p2-boot-track i{display:block;height:100%;width:0;background:var(--p2-red);transition:width .25s}#mission .p2-boot-foot{display:flex;justify-content:space-between;color:#697d8b;font-size:9px;letter-spacing:.17em;margin-top:10px}
@keyframes p2-enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes p2-log{from{opacity:0;transform:translateX(-5px)}}
@media(max-width:1100px){#mission .p2-intro-content{left:6%;width:410px}#mission .p2-config{width:300px}#mission .p2-launch-side{width:245px}#mission .p2-footer-credit{display:none}#mission .p2-system>span{display:none}#mission .p2-rocket-label{left:56%}}
@media(max-height:800px) and (min-width:901px){#mission .p2-intro-content{top:18%;width:470px}#mission .p2-intro-content h1{font-size:49px}#mission .p2-config{top:225px;max-height:calc(100% - 300px)}#mission .p2-pad-heading h1{font-size:25px}#mission .p2-pad-heading{top:94px}#mission .p2-launch-side{bottom:85px}#mission .p2-summary{gap:13px}}
@media(max-width:900px){#mission .p2-intro-content{left:var(--p2-pad);width:390px}#mission .p2-system>span{display:none}#mission .p2-orbit-bottom{display:grid;grid-template-columns:1fr;gap:14px;bottom:105px}#mission .p2-orbit-note{max-width:none;margin:0;font-size:11px}#mission .p2-plan{width:min(430px,100%)}#mission [data-view=pad]{overflow-y:auto;padding:230px var(--p2-pad) 110px}#mission .p2-config{position:relative;left:auto;top:auto;width:310px;max-height:none;overflow:visible}#mission .p2-launch-side{position:relative;right:auto;bottom:auto;width:310px;margin-top:20px}#mission .p2-rocket-label{left:auto;right:var(--p2-pad);top:26%;max-width:35%}#mission[data-stage=pad] .p2-header:before{content:'';position:fixed;inset:0 0 auto;height:90px;background:linear-gradient(#000,#000 75%,transparent);z-index:-1}}
@media(max-width:580px){#mission{--p2-pad:23px}#mission .p2-header{top:25px;justify-content:space-between;gap:14px}#mission .p2-brand b{font-size:13px}#mission .p2-brand small{font-size:7px;letter-spacing:.13em}#mission .p2-header-line{display:none}#mission .p2-system{gap:7px;font-size:9px}#mission .p2-system:before{display:none}#mission .p2-system b{padding:4px 6px}#mission .p2-intro-content{top:21%;width:calc(100% - 46px)}#mission .p2-intro-content h1{font-size:clamp(33px,9.4vw,44px)}#mission .p2-eyebrow{font-size:9px;gap:9px}#mission .p2-subtitle{font-size:8px;letter-spacing:.18em;margin:17px 0 27px}#mission .p2-arrival{font-size:32px}#mission .p2-date-label small{font-size:8px}#mission .p2-cta b{font-size:19px}#mission .p2-cta span{font-size:9px}#mission .p2-window{font-size:10px}#mission .p2-terrain-tag{right:var(--p2-pad);bottom:115px;padding-left:15px}#mission .p2-terrain-tag b{font-size:9px}#mission .p2-terrain-tag span{font-size:7px}#mission .p2-heading{top:103px}#mission .p2-heading h1{font-size:29px;max-width:320px}#mission .p2-heading .p2-subtitle{font-size:8px}#mission .p2-orbit-bottom{bottom:110px}#mission .p2-orbit-note{font-size:10px}#mission .p2-plan{gap:10px;padding:13px 0}#mission .p2-plan b{font-size:21px}#mission .p2-plan small{font-size:8px}#mission .p2-plan em{font-size:20px}#mission .p2-scale-note{font-size:8px;max-width:calc(100% - 46px);line-height:1.5;bottom:73px}#mission .p2-launch-marker{min-width:160px;padding:10px 13px}#mission .p2-launch-marker b{font-size:11px}#mission .p2-launch-marker span{font-size:9px}#mission [data-view=pad]{padding-top:470px}#mission .p2-config,#mission .p2-launch-side{width:100%}#mission .p2-pad-heading{top:103px}#mission .p2-rocket-label{position:absolute;top:300px;right:var(--p2-pad);max-width:42%;border:none}#mission .p2-rocket-label b{font-size:12px}#mission .p2-rocket-label small{font-size:7px}#mission .p2-footer{bottom:24px;gap:8px;font-size:8px}#mission .p2-steps{gap:7px}#mission .p2-steps>i{width:7px}#mission .p2-steps>span{gap:4px}#mission .p2-flight-heading{top:155px}#mission .p2-flight-heading h1{font-size:24px;max-width:310px}#mission .p2-flight-clock{width:calc(100% - 46px);bottom:125px}#mission .p2-flight-clock time{font-size:26px}#mission .p2-skip{top:105px;font-size:11px;padding:8px 12px}#mission .p2-boot-head{font-size:10px;gap:8px}#mission .p2-boot-head span{font-size:8px}#mission .p2-boot-log{font-size:11px;min-height:250px}#mission .p2-boot-log li{gap:7px;margin:9px 0}#mission .p2-boot-log time{font-size:9px;min-width:34px}#mission .p2-boot-log small{font-size:8px}#mission .p2-boot-foot{font-size:7px}}
@media(max-width:900px){#mission[data-stage=pad] .p2-footer{left:0;right:0;bottom:0;padding:18px var(--p2-pad);background:#030609ed;border-top:1px solid #ffffff18}}
#mission .p2-film{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;pointer-events:none}#mission[data-stage=flight]{background:#000}#mission[data-stage=flight] .p2-grid{opacity:.10}#mission[data-stage=flight] .p2-shade{background:linear-gradient(0deg,#0009,transparent 35%,transparent 70%,#0008)}#mission .p2-footage-credit{position:absolute;right:var(--p2-pad);bottom:82px;max-width:360px;padding:8px 12px;background:#0009;color:#ccd6df;font-size:10px;letter-spacing:.08em;line-height:1.7;text-align:right}#mission .p2-footage-credit a{color:#fff;text-decoration:none;border-bottom:1px solid #fff6}#mission .p2-film-error{position:absolute;left:var(--p2-pad);bottom:235px;max-width:420px;padding:14px;background:#000d;border:1px solid #e2200f;font-size:14px}#mission .p2-film-error button{display:block;margin-top:10px;border:1px solid #fff8;padding:8px 14px;background:#111}
@media(max-width:580px){#mission .p2-footage-credit{bottom:73px;font-size:8px;padding:5px 8px}#mission .p2-flight-clock{bottom:150px}#mission .p2-flight-clock time{font-size:24px}}

#mission .p2-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media(max-height:700px){
  #mission [data-view=intro]{inset:82px 0 62px;overflow-y:auto;padding:18px var(--p2-pad) 28px;scrollbar-width:thin}
  #mission .p2-intro-content{position:relative;inset:auto;width:100%;max-width:470px}
  #mission .p2-intro-content h1{font-size:clamp(29px,5vw,40px)}
  #mission .p2-intro-content .p2-eyebrow{margin-bottom:17px}
  #mission .p2-intro-content .p2-subtitle{margin:16px 0 23px}
  #mission .p2-terrain-tag{display:none}
}
@media(max-width:580px) and (max-height:700px){
  #mission .p2-heading{top:88px}
  #mission .p2-heading h1{font-size:26px}
  #mission .p2-heading .p2-back{margin-bottom:14px}
  #mission .p2-heading .p2-subtitle{margin-top:10px}
  #mission .p2-orbit-note{display:none}
  #mission .p2-orbit-bottom{bottom:100px}
  #mission .p2-launch-marker{top:auto!important;left:auto!important;right:var(--p2-pad);bottom:188px;transform:none}
  #mission .p2-launch-marker:before,#mission .p2-launch-marker:after{display:none}
  #mission .p2-model-details{bottom:51px}
  #mission .p2-scale-note{bottom:66px}
  #mission .p2-flight-heading{top:132px}
  #mission .p2-flight-heading h1{font-size:21px}
  #mission .p2-flight-heading .p2-eyebrow{margin-bottom:12px}
  #mission .p2-skip{top:86px}
  #mission .p2-flight-clock{bottom:115px}
  #mission .p2-footage-credit{bottom:64px}
}
@media(max-height:520px) and (min-width:581px){
  #mission .p2-header{top:18px}
  #mission .p2-heading{top:83px}
  #mission .p2-heading h1{font-size:25px}
  #mission .p2-heading .p2-back{margin-bottom:12px}
  #mission .p2-heading .p2-eyebrow{margin-bottom:10px}
  #mission .p2-heading .p2-subtitle,#mission .p2-orbit-note{display:none}
  #mission .p2-orbit-bottom{bottom:68px;right:auto;width:330px}
  #mission .p2-plan{width:100%;padding:10px 0}
  #mission .p2-plan b{font-size:21px}
  #mission .p2-launch-marker{top:auto!important;left:auto!important;right:var(--p2-pad);bottom:78px;transform:none}
  #mission .p2-launch-marker:before,#mission .p2-launch-marker:after{display:none}
  #mission .p2-scale-note,#mission .p2-model-details{bottom:40px;font-size:8px}
  #mission .p2-scale-note{max-width:62%}
  #mission .p2-footer{bottom:16px}
  #mission [data-view=pad]{overflow-y:auto;padding:210px var(--p2-pad) 78px}
  #mission .p2-config,#mission .p2-launch-side{position:relative;inset:auto;width:310px;max-height:none;overflow:visible}
  #mission .p2-launch-side{margin-top:20px}
  #mission .p2-flight-heading{top:84px}
  #mission .p2-flight-heading .p2-eyebrow{margin-bottom:10px}
  #mission .p2-flight-heading h1{font-size:22px}
  #mission .p2-skip{top:83px;padding:8px 12px}
  #mission .p2-flight-clock{bottom:65px;width:310px}
  #mission .p2-flight-clock time{font-size:22px;margin:6px 0 8px}
  #mission .p2-flight-clock>small{margin-top:8px;font-size:8px}
  #mission .p2-footage-credit{bottom:61px;font-size:8px;max-width:250px}
  #mission .p2-film-error{bottom:143px;max-width:calc(100% - 2 * var(--p2-pad))}
  #mission .p2-boot{overflow-y:auto;place-items:start center;padding:20px 0}
}
@media(max-width:340px){
  #mission{--p2-pad:18px}
  #mission .p2-steps{gap:4px;font-size:7px}
  #mission .p2-steps>span{gap:3px}
  #mission .p2-steps>i{width:4px}
}
@media(prefers-reduced-motion:reduce){#mission *,#mission *:before,#mission *:after{animation:none!important;transition:none!important}}
`;

const markup = `
<video class="p2-film" data-ui="film" aria-label="NASA Artemis II launch footage" muted playsinline preload="none" hidden></video>
<canvas class="p2-canvas" data-ui="transit" aria-label="Independent Earth–Moon transit visualization" hidden></canvas>
<div class="p2-shade" aria-hidden="true"></div><div class="p2-grid" aria-hidden="true"></div><div class="p2-frame" aria-hidden="true"></div>
<header class="p2-header"><button class="p2-brand" data-ui="restart" aria-label="Restart mission planning"><b>LUNAR LANDING</b><small>SITE NAVIGATOR · DEPARTURE</small></button><div class="p2-header-line"></div><div class="p2-system"><span>PRE-FLIGHT SYSTEMS</span><b>LLN–02</b></div></header>
<section id="mission-date" class="p2-stage" data-view="intro"><div class="p2-intro-content"><p class="p2-eyebrow"><b>PROLOGUE</b><span>THE JOURNEY BEGINS</span></p><h1 tabindex="-1">When do you want<br>to reach the Moon?</h1><p class="p2-subtitle">EVERY MISSION STARTS WITH A MOMENT.</p><form data-ui="arrival-form" novalidate><div class="p2-date-box"><label class="p2-date-label" for="p2-arrival-date">Arrival date <small>UTC · MISSION TIME</small></label><input class="p2-arrival" id="p2-arrival-date" data-ui="arrival-date" type="date" required><div class="p2-time-row"><button class="p2-link" data-ui="toggle-time" type="button" aria-expanded="false" aria-controls="p2-arrival-time-wrap">＋ Add a time <small>OPTIONAL</small></button><div class="p2-time-wrap" id="p2-arrival-time-wrap" data-ui="time-wrap" hidden><input data-ui="arrival-time" type="time" value="12:00" aria-label="Arrival time in UTC"><span>UTC</span></div></div></div><p class="p2-error" data-ui="arrival-error" role="alert"></p><button class="p2-cta" data-ui="plan" type="submit" disabled><b>Plan my journey</b><span>PREVIEW EARTH–MOON TRANSFER ↗</span></button></form><p class="p2-window"><span data-ui="window-label"></span><i></i><span>All times in UTC</span></p></div><div class="p2-terrain-tag" aria-hidden="true"><b>SHACKLETON · SOUTH POLE</b><span>LRO / LOLA · MEASURED TERRAIN</span></div></section>
<section id="mission-space" class="p2-stage" data-view="orbit" hidden><div class="p2-heading"><button class="p2-back" data-ui="edit-date">← Edit arrival date</button><p class="p2-eyebrow"><b>02</b><span>EARTH–MOON SYSTEM</span></p><h1 tabindex="-1">A journey starts<br>with a departure.</h1><p class="p2-subtitle">ARRIVAL GEOMETRY · JPL DE421</p></div><button class="p2-launch-marker" data-ui="launch-marker" hidden><b>EARTH / LAUNCH SITE 01</b><span>Configure your mission ↗</span></button><div class="p2-orbit-bottom"><p class="p2-orbit-note">Select the marked launch site on Earth<br>to prepare your mission.</p><div class="p2-plan"><div><small>PLANNED DEPARTURE</small><b data-ui="orbit-launch"></b></div><em>→</em><div><small>PLANNED ARRIVAL</small><b data-ui="orbit-arrival"></b></div></div></div><p class="p2-scale-note" data-ui="transfer-note">Two-body transfer estimate · 200 km parking orbit · DE421 arrival target · Bodies enlarged</p><details class="p2-model-details"><summary>Model assumptions</summary><p>The transfer is computed under Earth gravity from an assumed 200 km parking orbit to the DE421 lunar position. It excludes lunar and solar gravity, powered ascent, vehicle limits and lunar capture. The launch sequence uses edited NASA Artemis II archive footage, not a simulation of your selected mission date. NASA Earth Observatory textures are historical composites; cloud placement is illustrative, not a weather forecast.</p></details></section>
<section id="mission-site" class="p2-stage" data-view="pad" hidden><div class="p2-heading p2-pad-heading"><button class="p2-back" data-ui="back-orbit">← Back to the Earth–Moon view</button><p class="p2-eyebrow"><b>03</b><span>LAUNCH COMPLEX 01</span></p><h1 tabindex="-1">Prepare for departure.</h1><p class="p2-subtitle">LUNAR HEAVY LIFT · FLIGHT READINESS</p></div><div class="p2-config p2-panel"><div class="p2-panel-head"><span>Mission configuration</span><small>PRE-FLIGHT</small></div><form data-ui="config-form" novalidate><fieldset><legend><b>01</b> Stay on the Moon <span>DURATION</span></legend><div class="p2-input-row"><input data-ui="stay-days" type="number" min="0" step="any" value="7" aria-label="Planned stay in days"><span>days</span></div><div class="p2-shortcuts" role="group" aria-label="Stay duration presets"><button type="button" data-stay="24">24 hours</button><button type="button" data-stay="72">3 days</button><button type="button" data-stay="168">7 days</button></div><p class="p2-field-note">Mission ends <b data-ui="mission-end">—</b></p></fieldset><fieldset><legend><b>02</b> Mission requirements <span>OPTIONAL</span></legend><label class="p2-check"><input data-ui="crater-floor" type="checkbox"><span>Reach a crater floor</span><small>TERRAIN</small></label><label class="p2-check"><input data-ui="ice-nearby" type="checkbox"><span>Water ice nearby</span><small>RESOURCES</small></label><label class="p2-check"><input data-ui="continuous-comm" type="checkbox"><span>Continuous Earth link</span><small>COMMS</small></label><label class="p2-dark-label" for="p2-max-dark">Longest acceptable night <small>MAXIMUM</small></label><div class="p2-input-row"><input id="p2-max-dark" data-ui="max-dark" type="number" min="0" step="any" value="72"><span>hours</span></div><p class="p2-field-note">These requirements are passed to lunar site selection after arrival.</p></fieldset><p class="p2-error" data-ui="config-error" role="alert"></p></form></div><div class="p2-rocket-label" aria-hidden="true"><b>LUNAR HEAVY LIFT</b><small>CORE + TWIN SOLID BOOSTERS</small></div><div class="p2-launch-side"><section class="p2-panel"><div class="p2-panel-head"><span>Flight plan</span><small>UTC</small></div><dl class="p2-summary"><div><dt>Earth departure</dt><dd data-ui="summary-launch"></dd></div><div><dt>Lunar arrival</dt><dd data-ui="summary-arrive"></dd></div><div><dt>Surface mission</dt><dd data-ui="summary-stay"></dd></div><div><dt>Transfer duration</dt><dd data-ui="summary-transfer"></dd></div></dl></section><button class="p2-cta" data-ui="launch" disabled><b>LAUNCH</b><span>BEGIN LUNAR TRANSFER ↑</span></button><p class="p2-launch-disclaimer">9.5-second NASA launch film · Skip at any time</p></div></section>
<section id="mission-launch" class="p2-stage" data-view="flight" hidden><div class="p2-flight-heading"><p class="p2-eyebrow"><b>NASA FOOTAGE</b><span data-ui="flight-phase">ARTEMIS II · LAUNCH</span></p><h1 tabindex="-1">Earth departure.</h1><p class="p2-subtitle">YOUR MISSION IS UNDERWAY.</p></div><button class="p2-skip" data-ui="skip">Skip to arrival ⏭</button><div class="p2-flight-clock"><span>YOUR PLANNED DEPARTURE · UTC</span><time data-ui="flight-date"></time><div class="p2-flight-track" data-ui="flight-progress" role="progressbar" aria-label="Launch footage progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-ui="flight-bar"></i></div><small><span>LAUNCH FOOTAGE</span><span>LUNAR SITE SELECTION</span></small></div><div class="p2-film-error" data-ui="film-error" role="alert" hidden><span data-ui="film-error-text"></span><button data-ui="film-retry">Play launch footage</button></div><p class="p2-footage-credit"><a href="https://svs.gsfc.nasa.gov/31385" target="_blank" rel="noopener noreferrer">NASA · Artemis II launch ↗</a><br>Historical footage · Edited sequence</p></section>
<p class="p2-sr-only" data-ui="flight-status" role="status" aria-live="polite" aria-atomic="true"></p>
<footer class="p2-footer"><div class="p2-steps"><span data-step="intro" class="active"><b>01</b> Arrival date</span><i></i><span data-step="orbit"><b>02</b> Earth–Moon</span><i></i><span data-step="pad"><b>03</b> Launch</span><i></i><span data-step="flight"><b>04</b> Transit</span></div><span class="p2-footer-credit">NASA SPACE APPS / LUNAR LANDING SITE MISSION</span></footer>
<section class="p2-boot" data-ui="boot" aria-label="System startup"><div class="p2-boot-box"><p class="p2-boot-head"><b>LLN</b> LUNAR MISSION SYSTEMS <span>P2 / DEPARTURE</span></p><ol class="p2-boot-log" data-ui="boot-log" aria-live="polite"></ol><div class="p2-boot-track"><i data-ui="boot-bar"></i></div><p class="p2-boot-foot"><span>INITIALIZING MISSION CONTROL</span><span data-ui="boot-percent">00%</span></p><p class="p2-error" data-ui="boot-error" role="alert"></p></div></section>
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
  let transit, film, filmPreloaded = false, preciseTime = false, disposed = false, completed = false, stage = 'boot', currentConfig = null;
  let arriveH = Math.min(Math.max(84, dateToHours(new Date(), eph)), Math.max(0, bounds.maxH - 168));
  const started = performance.now();
  const isoDay = h => eph.hoursToDate(h).toISOString().slice(0, 10);
  const shortDate = h => isoDay(h).replaceAll('-', '.');
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
  function setStage(next) {
    if (disposed) return;
    stage = next;
    root.dataset.stage = next;
    root.querySelectorAll('[data-view]').forEach(section => { section.hidden = section.dataset.view !== next; });
    root.querySelectorAll('[data-step]').forEach(step => step.classList.toggle('active', step.dataset.step === next));
    ui('transit').hidden = next !== 'orbit' && next !== 'pad';
    ui('film').hidden = next !== 'flight';
    if (next === 'pad' && !filmPreloaded) {
      filmPreloaded = true; ui('film').preload = 'auto'; ui('film').load();
    }
    if (next === 'orbit' || next === 'pad') transit?.show(next, arriveH);
    root.dispatchEvent(new CustomEvent('missionstagechange', { bubbles: true, detail: { stage: next } }));
    requestAnimationFrame(() => root.querySelector(`[data-view="${next}"] h1`)?.focus({ preventScroll: true }));
  }
  function syncArrivalTimeBounds() {
    const day = ui('arrival-date').value;
    ui('arrival-time').min = day === isoDay(0) ? fullDate(0).slice(11) : '00:00';
    ui('arrival-time').max = day === isoDay(bounds.maxH) ? fullDate(bounds.maxH).slice(11) : '23:59';
  }
  function readArrival() {
    const day = ui('arrival-date').value;
    const time = preciseTime && ui('arrival-time').value ? ui('arrival-time').value : '00:00';
    const h = dateToHours(new Date(`${day}T${time}:00Z`), eph);
    if (!Number.isFinite(h) || h < bounds.minH || h >= bounds.maxH) {
      throw new RangeError(`Choose an arrival between ${bounds.minDate} and ${bounds.maxDate}, before the final sample at ${fullDate(bounds.maxH)} UTC.`);
    }
    return h;
  }
  function updateConfig() {
    try {
      if (!ui('stay-days').value || !ui('max-dark').value) throw new RangeError('Enter the stay duration and maximum darkness.');
      currentConfig = buildMissionConfig(eph, {
        arriveH, stayH: Number(ui('stay-days').value) * 24,
        needs: { craterFloor: ui('crater-floor').checked, iceNearby: ui('ice-nearby').checked,
          continuousComm: ui('continuous-comm').checked, maxDarkH: Number(ui('max-dark').value) }
      });
      ui('config-error').textContent = '';
      ui('mission-end').textContent = `${fullDate(arriveH + currentConfig.stayH)} UTC`;
      ui('summary-launch').innerHTML = `${shortDate(currentConfig.launchH)} <small>${fullDate(currentConfig.launchH).slice(11)} UTC</small>`;
      ui('summary-arrive').innerHTML = `${shortDate(arriveH)} <small>${fullDate(arriveH).slice(11)} UTC</small>`;
      ui('summary-stay').innerHTML = `${Number((currentConfig.stayH / 24).toFixed(3))} <small>days</small>`;
      ui('summary-transfer').innerHTML = `${Number((arriveH - currentConfig.launchH).toFixed(2))} <small>hours · planned</small>`;
      ui('launch').disabled = !transit;
    } catch (error) {
      currentConfig = null;
      ui('config-error').textContent = error.message;
      ui('launch').disabled = true;
      ui('mission-end').textContent = 'Outside the mission window';
    }
  }
  function finishMission(config) {
    if (completed || disposed) return;
    completed = true;
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
    if (stage === 'flight') return;
    completed = false;
    if (!existing) root.hidden = false;
    setStage('intro');
  }
  function hideMission() {
    if (disposed) return;
    completed = true;
    film?.cancel();
    setStage('handoff');
    ui('transit').hidden = true;
    if (!existing) root.hidden = true;
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
    if (!transit) return;
    try {
      arriveH = readArrival();
      ui('arrival-error').textContent = '';
      ui('orbit-arrival').textContent = shortDate(arriveH);
      ui('orbit-launch').textContent = shortDate(Math.max(0, arriveH - 84));
      ui('stay-days').max = String((bounds.maxH - arriveH) / 24);
      // Keep a valid initial stay even on the dataset's final date.
      if (Number(ui('stay-days').value) * 24 > bounds.maxH - arriveH) ui('stay-days').value = String((bounds.maxH - arriveH) / 24);
      updateConfig();
      setStage('orbit');
    } catch (error) { ui('arrival-error').textContent = error.message; }
  });
  listen(ui('arrival-date'), 'input', () => { syncArrivalTimeBounds(); ui('arrival-error').textContent = ''; });
  listen(ui('arrival-time'), 'input', () => { ui('arrival-error').textContent = ''; });
  listen(ui('edit-date'), 'click', () => setStage('intro'));
  listen(ui('launch-marker'), 'click', () => setStage('pad'));
  listen(ui('back-orbit'), 'click', () => setStage('orbit'));
  listen(ui('restart'), 'click', restart);
  listen(ui('config-form'), 'submit', event => event.preventDefault());
  listen(ui('config-form'), 'input', updateConfig);
  root.querySelectorAll('[data-stay]').forEach(button => listen(button, 'click', () => { ui('stay-days').value = String(Number(button.dataset.stay) / 24); updateConfig(); }));
  const launchVideo = ui('film');
  launchVideo.src = new URL('./scene/assets/artemis-launch.mp4', import.meta.url).href;
  launchVideo.muted = true;
  launchVideo.playsInline = true;
  film = createLaunchFilm({
    video: launchVideo,
    onProgress({ progress, currentTime }) {
      const percent = Math.round(progress * 100);
      const phase = currentTime < 4 ? 'LIFTOFF' : currentTime < 7 ? 'POWERED ASCENT' : 'ABOVE EARTH';
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
  listen(ui('launch'), 'click', () => {
    updateConfig();
    if (!currentConfig || !transit || completed || stage !== 'pad') return;
    const config = currentConfig;
    setStage('flight');
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
    if (event.key !== 'Escape' || /INPUT|SELECT/.test(event.target.tagName)) return;
    if (stage === 'flight') film?.skip();
    else if (stage === 'pad') setStage('orbit');
    else if (stage === 'orbit') setStage('intro');
  });

  bootLog(`Ephemeris ${bounds.label} / ${countLabel(eph.count)} samples / ${eph.stepH} h step`);
  bootLog('Validate UTC mission clock and sample bounds');
  bootLog(`Receive ${data?.sites?.sites?.length ?? 0} candidate sites from host`);
  progress(18);
  const ready = (async () => {
    const { createTransit } = await import('./scene/transit.js');
    if (disposed) return;
    transit = await createTransit({
      canvas: ui('transit'), eph, data,
      onPerformance(stats) { transitPerformance = { transitFps: Number(stats.fps.toFixed(1)), drawCalls: stats.drawCalls, triangles: stats.triangles, pixelRatio: Number(stats.pixelRatio.toFixed(2)), targetFps: stats.targetFps }; },
      onTransfer(info) {
        ui('transfer-note').textContent = info.available
          ? 'Two-body transfer estimate · 200 km parking orbit · DE421 arrival target · Bodies enlarged'
          : `Transfer estimate unavailable: ${info.reason || 'choose a later arrival date'}. Arrival geometry still uses DE421.`;
      },
      onProgress({ loaded, total, label }) { bootLog(label); progress(Math.min(94, 18 + loaded / Math.max(1, total) * 76)); },
      onLaunchAnchor({ x, y, visible }) {
        if (disposed) return;
        const marker = ui('launch-marker');
        marker.hidden = !visible || stage !== 'orbit';
        const halfWidth = (marker.offsetWidth || 186) / 2;
        const centerX = Math.max(halfWidth + 12, Math.min(root.clientWidth - halfWidth - 12, x));
        marker.style.left = `${centerX}px`;
        marker.style.top = `${y}px`;
        marker.style.setProperty('--p2-anchor-x', `${x - centerX + halfWidth}px`);
      }
    });
    if (disposed) { transit.dispose(); return; }
    bootLog('Compile transit shaders and verify first frame');
    progress(97);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, (existing ? 0 : 2300) - (performance.now() - started))));
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
