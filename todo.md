# LLN Work Queue

Branch: `mission-framework` · all changes stay in `src/` and `index.html`

Style contract (must match throughout):
- Font: existing `--font-mono` stack, uppercase labels, `letter-spacing`
- Colours: `#e8e8e8` text, `#c0392b` accent red, `#0a0a0a` background, `#1a1a1a` card surface
- Border radius: 0 (sharp corners everywhere)
- Animation: CSS transitions only, no libraries; existing `fade-in` / `slide-up` classes

---

## TASK D — PDF feedback bugs F-09, F-10, F-11, F-12, F-15  ✅ OWNER: agent-bugs
**Files**: `src/mission.js` (F-09), `src/main.js` (F-10, F-11, F-15), `src/scene/rover.js` (F-12)

### F-09 — Mission duration labels overlap at 64–110 days
In `src/mission.js`, find the duration slider tick-label rendering. When the slider value is
between 64 and 110 days, the "24h" and "7d" tick labels collide visually.
Fix: add a minimum-pixel-gap check before rendering each label — skip a label if its left edge
is within 28 px of the previous label's right edge. Use `el.getBoundingClientRect()` or
compute from the slider's own width and tick positions.

### F-10 — Time multiplier display stale after "Jump to sunset"
"Jump to sunset" jumps simulation time forward but the ×N multiplier readout doesn't reset.
Find where `jumpToSunset` (or equivalent) sets the simulation time in `src/main.js` and check
whether it resets the displayed speed multiplier to ×1. If not, add `setMultiplier(1)` (or
equivalent reset) after the jump so the display matches the actual post-jump speed.

### F-11 — Sunrise/sunset jump cycles between two fixed times
After the first click, subsequent clicks to "Jump to sunrise/sunset" toggle between the same
two timestamps instead of advancing from the current time.
Root cause: the "next event" search likely caches its last result and doesn't advance the
search start time. Fix: after each jump, update the search start to `currentSimTime + 1 second`
so the next search always finds a future event from the new position.

### F-12 — Rover speed reads 8000 m/s when time-accelerated, top speed is 4.8 m/s
In `src/scene/rover.js`, the speed display multiplies physics velocity by the time-acceleration
factor before display. Speed readout should show the *physical* m/s the rover is moving at,
not the time-scaled equivalent. Find where speed is computed for the HUD and divide out the
time multiplier (or use the pre-scaled physical speed variable directly).

### F-15 — Working-range warning shows km while odometer shows m (192 m vs 1.6 km)
In the rover HUD, the odometer reports "192 m from A" but the working-range warning says
"1.6 km from A". These use different position sources or unit conversions.
Find both calculations in `src/main.js` (or `src/hud.js`): one reads local position in metres,
the other likely converts km→m incorrectly (multiply/divide mismatch). Unify them to the same
position source and unit.

---

## TASK A — Rover floating / sinking physics  ✅ OWNER: agent-rover
**File**: `src/scene/rover.js` only

**Bug**: at some sites the rover visibly floats above the ground on first load, then slowly sinks
through it; at Shackleton Rim (the hero-tile site) it behaves correctly.

**Root cause to verify**: `heightLocal()` (line 112–122) samples `heroFine` or `coarseFine`
depending on `nu.uFine.value`, which is set in `updatePatch()` (line 90). But `updatePatch()`
uses `fineAt(PC.x, PC.y)` where `PC` is the *patch centre* not the rover position, and returns
`1` only when the patch centre is wholly inside `heroFineHalf − PATCH.half/1000`. At a site
where the rover spawns near the tile edge the patch centre can be inside yet the rover can be
outside, so `heroFine` is called on a point it cannot accurately represent (clamps to edge),
returning a flat-floor height rather than the real terrain height.

**Fix**:
1. In `heightLocal(lx, ly)` choose `heroFine` vs `coarseFine` per *sample point* `vx(i),vy(j)`
   rather than once per patch using the patch-centre flag `nu.uFine.value`. Each corner of the
   interpolation quad should independently call `fineAt(vx(i), vy(j))` to pick the right sampler.
2. Keep `nu.uFine` as the *shader* uniform (it still controls the GPU branch) — only the CPU
   height sampling logic changes.
3. Verify: at every site in `src/data/candidates.json`, the rover spawns flush with the ground
   and does not drift up or down over 5 seconds.

---

## TASK B — Board discussion panel + training + certificate  ✅ OWNER: agent-board
**New files**: `src/board.js`, `src/board.css`
**Edited files**: `index.html` (new `<section id="board">` block), `src/main.js` (import +
  `showBoard()` / `hideBoard()` calls), `src/style.css` (import `./board.css`)

**What it is**: after the user picks a final landing site on the site map, before the surface
view loads, show an "Advisory Board Session" overlay. The panel:

### B1 — Board members (Layer 1 — Core Think Tank)
Show 4–5 fictional board member cards (astronaut, NASA scientist, AI systems lead, mission
planner, geologist). Each card has:
- Name, role, small avatar initial block (red square, white letter — same style as site chips)
- Their recommended site (one of the six, pre-scripted per member)
- One sentence of reasoning (2–3 sentences max)
- A `VOTE` badge showing their pick

Members should disagree: at least two should pick the user's site, one or two should pick a
different site, one should abstain or be uncertain. This creates genuine discussion.

### B2 — Layer 2 — Qualified Volunteers
Below the core panel: a compact row showing "3 qualified volunteers voted" with a small
histogram bar per site (how many volunteer votes it got). These are scripted numbers, not live.
Volunteers require "85%+ on virtual tests" — show this credential label beside each volunteer.

### B3 — Training gate
Before revealing the board's discussion, show a single question: "Which site do you recommend
to the board?" with the six site chips as options. The user picks one and submits.
- If correct (matches the data-top-ranked site for their mission settings): show "Board agrees
  with your assessment" in green, then reveal the full board discussion.
- If wrong: show "Here is why the board chose differently:" in amber, then reveal the board
  discussion explaining the disagreement.
No retries — one answer, then the board opens. This is about learning, not gating.

### B4 — Historical data section
After the board cards, add a collapsible `▶ Historical evidence` section. Import `reviewSite`
from `./advisors.js` and render each advisor entry with:
- Mission name + year (bold), source URL in `<a>` with `[source]` link text
- Failure evidence (one paragraph)
- The reviewer's question (italic)
- Scope and limit in `<small>` text (cite class: `cite`)
- `pass: null` renders as a grey `REVIEW REQUIRED` badge

### B5 — Certificate
After the user clicks "Proceed to surface →" in the board panel, generate a downloadable
certificate. It is a plain `<canvas>` 1200×800 painted with:
- Background: `#0a0a0a`, thin red border inset 20 px
- Title: "LUNAR LANDING ADVISORY CERTIFICATE"
- Subtitle: user's chosen site name + year
- Body: "This mission plan was reviewed by the LLN Advisory Board on [date]"
- Their training result (correct / disagreed with board)
- LLN logo text in the bottom-right corner
Trigger a `<a download>` on click. No external libraries.

### B6 — Entry / exit
- Entry: called from `main.js` after `selectSite()` and before `enterSurface()`. Show board
  with `hud.show('board')` / `hud.hide('board')` or the equivalent `classList` toggle.
- Exit: "Proceed to surface →" button in the board panel calls the continuation that
  `enterSurface()` currently calls directly.
- Style: same full-bleed dark overlay as the existing mission wizard screens; use the
  `.p2-` prefix for new CSS classes to match the existing naming convention.

---

## TASK C — Timeline data verification + data citations  ✅ OWNER: agent-data
**Files touched**: `src/annual-calendar.js` (read + minimal fix if needed),
  `src/style.css` (new `.cite` rule), `src/main.js` (cite additions), `index.html` (cite additions)

### C1 — Timeline "always meets" check
The timeline in Image 2 shows all white (Meets) for DATA-SELECTED 81, 2026–2040.
Verify this is correct:
1. Open `src/data/candidates.json` and find the entry with the highest numeric id.
2. Check `stats_by_year` — does every year (2026–2040) genuinely meet the annual criteria, or
   is some year missing / wrong?
3. If the data is correct, add a `<small class="cite">` note beside the timeline legend:
   "Annual criteria: sun > [threshold]%, Earth link > [threshold]% — computed from JPL DE421
   ephemeris, 3-hour steps, 2026–2040." (fill real thresholds from `rank.js` / `annual-calendar.js`).
4. If a display bug is found (e.g. a year that should fail renders as meets), fix it in
   `annual-calendar.js`.

### C2 — Data citations throughout the app
Add `<small class="cite">` attribution lines at the following places. Keep each under 120 chars.
Existing cite-class rules may already exist; add one in `style.css` if not:
  `.cite { font-size: 0.72rem; color: #666; letter-spacing: 0; text-transform: none; }`

Locations to cite (add inline in `index.html` or via JS in `main.js` where the content is dynamic):
- Home screen table footnote: already has one — verify it links to the LOLA/DE421 sources
- Site detail Sun row: add `<small class="cite">JPL DE421 ephemeris · 3 h steps</small>`
- Site detail Earth row: same cite
- Slope readout in zone map: `<small class="cite">LOLA 40 m DEM · NASA/GSFC</small>`
- Site stats panel (sunlight %, Earth %, longest dark): `<small class="cite">LOLA horizon profiles · DE421 · 3 h, 2026–2040 mean</small>`
- Annual calendar header: cite DE421 + computation method
- Rover HUD slope: `<small class="cite">LOLA 40 m</small>`
- Advisory board historical entries: already handled in Task B

### C3 — "Meets / Fails" label consistency
In Image 3 the site detail shows "MEETS ANNUAL CRITERIA" as a large pill. Cross-check that the
same `entry.meetsAll` value drives both this pill and the site-list row colour in the map (they
currently use different render paths — `main.js:546` vs `main.js:1367`). If they ever disagree
for the same site+year, fix the out-of-sync one.

---

## TASK E — Team branding  ✅ DONE
**Files**: `src/mission.js`, `src/assets/team-logo.png`, `src/assets/artemis-board.webp`

- Brand button updated: "6Dimensions" / "Smarter lunar decisions"
- Team logo (`src/assets/team-logo.png`) added to mission header brand button
- Advisory board hero image at `src/assets/artemis-board.webp` (Artemis group photo — still needs correct image; user to save and copy)
- All UI images consolidated in `src/assets/`; scene textures remain in `src/data/` and `src/scene/assets/`

---

## Merge plan (coordinator — do after all three agents finish)
1. `src/scene/rover.js` — apply agent-rover's diff directly (no conflicts).
2. `src/board.js` + `src/board.css` — copy in as new files (no conflicts).
3. `src/style.css` — apply agent-data's `.cite` rule, then agent-board's `.p2-board-*` rules.
4. `index.html` — apply agent-data's cite additions first, then agent-board's new `<section>`.
5. `src/main.js` — apply agent-data's cite additions (purely additive), then agent-board's
   `showBoard` / `hideBoard` wiring (touches the `selectSite` / `enterSurface` path only).
6. Run `npm test` — all existing tests must pass; no new test files required unless a bug was found.
