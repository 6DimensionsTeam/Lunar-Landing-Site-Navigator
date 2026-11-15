// One URL per screen. The address bar follows whichever screen is showing; on load, the mission
// flow and site selection read the starting path and rebuild that screen from the saved session.
// Back/forward reload the page, which then restores the screen for that address.

const MISSION_PATHS = { intro: '/arrival', orbit: '/earth-moon', pad: '/mission-setup', flight: '/launch' };
const START = (globalThis.location?.pathname ?? '/').replace(/\/+$/, '') || '/';
let enabled = false;

export const startPath = () => START;

// Which mission stage a starting path asks for: 'orbit' / 'pad', 'done' for any screen after the
// launch, or null to begin at the arrival date.
export function resumeStage() {
  if (START === '/earth-moon') return 'orbit';
  if (START === '/mission-setup' || START === '/launch') return 'pad';
  if (['/where-and-when', '/site-survey', '/surface', '/rover', '/advisory-board', '/compare', '/robustness', '/relay-station'].includes(START)) return 'done';
  return null;
}

function visible(id) {
  const el = document.getElementById(id);
  return !!el && !el.hidden && !el.classList.contains('out');
}

function currentPath() {
  if (visible('board')) return '/advisory-board';
  if (visible('mission')) {
    const stage = document.getElementById('mission').dataset.stage;
    if (stage === 'handoff') return null;
    return MISSION_PATHS[stage] || '/arrival';
  }
  if (visible('select')) return document.getElementById('select').classList.contains('ac-calendar-open') ? '/where-and-when' : '/site-survey';
  if (visible('rover')) return '/rover';
  if (visible('explore')) return '/surface';
  if (visible('orbit')) return '/relay-station';
  if (visible('compare')) return '/compare';
  if (visible('worlds')) return '/robustness';
  return null;
}

let queued = false;
function sync() {
  queued = false;
  if (!enabled) return;
  const path = currentPath();
  if (path && path !== location.pathname) history.pushState({ path }, '', path + location.search);
}
const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(sync); } };

// Called once the starting screen has been restored (or there was nothing to restore).
export function routeReady() {
  if (enabled) return;
  enabled = true;
  schedule();
}

export function installRouter() {
  const hud = document.getElementById('hud');
  if (!hud) return;
  const observer = new MutationObserver(schedule);
  for (const el of hud.children) {
    if (el.tagName === 'SECTION') observer.observe(el, { attributes: true, attributeFilter: ['hidden', 'class', 'data-stage'] });
  }
  window.addEventListener('popstate', () => location.reload());
  if (!resumeStage()) routeReady();
  // Never leave the address frozen if a restore cannot complete.
  setTimeout(routeReady, 45000);
}
