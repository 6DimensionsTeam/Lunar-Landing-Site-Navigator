import { latLonToMap } from './geo.js';
import './annual-map.css';

const percent = value => `${(value * 100).toFixed(6)}%`;
const nameOf = site => site.en || site.name || site.id;
const verdict = status => ({ feasible: 'meets annual criteria', infeasible: 'fails annual criteria', unknown: 'annual evidence unknown' })[status] || 'annual evidence unknown';

/** South-polar stereographic crop, in kilometres. Raster rows run from +Y to -Y. */
export function annualMapLayout({ sites, radiusKm, halfExtentKm, aspect = 6 / 5 }) {
  if (![radiusKm, halfExtentKm, aspect].every(value => Number.isFinite(value) && value > 0)) {
    throw new TypeError('The annual locator requires positive radius, image extent and aspect.');
  }
  const points = sites.map(site => {
    const valid = Number.isFinite(site.lat) && Number.isFinite(site.lon) && site.lat <= 0 && site.lat >= -90;
    const p = valid ? latLonToMap(radiusKm, site.lat, site.lon) : null;
    return { id: site.id, xKm: p?.x ?? null, yKm: p?.y ?? null,
      mapped: !!p && Math.abs(p.x) <= halfExtentKm && Math.abs(p.y) <= halfExtentKm };
  });
  const mapped = points.filter(point => point.mapped);
  // Include the pole as a fixed landmark and derive the view from the actual candidate set.
  const xMin = Math.min(0, ...mapped.map(point => point.xKm));
  const xMax = Math.max(0, ...mapped.map(point => point.xKm));
  const yMin = Math.min(0, ...mapped.map(point => point.yKm));
  const yMax = Math.max(0, ...mapped.map(point => point.yKm));
  const heightKm = Math.max(yMax - yMin, (xMax - xMin) / aspect, halfExtentKm * .08) * 1.38;
  const widthKm = heightKm * aspect;
  const leftKm = (xMin + xMax - widthKm) / 2;
  const topKm = (yMin + yMax + heightKm) / 2;
  const at = (x, y) => ({ x: (x - leftKm) / widthKm, y: (topKm - y) / heightKm });
  for (const point of points) {
    if (point.mapped) Object.assign(point, at(point.xKm, point.yKm));
  }
  return {
    widthKm, heightKm, leftKm, topKm, points, pole: at(0, 0),
    image: { x: (-halfExtentKm - leftKm) / widthKm, y: (topKm - halfExtentKm) / heightKm,
      width: 2 * halfExtentKm / widthKm, height: 2 * halfExtentKm / heightKm }
  };
}

/** Lightweight locator only: inspecting a marker never commits a P1 site or changes a date. */
export function createAnnualMap({ root, data, onSelect = () => {} }) {
  if (!root) throw new TypeError('The annual locator requires a root element.');
  const doc = root.ownerDocument;
  const halfExtentKm = data.moonPolarMeta.half_extent_m / 1000;
  const marks = new Map();
  let cells = [], selectedId = null, recommendedId = null, destroyed = false;
  let aspect = 6 / 5;
  const make = (tag, className, text) => {
    const el = doc.createElement(tag);
    el.className = className;
    if (text != null) el.textContent = text;
    return el;
  };
  const map = make('figure', 'am-map');
  const viewport = make('div', 'am-viewport');
  viewport.setAttribute('role', 'group');
  viewport.setAttribute('aria-label', 'South polar candidate locator');
  const image = make('img', 'am-image');
  image.src = data.moonPolarUrl;
  image.alt = '';
  image.draggable = false;
  const horizontal = make('div', 'am-axis am-axis-x');
  const vertical = make('div', 'am-axis am-axis-y');
  const pole = make('span', 'am-pole', '+');
  pole.title = 'Lunar south pole';
  pole.setAttribute('aria-hidden', 'true');
  const longitude = make('span', 'am-longitude', '0°E ↑');
  longitude.setAttribute('aria-hidden', 'true');
  const callout = make('span', 'am-callout');
  callout.hidden = true;
  callout.setAttribute('aria-hidden', 'true');
  const scale = make('span', 'am-scale');
  const scaleText = make('span', 'am-scale-label');
  scale.append(scaleText);
  const markerLayer = make('div', 'am-markers');
  viewport.append(image, horizontal, vertical, pole, longitude, scale, markerLayer, callout);
  const caption = make('figcaption', 'am-caption');
  const title = make('span', 'am-caption-title', 'South polar locator');
  const year = make('span', 'am-year');
  const credit = make('span', 'am-credit', 'LOLA relief · fixed shading');
  const coordinates = make('span', 'am-coordinates');
  const instructions = make('span', 'am-instructions', '○ Published · ◇ Data-selected. Tab / arrows move between points.');
  caption.append(title, year, credit, coordinates, instructions);
  map.append(viewport, caption);
  root.append(map);

  function position(el, point) {
    el.style.left = percent(point.x);
    el.style.top = percent(point.y);
  }
  function layout() {
    if (destroyed) return;
    const geo = annualMapLayout({ sites: cells.map(cell => cell.site), radiusKm: data.radiusKm, halfExtentKm, aspect });
    image.style.left = percent(geo.image.x);
    image.style.top = percent(geo.image.y);
    image.style.width = percent(geo.image.width);
    image.style.height = percent(geo.image.height);
    horizontal.style.top = percent(geo.pole.y);
    vertical.style.left = percent(geo.pole.x);
    position(pole, geo.pole);
    for (const point of geo.points) {
      const mark = marks.get(point.id);
      mark.hidden = !point.mapped;
      if (point.mapped) position(mark, point);
    }
    const selected = cells.find(cell => cell.site.id === selectedId);
    const point = geo.points.find(item => item.id === selectedId && item.mapped);
    callout.hidden = !point;
    if (point && selected) {
      callout.textContent = `${selected.site.id} / ${nameOf(selected.site)}`;
      position(callout, point);
      callout.classList.toggle('am-callout-left', point.x > .55);
      callout.classList.toggle('am-callout-below', point.y < .22);
    }
    const power = 10 ** Math.floor(Math.log10(geo.widthKm * .2));
    const scaleKm = [5, 2, 1].map(multiplier => multiplier * power).find(value => value <= geo.widthKm * .2) || power;
    scale.style.width = percent(scaleKm / geo.widthKm);
    scaleText.textContent = `${Number(scaleKm.toPrecision(3))} km`;
    scale.setAttribute('aria-label', `${scaleKm} kilometres in the stereographic map projection`);
  }
  function update(next) {
    if (destroyed) return;
    cells = next.cells || [];
    selectedId = next.selectedId ?? null;
    recommendedId = next.recommendedId ?? null;
    const ids = new Set(cells.map(cell => cell.site.id));
    for (const [id, mark] of marks) {
      if (!ids.has(id)) { mark.remove(); marks.delete(id); }
    }
    for (const cell of cells) {
      const site = cell.site;
      let mark = marks.get(site.id);
      if (!mark) {
        mark = make('button', 'am-marker');
        mark.type = 'button';
        mark.dataset.siteId = site.id;
        const dot = make('span', 'am-dot');
        dot.setAttribute('aria-hidden', 'true');
        mark.append(dot);
        marks.set(site.id, mark);
        markerLayer.append(mark);
      }
      const status = ['feasible', 'infeasible'].includes(cell.status) ? cell.status : 'unknown';
      mark.className = `am-marker am-${status} am-${site.source === 'data' ? 'data' : 'nasa'}`;
      mark.classList.toggle('am-recommended', site.id === recommendedId);
      mark.setAttribute('aria-pressed', String(site.id === selectedId));
      const label = `${nameOf(site)} (${site.id}), ${site.source === 'data' ? 'data-selected candidate' : 'published Artemis region'}, ${cell.year ?? 'year unknown'}: ${verdict(status)}${site.id === recommendedId ? '; recommended site' : ''}.`;
      mark.setAttribute('aria-label', label);
      mark.title = label;
    }
    const years = [...new Set(cells.map(cell => cell.year).filter(Number.isInteger))];
    year.textContent = years.length === 1 ? `${years[0]} ANNUAL CRITERIA` : 'ANNUAL CRITERIA';
    const selected = cells.find(cell => cell.site.id === selectedId)?.site;
    coordinates.textContent = selected && Number.isFinite(selected.lat) && Number.isFinite(selected.lon)
      ? `${selected.id} · ${Math.abs(selected.lat).toFixed(3)}°S · ${((selected.lon % 360 + 360) % 360).toFixed(3)}°E`
      : 'South polar stereographic';
    layout();
  }
  const onClick = event => {
    const target = event.target.closest('button[data-site-id]');
    if (!target || !markerLayer.contains(target)) return;
    let selected = target;
    // Nearby sites keep their measured positions and generous hit areas. Resolve a
    // physical click by the nearest anchor, rather than the overlapping button's z-order.
    if (event.detail > 0 && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      let nearest = Infinity;
      for (const mark of marks.values()) {
        if (mark.hidden) continue;
        const rect = mark.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) continue;
        const dx = event.clientX - (rect.left + rect.width / 2);
        const dy = event.clientY - (rect.top + rect.height / 2);
        const distance = dx * dx + dy * dy;
        if (distance < nearest) { nearest = distance; selected = mark; }
      }
    }
    onSelect(selected.dataset.siteId);
  };
  const onKey = event => {
    const target = event.target.closest('button[data-site-id]');
    if (!target || !markerLayer.contains(target)) return;
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
    if (!direction) return;
    const available = cells.map(cell => marks.get(cell.site.id)).filter(mark => !mark.hidden);
    const index = available.indexOf(target);
    available[(index + direction + available.length) % available.length]?.focus({ preventScroll: true });
    event.preventDefault();
    event.stopPropagation();
  };
  markerLayer.addEventListener('click', onClick);
  markerLayer.addEventListener('keydown', onKey);
  const Observer = doc.defaultView?.ResizeObserver;
  const observer = Observer ? new Observer(entries => {
    const rect = entries[0]?.contentRect;
    if (rect?.width > 0 && rect.height > 0) {
      const nextAspect = rect.width / rect.height;
      if (Math.abs(nextAspect - aspect) > .0001) { aspect = nextAspect; layout(); }
    }
  }) : null;
  observer?.observe(viewport);
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    observer?.disconnect();
    markerLayer.removeEventListener('click', onClick);
    markerLayer.removeEventListener('keydown', onKey);
    marks.clear();
    map.remove();
  }
  return { update, destroy };
}
