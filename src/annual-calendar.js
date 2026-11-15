import { buildAnnualPlan } from './annual-planner.js';
import './annual-calendar.css';

let instanceCount = 0;
const finite = (value, suffix = '', digits = 1) => Number.isFinite(value)
  ? `${value.toFixed(digits)}${suffix}` : 'Unknown';
const siteName = site => site.en || site.name || site.id;
const statusLabel = status => ({ feasible: 'Meets annual criteria', infeasible: 'Fails annual criteria', unknown: 'Unknown' })[status];

/** An inspection-only comparison. No selection, mission date, or host clock is changed. */
export function createAnnualCalendar({ root, data, zones, eph, getMission = () => null, getYear = () => null }) {
  if (!root) throw new TypeError('The annual calendar requires its selection screen.');
  const doc = root.ownerDocument;
  const prefix = `ac-${++instanceCount}`;
  const listeners = [];
  const hostInert = new Map();
  let opened = false, destroyed = false, preferCalendar = true, plan = null, planningYear = null, selected = null;
  let buttons = [], returnFocus = null, wasConcealed = root.hidden || root.classList.contains('out');

  function node(tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  function button(className, text) {
    const el = node('button', className, text);
    el.type = 'button';
    return el;
  }
  function listen(el, type, handler, options) {
    el.addEventListener(type, handler, options);
    listeners.push(() => el.removeEventListener(type, handler, options));
  }
  const shell = node('div', 'ac-shell');
  const nav = node('nav', 'ac-switch');
  nav.setAttribute('aria-label', 'Site survey view');
  const mapButton = button('ac-view-button', 'Map');
  const calendarButton = button('ac-view-button', 'Annual calendar');
  mapButton.dataset.acView = 'map';
  calendarButton.dataset.acView = 'calendar';
  mapButton.setAttribute('aria-pressed', 'true');
  calendarButton.setAttribute('aria-pressed', 'false');
  nav.append(mapButton, calendarButton);
  const panel = node('section', 'ac-panel');
  panel.hidden = true;
  panel.id = `${prefix}-panel`;
  panel.setAttribute('aria-labelledby', `${prefix}-title`);
  calendarButton.setAttribute('aria-controls', panel.id);
  const header = node('header', 'ac-header');
  const titleBlock = node('div', 'ac-title-block');
  titleBlock.append(node('p', 'ac-kicker', 'LLN / ANNUAL PLANNING'));
  const title = node('h2', 'ac-title', 'Compare the years');
  title.id = `${prefix}-title`;
  titleBlock.append(title, node('p', 'ac-subtitle', 'Annual catalog comparison · not launch windows'));
  const yearLabel = node('label', 'ac-year-label', 'Planning from');
  const yearSelect = node('select', 'ac-year');
  yearSelect.id = `${prefix}-year`;
  yearLabel.htmlFor = yearSelect.id;
  yearLabel.append(yearSelect);
  header.append(titleBlock, yearLabel);
  const overview = node('div', 'ac-overview');
  const workspace = node('div', 'ac-workspace');
  const matrixPanel = node('section', 'ac-matrix-panel');
  const matrixHeader = node('div', 'ac-matrix-header');
  const matrixTitle = node('h3', 'ac-section-title', 'Site × year');
  const instructions = node('p', 'ac-instructions', 'Scroll for all years and sites. Select a cell to inspect; use arrow keys to move. Scores are out of 100.');
  instructions.id = `${prefix}-instructions`;
  const legend = node('p', 'ac-legend');
  for (const [state, label] of [['feasible', '+ Meets criteria'], ['infeasible', '× Fails criteria'], ['unknown', '? Unknown']]) {
    const item = node('span', `ac-key ac-${state}`, label);
    legend.append(item);
  }
  matrixHeader.append(matrixTitle, legend, instructions);
  const scroll = node('div', 'ac-table-scroll');
  scroll.setAttribute('aria-label', 'Annual site comparison');
  scroll.setAttribute('aria-describedby', instructions.id);
  const detail = node('section', 'ac-detail panel');
  detail.id = `${prefix}-detail`;
  detail.tabIndex = -1;
  detail.setAttribute('aria-label', 'Selected annual result');
  const live = node('p', 'ac-sr');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  matrixPanel.append(matrixHeader, scroll);
  workspace.append(matrixPanel, detail);
  const footer = node('details', 'ac-method');
  footer.append(node('summary', '', 'How to read this comparison'));
  footer.append(node('p', '', 'These are annual catalog estimates, not predictions for your selected stay or a launch date. Published regions use calendar-year statistics; data-selected sites use approximate 8,766-hour annual slices and cyclic dark-run estimates.'));
  footer.append(node('p', '', 'The existing ranking uses proxies: Earth visibility of at least 80% does not guarantee uninterrupted communication; non-rough terrain does not confirm a crater floor; permanent shadow within 25 km does not confirm water ice. A passing cell only meets these annual screening rules.'));
  footer.append(node('p', '', 'A zero or absent darkness limit disables that filter; an optional requirement passes without imposing a constraint.'));
  footer.append(node('p', '', 'The planning year, cell inspection and recommendations here do not change your mission date or the site selected on the map. Unknown data are never counted as a pass.'));
  panel.append(header, overview, workspace, footer, live);
  shell.append(nav, panel);
  root.append(shell);

  const concealed = () => root.hidden || root.classList.contains('out');
  function initialYear() {
    const mission = getMission();
    const arrival = Number.isFinite(mission?.arriveH) ? eph.hoursToDate(mission.arriveH).getUTCFullYear() : null;
    const range = data.sites.stats_years;
    const year = arrival ?? getYear();
    return Math.max(range[0], Math.min(range[1], Number.isInteger(year) ? year : range[0]));
  }
  function setHostInert(value) {
    if (value) {
      for (const child of root.children) {
        if (child === shell || hostInert.has(child)) continue;
        hostInert.set(child, child.inert);
        child.inert = true;
      }
    } else {
      for (const [child, inert] of hostInert) child.inert = inert;
      hostInert.clear();
    }
  }
  function show() {
    if (destroyed || concealed()) return false;
    preferCalendar = true;
    if (opened) return true;
    returnFocus = doc.activeElement;
    planningYear = initialYear();
    refresh();
    opened = true;
    setHostInert(true);
    root.classList.add('ac-calendar-open');
    panel.hidden = false;
    mapButton.setAttribute('aria-pressed', 'false');
    calendarButton.setAttribute('aria-pressed', 'true');
    yearSelect.focus({ preventScroll: true });
    return true;
  }
  function hide({ restoreFocus = true, remember = true } = {}) {
    if (!opened) return;
    if (remember) preferCalendar = false;
    opened = false;
    panel.hidden = true;
    root.classList.remove('ac-calendar-open');
    setHostInert(false);
    mapButton.setAttribute('aria-pressed', 'true');
    calendarButton.setAttribute('aria-pressed', 'false');
    if (restoreFocus && !concealed()) {
      const target = returnFocus?.isConnected && root.contains(returnFocus) && !panel.contains(returnFocus) && !returnFocus.inert
        ? returnFocus : calendarButton;
      target.focus({ preventScroll: true });
    }
    returnFocus = null;
  }
  function pick(cell, { focus = false, revealDetail = false } = {}) {
    const rowIndex = plan.rows.findIndex(row => row.site === cell.site);
    const colIndex = plan.years.indexOf(cell.year);
    if (rowIndex < 0 || colIndex < 0) return;
    if (selected) {
      const previous = buttons[selected.row]?.[selected.col];
      if (previous) {
        previous.tabIndex = -1;
        previous.setAttribute('aria-pressed', 'false');
        previous.removeAttribute('aria-describedby');
      }
    }
    selected = { row: rowIndex, col: colIndex };
    const active = buttons[rowIndex][colIndex];
    active.tabIndex = 0;
    active.setAttribute('aria-pressed', 'true');
    active.setAttribute('aria-describedby', detail.id);
    renderDetail(cell);
    live.textContent = `${siteName(cell.site)}, ${cell.year}. ${statusLabel(cell.status)}.`;
    if (revealDetail && doc.defaultView?.matchMedia?.('(max-width: 720px)')?.matches) {
      detail.focus({ preventScroll: true });
      detail.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
    } else if (focus) {
      active.focus({ preventScroll: true });
      active.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  }
  function inspectButton(text, cell) {
    const el = button('ac-inspect cta2', text);
    el.addEventListener('click', () => pick(cell, { focus: true, revealDetail: true }));
    return el;
  }
  function renderOverview() {
    overview.replaceChildren();
    const recommendation = node('section', 'ac-recommendation');
    recommendation.append(node('p', 'ac-kicker', `RECOMMENDED FROM ${planningYear}`));
    const best = plan.recommendation;
    if (best) {
      const heading = node('h3', 'ac-recommend-name', siteName(best.site));
      heading.append(node('b', 'ac-recommend-year', best.year));
      recommendation.append(heading, node('p', 'ac-copy', `Highest-scoring eligible site–year · ${finite(best.score * 100, '/100')} · annual criteria only`));
      recommendation.append(inspectButton('Inspect recommendation', best));
      if (plan.earliestFeasible && plan.earliestFeasible.year < best.year) {
        recommendation.append(inspectButton(`Earliest fit: ${plan.earliestFeasible.year} · ${siteName(plan.earliestFeasible.site)}`, plan.earliestFeasible));
      } else if (plan.earliestFeasible?.year > planningYear) {
        recommendation.append(node('p', 'ac-copy', `Earliest annual fit: ${plan.earliestFeasible.year}. No site meets the criteria in ${planningYear}.`));
      }
    } else {
      recommendation.append(node('h3', 'ac-recommend-name', 'No confirmed annual fit'));
      recommendation.append(node('p', 'ac-copy', plan.unknownYears.some(year => year >= planningYear)
        ? 'Available evidence cannot confirm an annual fit; some annual data are unknown.'
        : 'No site meets every current screening rule from this planning year onward.'));
    }
    const summary = node('section', 'ac-summary');
    summary.append(node('h3', 'ac-section-title', `Catalog / ${plan.years[0]}–${plan.years.at(-1)}`));
    const metrics = node('div', 'ac-summary-metrics');
    for (const [value, label] of [[plan.noFitYears.length, 'years with no fit'], [plan.robustSites.length, `sites fit all ${plan.years.length} years`], [plan.unknownYears.length, 'years with unknowns']]) {
      const metric = node('p', 'ac-summary-metric');
      metric.append(node('b', '', value), node('span', '', label));
      metrics.append(metric);
    }
    summary.append(metrics);
    const yearSummary = plan.yearSummaries.find(item => item.year === planningYear);
    summary.append(node('p', 'ac-copy', `${planningYear}: ${yearSummary.feasibleCount} meet · ${yearSummary.infeasibleCount} fail · ${yearSummary.unknownCount} unknown`));
    const robust = node('p', 'ac-robust', plan.robustSites.length
      ? `All-year sites: ${plan.robustSites.map(row => row.site.id).join(', ')}. Annual screening stability is not a continuous operating window.`
      : 'No site meets the current annual screening rules in every catalog year.');
    summary.append(robust);
    const needs = getMission()?.needs || {};
    const rules = [Number.isFinite(needs.maxDarkH) && needs.maxDarkH > 0 ? `dark ≤ ${needs.maxDarkH} h` : 'no dark limit'];
    if (needs.continuousComm) rules.push('Earth link ≥ 80%');
    if (needs.craterFloor) rules.push('crater-floor proxy');
    if (needs.iceNearby) rules.push('near-shadow proxy');
    summary.append(node('p', 'ac-requirements', `Mission rules · ${rules.join(' · ')}`));
    overview.append(recommendation, summary);
  }
  function renderTable() {
    const table = node('table', 'ac-table');
    table.append(node('caption', 'ac-sr', 'Annual site criteria and ranking scores. Each row includes its best passing year across the full catalog.'));
    const head = node('thead');
    const heading = node('tr');
    const corner = node('th', 'ac-site-head', 'Candidate / catalog best');
    corner.scope = 'col';
    heading.append(corner);
    for (const year of plan.years) {
      const th = node('th', year === planningYear ? 'ac-planning-year' : '', year);
      th.scope = 'col';
      heading.append(th);
    }
    const counts = node('tr', 'ac-counts');
    const countsLabel = node('th', 'ac-site-head', 'Sites meeting criteria');
    countsLabel.scope = 'row';
    counts.append(countsLabel);
    for (const summary of plan.yearSummaries) {
      const count = node('td', summary.noFit ? 'ac-no-fit' : '', `${summary.feasibleCount}/${plan.rows.length}`);
      if (summary.unknownCount) count.append(node('span', 'ac-count-unknown', `?${summary.unknownCount}`));
      count.title = `${summary.year}: ${summary.feasibleCount} meet, ${summary.infeasibleCount} fail, ${summary.unknownCount} unknown`;
      counts.append(count);
    }
    head.append(heading, counts);
    const body = node('tbody');
    buttons = [];
    for (const [rowIndex, row] of plan.rows.entries()) {
      const tr = node('tr');
      const label = node('th', 'ac-site-head');
      label.scope = 'row';
      label.append(node('span', 'ac-site-name', `${row.site.id} / ${siteName(row.site)}`));
      const best = row.bestYear == null ? 'No eligible year' : `Catalog best ${row.bestYear}${row.bestYears.length > 1 ? ` +${row.bestYears.length - 1} tied` : ''}`;
      label.append(node('small', 'ac-row-best', `${best} · ${row.feasibleYears.length}/${plan.years.length} fit`));
      tr.append(label);
      const rowButtons = [];
      for (const [colIndex, cell] of row.cells.entries()) {
        const td = node('td');
        const cellButton = button(`ac-cell ac-${cell.status}`);
        cellButton.dataset.acRow = String(rowIndex);
        cellButton.dataset.acCol = String(colIndex);
        cellButton.tabIndex = -1;
        cellButton.setAttribute('aria-pressed', 'false');
        const score = finite(cell.score == null ? null : cell.score * 100, '', 0);
        cellButton.setAttribute('aria-label', `${siteName(cell.site)}, ${cell.year}: ${statusLabel(cell.status)}.${cell.status === 'unknown' ? '' : ` Score ${finite(cell.score * 100, '', 1)} out of 100.`}`);
        cellButton.title = cellButton.getAttribute('aria-label');
        const symbol = node('span', 'ac-cell-symbol', cell.status === 'feasible' ? '+' : cell.status === 'infeasible' ? '×' : '?');
        symbol.setAttribute('aria-hidden', 'true');
        cellButton.append(symbol, node('span', 'ac-cell-score', cell.status === 'unknown' ? '—' : score));
        td.append(cellButton);
        tr.append(td);
        rowButtons.push(cellButton);
      }
      buttons.push(rowButtons);
      body.append(tr);
    }
    table.append(head, body);
    scroll.replaceChildren(table);
  }
  function renderDetail(cell) {
    detail.replaceChildren();
    const back = button('ac-back-to-calendar cta2', 'Back to calendar');
    back.addEventListener('click', () => pick(cell, { focus: true }));
    detail.append(back);
    detail.append(node('p', 'ac-kicker', `INSPECT / ${cell.year} / ${cell.site.id}`));
    detail.append(node('h3', 'ac-detail-title', siteName(cell.site)));
    detail.append(node('p', `ac-verdict ac-${cell.status}`, statusLabel(cell.status)));
    detail.append(node('p', 'ac-source', cell.site.source === 'nasa' ? 'Published Artemis region' : 'Data-selected candidate'));
    if (cell.status === 'unknown') {
      detail.append(node('p', 'ac-copy', cell.unknownReason), node('p', 'ac-copy', 'No annual score or recommendation is inferred from missing evidence.'));
      return;
    }
    const stats = node('dl', 'ac-stats rows');
    for (const [label, value] of [
      ['Ranking score', finite(cell.score * 100, ' / 100')],
      ['Mean solar visibility', finite(cell.stats.sun_mean_pct, '%')],
      ['Sun visible', finite(cell.stats.sun_visible_pct, '%')],
      ['Earth visible', finite(cell.stats.earth_visible_pct, '%')],
      ['Sun + Earth', finite(cell.stats.both_pct, '%')],
      ['Longest dark', finite(cell.stats.longest_dark_h, ' h', 0)],
      ['Longest link outage', finite(cell.stats.longest_blind_h, ' h', 0)],
      ['Ground slope', finite(cell.ground?.slopeDeg, '°')],
      ['Nearest permanent shadow', finite(cell.ground?.iceDistKm, ' km')],
    ]) {
      const row = node('div');
      row.append(node('dt', '', label), node('dd', '', value));
      stats.append(row);
    }
    detail.append(stats, node('h4', 'ac-section-title', 'Screening verdicts'));
    const verdicts = node('ul', 'ac-verdict-list');
    for (const verdict of cell.verdicts) {
      const li = node('li', verdict.pass ? 'ac-pass-text' : 'ac-fail-text');
      li.append(node('b', '', verdict.pass ? 'PASS' : 'FAIL'), node('span', '', `${verdict.label}: ${verdict.value}`));
      verdicts.append(li);
    }
    detail.append(verdicts);
    if (cell.fails.length) {
      detail.append(node('h4', 'ac-section-title', 'Why it fails'));
      const fails = node('ul', 'ac-fail-list');
      for (const reason of cell.fails) fails.append(node('li', '', reason));
      detail.append(fails);
    }
    if (cell.notes.length) detail.append(node('p', 'ac-detail-note', cell.notes.join(' · ')));
    detail.append(node('p', 'ac-detail-note', 'Pass/fail follows the existing annual ranking proxies; it does not establish continuous communication, a crater floor, confirmed ice or a usable mission-day window.'));
  }
  function refresh() {
    if (destroyed) return;
    const previous = selected && plan ? { id: plan.rows[selected.row].site.id, year: plan.years[selected.col] } : null;
    planningYear ??= initialYear();
    plan = buildAnnualPlan({ data, zones, needs: getMission()?.needs || {}, fromYear: planningYear });
    yearSelect.replaceChildren(...plan.years.map(year => {
      const option = node('option', '', year);
      option.value = String(year);
      return option;
    }));
    yearSelect.value = String(planningYear);
    selected = null;
    renderOverview();
    renderTable();
    const preserved = previous && plan.rows.find(row => row.site.id === previous.id)?.cells.find(cell => cell.year === previous.year);
    const initial = preserved || plan.recommendation || plan.yearSummaries.find(summary => summary.year === planningYear)?.cells[0];
    if (initial) pick(initial);
    else detail.replaceChildren(node('p', 'ac-copy', 'No candidate sites are available.'));
  }
  listen(calendarButton, 'click', show);
  listen(mapButton, 'click', () => hide());
  listen(yearSelect, 'change', () => {
    planningYear = Number(yearSelect.value);
    refresh();
    live.textContent = `Planning from ${planningYear}. ${plan.recommendation ? `${siteName(plan.recommendation.site)}, ${plan.recommendation.year}, is recommended.` : 'No confirmed annual fit.'}`;
  });
  listen(scroll, 'click', event => {
    const target = event.target.closest('button[data-ac-row]');
    if (target && scroll.contains(target)) pick(plan.rows[Number(target.dataset.acRow)].cells[Number(target.dataset.acCol)], { revealDetail: true });
  });
  listen(scroll, 'keydown', event => {
    const target = event.target.closest('button[data-ac-row]');
    if (!target || !scroll.contains(target)) return;
    let row = Number(target.dataset.acRow), col = Number(target.dataset.acCol);
    if (event.key === 'ArrowDown') row++;
    else if (event.key === 'ArrowUp') row--;
    else if (event.key === 'ArrowRight') col++;
    else if (event.key === 'ArrowLeft') col--;
    else if (event.key === 'Home') { col = 0; if (event.ctrlKey) row = 0; }
    else if (event.key === 'End') { col = plan.years.length - 1; if (event.ctrlKey) row = plan.rows.length - 1; }
    else return;
    event.preventDefault();
    event.stopPropagation();
    row = Math.max(0, Math.min(plan.rows.length - 1, row));
    col = Math.max(0, Math.min(plan.years.length - 1, col));
    pick(plan.rows[row].cells[col], { focus: true });
  });
  listen(root, 'keydown', event => {
    if (opened && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      hide();
    }
  }, true);
  // Calendar shortcuts must not also rotate the host globe or leave the selection screen.
  listen(panel, 'keydown', event => event.stopPropagation());
  listen(shell, 'pointerdown', event => event.stopPropagation());
  listen(shell, 'wheel', event => { if (opened) event.stopPropagation(); }, { passive: true });
  const observer = new MutationObserver(() => {
    const hidden = concealed();
    if (hidden) hide({ restoreFocus: false, remember: false });
    if (wasConcealed && !hidden) {
      planningYear = null;
      selected = null;
      plan = null;
      if (preferCalendar) show();
    }
    wasConcealed = hidden;
  });
  observer.observe(root, { attributes: true, attributeFilter: ['hidden', 'class'] });
  function destroy() {
    if (destroyed) return;
    hide({ restoreFocus: false, remember: false });
    destroyed = true;
    observer.disconnect();
    listeners.forEach(remove => remove());
    shell.remove();
  }
  if (!concealed()) show();
  return { show, hide, refresh, destroy };
}
