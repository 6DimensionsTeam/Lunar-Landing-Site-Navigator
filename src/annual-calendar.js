import { buildAnnualPlan } from './annual-planner.js';
import { createAnnualMap } from './annual-map.js';
import './annual-calendar.css';

let instanceCount = 0;
const finite = (value, suffix = '', digits = 1) => Number.isFinite(value)
  ? `${value.toFixed(digits)}${suffix}` : 'Unknown';
const siteName = site => site.en || site.name || site.id;
const statusLabel = status => ({ feasible: 'Meets annual criteria', infeasible: 'Fails annual criteria', unknown: 'Unknown annual evidence' })[status];

/** Local inspection only. Recommendations never commit a site or change the host mission clock. */
export function createAnnualCalendar({ root, data, zones, eph, getMission = () => null, getYear = () => null }) {
  if (!root) throw new TypeError('The annual planner requires its selection screen.');
  const doc = root.ownerDocument;
  const prefix = `ac-${++instanceCount}`;
  const listeners = [];
  const hostInert = new Map();
  let opened = false, destroyed = false, preferCalendar = true, plan = null, planningYear = null, selected = null;
  let buttons = [], timelineTicks = [], returnFocus = null;
  let wasConcealed = root.hidden || root.classList.contains('out');

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
  const mapButton = button('ac-view-button', '3D survey');
  const calendarButton = button('ac-view-button', 'Plan a visit');
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
  const title = node('h2', 'ac-title', 'Where and when?');
  title.id = `${prefix}-title`;
  titleBlock.append(node('p', 'ac-kicker', 'LLN / VISIT PLANNER'), title,
    node('p', 'ac-subtitle', 'Annual estimates · not launch windows'));
  const yearLabel = node('label', 'ac-year-label', 'Planning from');
  const yearSelect = node('select', 'ac-year');
  yearSelect.id = `${prefix}-year`;
  yearLabel.htmlFor = yearSelect.id;
  yearLabel.append(yearSelect);
  header.append(titleBlock, yearLabel);

  const overview = node('div', 'ac-overview');
  const workspace = node('div', 'ac-workspace');
  const mapRoot = node('div', 'ac-map-root');
  const detail = node('section', 'ac-detail');
  detail.id = `${prefix}-detail`;
  detail.tabIndex = -1;
  detail.setAttribute('aria-label', 'Inspected annual result');
  const siteLabel = node('label', 'ac-site-label', 'Explore a site');
  const siteSelect = node('select', 'ac-site-select');
  siteSelect.id = `${prefix}-site`;
  siteLabel.htmlFor = siteSelect.id;
  siteLabel.append(siteSelect);
  const detailHeading = node('div', 'ac-detail-heading');
  const detailYear = node('h3', 'ac-detail-year');
  const verdict = node('p', 'ac-verdict');
  detailHeading.append(detailYear, verdict);
  const mainStats = node('dl', 'ac-main-stats');
  const mainValues = [];
  for (const label of ['Sun visible', 'Earth visible', 'Longest dark']) {
    const item = node('div');
    const value = node('dd');
    item.append(node('dt', '', label), value);
    mainValues.push(value);
    mainStats.append(item);
  }
  const detailNote = node('p', 'ac-selection-note');
  const evidence = node('details', 'ac-evidence');
  evidence.append(node('summary', '', 'Why this result'));
  const evidenceBody = node('div', 'ac-evidence-body');
  evidence.append(evidenceBody);
  detail.append(siteLabel, detailHeading, mainStats, detailNote, evidence);
  workspace.append(mapRoot, detail);

  const timelineSection = node('section', 'ac-timeline-section');
  const timelineHeading = node('div', 'ac-timeline-heading');
  const timelineTitle = node('h3', 'ac-timeline-title');
  timelineTitle.id = `${prefix}-timeline-title`;
  const bestBadge = node('p', 'ac-best-year');
  timelineHeading.append(timelineTitle, bestBadge);
  const timeline = node('div', 'ac-timeline');
  timeline.setAttribute('role', 'group');
  timeline.setAttribute('aria-labelledby', timelineTitle.id);
  const timelineSelection = node('p', 'ac-timeline-selection');
  timelineSelection.setAttribute('aria-hidden', 'true');
  const timelineTrack = node('div', 'ac-timeline-track');
  const timelineBand = node('div', 'ac-year-band');
  timelineBand.setAttribute('aria-hidden', 'true');
  const timelinePointer = node('span', 'ac-year-pointer');
  timelinePointer.setAttribute('aria-hidden', 'true');
  const yearSlider = node('input', 'ac-year-slider');
  yearSlider.type = 'range';
  yearSlider.step = '1';
  yearSlider.id = `${prefix}-year-slider`;
  yearSlider.setAttribute('aria-labelledby', timelineTitle.id);
  const timelineLegend = node('p', 'ac-timeline-legend');
  timelineLegend.id = `${prefix}-timeline-legend`;
  timelineLegend.append(node('span', 'ac-criteria-label', 'Annual criteria'));
  for (const [state, label] of [['feasible', 'Meets'], ['infeasible', 'Fails'], ['unknown', 'Unknown']]) {
    timelineLegend.append(node('span', `ac-timeline-key ac-${state}`, label));
  }
  yearSlider.setAttribute('aria-describedby', timelineLegend.id);
  timelineTrack.append(timelineBand, timelinePointer, yearSlider);
  timeline.append(timelineSelection, timelineTrack, timelineLegend);
  timelineSection.append(timelineHeading, timeline);

  const comparison = node('details', 'ac-comparison');
  const comparisonLabel = node('summary');
  const comparisonBody = node('div', 'ac-comparison-body');
  const summary = node('section', 'ac-summary');
  const instructions = node('p', 'ac-instructions', 'Select a cell to inspect it on the map. Arrow keys move between cells. Scores are out of 100.');
  instructions.id = `${prefix}-instructions`;
  const legend = node('p', 'ac-legend');
  for (const [state, label] of [['feasible', '+ Meets criteria'], ['infeasible', '× Fails criteria'], ['unknown', '? Unknown']]) {
    legend.append(node('span', `ac-key ac-${state}`, label));
  }
  const scroll = node('div', 'ac-table-scroll');
  scroll.setAttribute('aria-label', 'Annual site comparison');
  scroll.setAttribute('aria-describedby', instructions.id);
  comparisonBody.append(summary, legend, instructions, scroll);
  comparison.append(comparisonLabel, comparisonBody);
  const method = node('details', 'ac-method');
  method.append(node('summary', '', 'About these estimates'));
  method.append(node('p', '', 'The catalog summarizes each calendar year. These estimates screen annual conditions; they do not predict an exact launch date or conditions during a selected stay.'));
  method.append(node('p', '', 'The existing ranking uses proxies: Earth visibility of at least 80% does not guarantee uninterrupted communication; non-rough terrain does not confirm a crater floor; permanent shadow within 25 km does not confirm water ice.'));
  method.append(node('p', '', 'A zero or absent darkness limit disables that filter. Unselected optional requirements impose no constraint. Unknown annual data are never counted as a pass. Catalog-best years consider the full period; the recommendation considers only the planning year onward.'));
  method.append(node('p', '', 'Exploring this map and timeline does not change your mission date or the site selected in the 3D survey.'));
  const live = node('p', 'ac-sr');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  panel.append(header, overview, timelineSection, workspace, comparison, method, live);
  shell.append(nav, panel);
  root.append(shell);
  const annualMap = createAnnualMap({ root: mapRoot, data, onSelect: id => {
    const row = plan?.rows.find(item => item.site.id === id);
    if (row && selected) pick(row.cells[selected.col]);
  } });

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
  function closeDisclosures() {
    for (const disclosure of panel.querySelectorAll('details')) disclosure.open = false;
  }
  function show() {
    if (destroyed || concealed()) return false;
    preferCalendar = true;
    if (opened) return true;
    returnFocus = doc.activeElement;
    planningYear = initialYear();
    selected = null;
    closeDisclosures();
    refresh();
    opened = true;
    setHostInert(true);
    root.classList.add('ac-calendar-open');
    panel.hidden = false;
    panel.scrollTop = 0;
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
    closeDisclosures();
    mapButton.setAttribute('aria-pressed', 'true');
    calendarButton.setAttribute('aria-pressed', 'false');
    if (restoreFocus && !concealed()) {
      const target = returnFocus?.isConnected && root.contains(returnFocus) && !panel.contains(returnFocus) && !returnFocus.inert
        ? returnFocus : calendarButton;
      target.focus({ preventScroll: true });
    }
    returnFocus = null;
  }
  function selectedCell() {
    return selected && plan?.rows[selected.row]?.cells[selected.col];
  }
  function pick(cell, { focus = null } = {}) {
    const rowIndex = plan.rows.findIndex(row => row.site.id === cell.site.id);
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
    const active = buttons[rowIndex]?.[colIndex];
    if (active) {
      active.tabIndex = 0;
      active.setAttribute('aria-pressed', 'true');
      active.setAttribute('aria-describedby', detail.id);
    }
    siteSelect.value = cell.site.id;
    renderDetail(cell);
    updateTimeline(plan.rows[rowIndex]);
    annualMap.update({ cells: plan.yearSummaries[colIndex].cells, selectedId: cell.site.id, recommendedId: plan.recommendation?.site.id });
    live.textContent = `${siteName(cell.site)}, ${cell.year}. ${statusLabel(cell.status)}.`;
    const target = focus === 'table' ? active : null;
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  }
  function renderOverview() {
    const recommendation = node('section', 'ac-recommendation');
    const copy = node('div', 'ac-recommend-copy');
    copy.append(node('p', 'ac-kicker', `RECOMMENDED FROM ${planningYear}`));
    const best = plan.recommendation;
    if (best) {
      const heading = node('h3', 'ac-recommend-name', siteName(best.site));
      heading.append(node('b', 'ac-recommend-year', best.year));
      copy.append(heading);
      const earliest = plan.earliestFeasible;
      let sentence = 'Highest-ranked annual match from your planning year.';
      if (earliest && earliest.year > planningYear) {
        sentence = `Earliest annual match: ${earliest.year} at ${siteName(earliest.site)}.`;
      } else if (earliest && earliest.year < best.year) {
        sentence = `An earlier annual match: ${earliest.year} at ${siteName(earliest.site)}.`;
      }
      copy.append(node('p', 'ac-copy', sentence));
      const inspect = button('ac-inspect', 'Show result');
      inspect.dataset.acAction = 'recommendation';
      recommendation.append(copy, inspect);
    } else {
      copy.append(node('h3', 'ac-recommend-name', 'No confirmed annual fit'));
      copy.append(node('p', 'ac-copy', plan.unknownYears.some(year => year >= planningYear)
        ? 'The available annual evidence cannot confirm a fit; some data are unknown.'
        : 'No site meets every current annual criterion from this planning year onward.'));
      recommendation.append(copy);
    }
    overview.replaceChildren(recommendation);
  }
  function renderSummary() {
    summary.replaceChildren(node('h3', 'ac-section-title', `Catalog / ${plan.years[0]}–${plan.years.at(-1)}`));
    const metrics = node('div', 'ac-summary-metrics');
    for (const [value, label] of [[plan.noFitYears.length, 'years with no fit'], [plan.robustSites.length, `sites fit all ${plan.years.length} years`], [plan.unknownYears.length, 'years with unknowns']]) {
      const metric = node('p', 'ac-summary-metric');
      metric.append(node('b', '', value), node('span', '', label));
      metrics.append(metric);
    }
    summary.append(metrics);
    const annual = plan.yearSummaries.find(item => item.year === planningYear);
    summary.append(node('p', 'ac-copy', `${planningYear}: ${annual.feasibleCount} meet · ${annual.infeasibleCount} fail · ${annual.unknownCount} unknown`));
    summary.append(node('p', 'ac-no-fit-years', plan.noFitYears.length
      ? `Years with no annual fit: ${plan.noFitYears.join(', ')}.` : 'Every catalog year has at least one annual fit or unknown evidence.'));
    summary.append(node('p', 'ac-robust', plan.robustSites.length
      ? `Sites meeting criteria in every catalog year: ${plan.robustSites.map(row => siteName(row.site)).join(', ')}.`
      : 'No site meets the annual criteria in every catalog year.'));
    if (plan.unknownYears.length) summary.append(node('p', 'ac-copy', `Unknown annual evidence: ${plan.unknownYears.join(', ')}. Unknown cells are not counted as a pass or a confirmed failure.`));
    const needs = getMission()?.needs || {};
    const rules = [Number.isFinite(needs.maxDarkH) && needs.maxDarkH > 0 ? `dark ≤ ${needs.maxDarkH} h` : 'no dark limit'];
    if (needs.continuousComm) rules.push('Earth visibility ≥ 80%');
    if (needs.craterFloor) rules.push('crater-floor proxy');
    if (needs.iceNearby) rules.push('near-shadow proxy');
    summary.append(node('p', 'ac-requirements', `Mission rules · ${rules.join(' · ')}`));
    comparisonLabel.textContent = `Compare all ${plan.rows.length} sites`;
  }
  function renderTimeline() {
    yearSlider.min = String(plan.years[0]);
    yearSlider.max = String(plan.years.at(-1));
    yearSlider.disabled = plan.rows.length === 0;
    timelineTrack.style.setProperty('--ac-year-count', String(plan.years.length));
    timelineTicks = plan.years.map((year, index) => {
      const item = node('span', 'ac-year-tick');
      item.dataset.acYear = String(year);
      item.setAttribute('aria-hidden', 'true');
      item.dataset.major = String(index === 0 || index === plan.years.length - 1 || year % 5 === 0);
      item.append(node('span', 'ac-year-number', year));
      return item;
    });
    timelineBand.replaceChildren(...timelineTicks);
  }
  function updateTimeline(row) {
    const cell = row.cells[selected.col];
    timelineTitle.textContent = `Timeline · ${siteName(row.site)}`;
    bestBadge.textContent = row.bestYear == null ? 'No confirmed annual fit' : `Catalog best ${row.bestYears.join(' · ')}`;
    yearSlider.value = String(cell.year);
    yearSlider.setAttribute('aria-valuetext', `${cell.year}: ${statusLabel(cell.status)}, ${siteName(row.site)}`);
    timelineSelection.textContent = `${cell.year} · ${statusLabel(cell.status)}`;
    timelinePointer.dataset.year = String(cell.year);
    // The pointer and native thumb share the centres of the equal annual segments.
    timelinePointer.style.left = `${(selected.col + .5) / plan.years.length * 100}%`;
    for (const [index, annual] of row.cells.entries()) {
      const item = timelineTicks[index];
      item.className = `ac-year-tick ac-${annual.status}`;
      if (index === selected.col) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
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
    detailYear.textContent = cell.year;
    verdict.className = `ac-verdict ac-${cell.status}`;
    verdict.textContent = statusLabel(cell.status);
    mainValues[0].textContent = finite(cell.stats?.sun_visible_pct, '%');
    mainValues[1].textContent = finite(cell.stats?.earth_visible_pct, '%');
    mainValues[2].textContent = finite(cell.stats?.longest_dark_h, ' h', 0);
    const row = plan.rows[selected.row];
    detailNote.textContent = cell.status === 'unknown' ? cell.unknownReason
      : cell.fails.length ? cell.fails[0]
        : row.bestYear === cell.year ? 'One of this site’s best annual matches in the catalog.'
          : row.bestYear != null ? `This site’s catalog-best annual match is ${row.bestYear}.` : '';
    evidenceBody.replaceChildren(node('p', 'ac-source', cell.site.source === 'nasa' ? 'Published Artemis region' : 'Data-selected candidate'));
    if (cell.status === 'unknown') {
      evidenceBody.append(node('p', 'ac-copy', 'No annual score or recommendation is inferred from missing evidence.'));
      return;
    }
    const stats = node('dl', 'ac-stats');
    for (const [label, value] of [
      ['Ranking score', finite(cell.score * 100, ' / 100')],
      ['Mean solar visibility', finite(cell.stats.sun_mean_pct, '%')],
      ['Sun + Earth', finite(cell.stats.both_pct, '%')],
      ['Longest link outage', finite(cell.stats.longest_blind_h, ' h', 0)],
      ['Ground slope', finite(cell.ground?.slopeDeg, '°')],
      ['Nearest permanent shadow', finite(cell.ground?.iceDistKm, ' km')],
    ]) {
      const item = node('div');
      item.append(node('dt', '', label), node('dd', '', value));
      stats.append(item);
    }
    evidenceBody.append(stats, node('h4', 'ac-section-title', 'Screening verdicts'));
    const verdicts = node('ul', 'ac-verdict-list');
    for (const result of cell.verdicts) {
      const item = node('li', result.pass ? 'ac-pass-text' : 'ac-fail-text');
      item.append(node('b', '', result.pass ? 'PASS' : 'FAIL'), node('span', '', `${result.label}: ${result.value}`));
      verdicts.append(item);
    }
    evidenceBody.append(verdicts);
    if (cell.fails.length) {
      evidenceBody.append(node('h4', 'ac-section-title', 'Why it fails'));
      const fails = node('ul', 'ac-fail-list');
      for (const reason of cell.fails) fails.append(node('li', '', reason));
      evidenceBody.append(fails);
    }
    if (cell.notes.length) evidenceBody.append(node('p', 'ac-detail-note', cell.notes.join(' · ')));
    evidenceBody.append(node('p', 'ac-detail-note', 'These annual screening proxies do not establish continuous communication, a crater floor, confirmed ice or conditions during your selected stay.'));
  }
  function refresh() {
    if (destroyed) return;
    const old = selectedCell();
    const previous = old && { id: old.site.id, year: old.year };
    planningYear ??= initialYear();
    plan = buildAnnualPlan({ data, zones, needs: getMission()?.needs || {}, fromYear: planningYear });
    yearSelect.replaceChildren(...plan.years.map(year => {
      const option = node('option', '', year);
      option.value = String(year);
      return option;
    }));
    yearSelect.value = String(planningYear);
    siteSelect.replaceChildren(...plan.rows.map(row => {
      const option = node('option', '', siteName(row.site));
      option.value = row.site.id;
      return option;
    }));
    selected = null;
    renderOverview();
    renderSummary();
    renderTable();
    renderTimeline();
    const preserved = previous && plan.rows.find(row => row.site.id === previous.id)?.cells.find(cell => cell.year === previous.year);
    const initial = preserved || plan.recommendation || plan.yearSummaries.find(item => item.year === planningYear)?.cells[0];
    if (initial) pick(initial);
    else {
      detailYear.textContent = '—';
      verdict.textContent = 'No candidate sites are available';
      timelineTitle.textContent = 'No annual site evidence';
      annualMap.update({ cells: [], selectedId: null, recommendedId: null });
    }
  }
  listen(calendarButton, 'click', show);
  listen(mapButton, 'click', () => hide());
  listen(yearSelect, 'change', () => {
    planningYear = Number(yearSelect.value);
    refresh();
    live.textContent = `Planning from ${planningYear}. ${plan.recommendation ? `${siteName(plan.recommendation.site)}, ${plan.recommendation.year}, is recommended.` : 'No confirmed annual fit.'}`;
  });
  listen(siteSelect, 'change', () => {
    const row = plan.rows.find(item => item.site.id === siteSelect.value);
    if (row && selected) pick(row.cells[selected.col]);
  });
  listen(overview, 'click', event => {
    if (event.target.closest('[data-ac-action="recommendation"]') && plan.recommendation) {
      pick(plan.recommendation);
      timelineSection.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  });
  listen(yearSlider, 'input', () => {
    if (!selected) return;
    const col = plan.years.indexOf(Number(yearSlider.value));
    if (col >= 0) pick(plan.rows[selected.row].cells[col]);
  });
  listen(scroll, 'click', event => {
    const target = event.target.closest('button[data-ac-row]');
    if (target && scroll.contains(target)) {
      pick(plan.rows[Number(target.dataset.acRow)].cells[Number(target.dataset.acCol)]);
      comparison.open = false;
      siteSelect.focus({ preventScroll: true });
      detail.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
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
    pick(plan.rows[row].cells[col], { focus: 'table' });
  });
  listen(root, 'keydown', event => {
    if (opened && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const disclosures = [...panel.querySelectorAll('details[open]')];
      if (disclosures.length) {
        const focused = disclosures.find(item => item.contains(doc.activeElement)) || disclosures.at(-1);
        closeDisclosures();
        focused.querySelector('summary')?.focus({ preventScroll: true });
      } else hide();
    }
  }, true);
  // Inspection shortcuts must not also rotate the survey or leave its host screen.
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
    annualMap.destroy();
    listeners.forEach(remove => remove());
    shell.remove();
  }
  if (!concealed()) show();
  return { show, hide, refresh, destroy };
}
