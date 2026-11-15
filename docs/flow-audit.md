# End-to-end flow audit

Audited at commit `50163a1` in a copy of the working tree, viewport 1440x900 and 800x900.
Every finding below was reproduced in the running app; the ones carried over from a code read
alone are marked **[code]**. Severity is about what a first-time visitor experiences, not about
code quality.

The question behind every screen was the same four things: **where am I, what is the one thing
I should do here, what did my last choice cause, and what should I be unsure about.** Anything
that does not serve one of those four is noise.

---

## 1. The flow as it actually runs

```
boot -> 01 arrival date -> 02 Earth-Moon -> 03 mission settings -> 04 launch film
     -> 05 site map -> [site detail] -> [rover] -> [analysis]
```

Everything in square brackets is optional and none of them feed back into anything. The
declared five-step progress strip ends at "05 Site selection" and is not present on any screen
after it, so from the moment the user lands on the site map they have no idea where they are in
the journey.

### 1.1 The step indicator stops one step too early

`src/mission.js:290` defines the five steps. `updateSteps()` only runs inside the mission
bundle. The site map, site detail, rover and analysis screens carry no equivalent. The user has
just been shown "05 Site selection" as the last step, then is handed four more screens with no
marker at all.

### 1.2 Two entry paths, only one of them is the real one

`#home` still exists with three stacked buttons (`Enter Navigation`, `Choose a Site`,
`Relay Station`, `index.html:68-72`) but the mission flow never shows `#home`. After the mission
handover `mission.onMissionReady` shows `#select` directly (`src/main.js:1395-1408`). The home
screen is reachable only by going Back from the surface view when the surface was not entered
from the map (`backFromSurface`, `src/main.js:676`).

Result: a visitor who follows the intended path never sees the home screen, and a visitor who
presses Back on the surface view lands on a screen the flow was not built around, where all
three buttons start a *different* path with none of their mission settings. **[code]**

### 1.3 Depth: fewer levels than it feels

The screen graph is only three levels deep, which is fine. What makes it feel deep is that the
depth is uneven and the back edges are not a stack.

```
boot
 +- 01 arrival date
     +- 02 Earth-Moon            (forward/back only, no shortcut to anywhere)
         +- 03 settings
             +- 04 launch film
                 +- 05 site map  <- the fork, and where orientation ends
                     +- site detail    (two clicks to get here)
                         +- rover      (Back returns to site detail)
                         +- analysis   (Back returns to site detail)
                         |   +- Back to Site Map -> jumps to 05, skipping site detail
                         +- Back       -> 05 if entered from the map, #home if not

separate side paths, none of them sharing state with the above:
  #home -> Enter Navigation -> site detail (no data)
  #home -> Choose a Site    -> site map    (no mission requirements)
  #home -> Relay Station    -> relay view  (unrelated to the mission)
```

Three specific problems, all reproduced:

1. **Uneven step size.** 05 to site detail is one level but takes two clicks. Site detail to
   rover is one level and takes one. The visitor cannot build a model of "one click = one
   level".
2. **The back button is not a stack.** `Back` on analysis goes to site detail; on site detail it
   goes to the site map or to `#home` depending on how that screen was reached. Same key, three
   destinations, none of them predictable from the screen.
3. **One jump deletes a level.** `Back to Site Map` on analysis goes straight to 05, skipping the
   site detail the visitor was looking at moments earlier. Returning to that site means framing
   and landing on it again.

### 1.4 Only analysis and rover are real sub-screens

Of the four screens after the site map, only two behave like children:

- `analysis` and `rover` both return to site detail, and the site detail state survives.
- `site detail` itself is a child of the map but has no parent indicator. Its header reads
  `MALAPERT MASSIF / LANDING SITE D` with no breadcrumb, and its `Back` label does not say where
  it goes.

That means the navigation model the visitor has to learn is: the mission stages go forward and
back in a line, then the last screen becomes a hub with children, and one of the children has a
button that teleports past the hub. Three models in one flow.

### 1.5 The best data table in the product is on a screen the flow never visits

`#home` carries a 19-row table of every candidate, sorted, with `FAIL` flags and a reason per
row, at 12.6 px. It is the most legible and most complete candidate list anywhere in the
product. The mission flow never shows it: `onMissionReady` goes straight to `#select`
(`src/main.js:1395-1408`).

The screen the flow *does* send the visitor to has six rows at 9.5 px over a darker panel. The
screener exists and works; it is wired to the abandoned branch.

The code comment at `src/main.js:1443` states the assumption that broke:

```
// Back and Escape. Both ways into this screen come from home ...
// Nothing in the interface can reach this screen from another mode -- the button is guarded
// above -- but the dev hook can
```

That was true when the product had one entry. With the mission flow in front, `#select` is
reached from step 05, and its Back lands on `#home` — a screen the visitor has never seen, with
three buttons that start a different path carrying none of their settings. Reproduced: walking
the mission to the site map and pressing Back ends on `#home` with `MISSION TIME` and a
`Candidate Sites 2026-2040 Average` table the visitor was never in.

---

## 2. What each screen is missing, and what it says too much of

### 2.1 01 Arrival date

Missing:
- The six candidates are referred to as `A`/`B`/`C`/`D` plus two unnamed rows. No name appears
  anywhere on this screen. A visitor cannot tell what they are choosing between.
- Nothing says what the date changes. The same site on two dates differs by tens of percentage
  points in the underlying data, and the screen never says so.

Too much:
- Six reference rows (`Destination`, `Ephemeris`, `Sample interval`, `Available samples`,
  `Mission window`, `Candidate pool`). Four of them are provenance for a judge, not an input for
  the visitor. The only thing the visitor needs here is the date field.

### 2.2 02 Earth-Moon transfer

Missing:
- No verdict. The visitor changed the date and the screen answers with eight numbers and no
  sentence saying whether that date is good, hard, or unremarkable.
- No statement of what happens next.

Too much:
- Eight metrics in the left panel, six of which cannot inform any decision the visitor can
  take: `Parking altitude`, `Injection dv`, `Injection speed`, `Target speed`,
  `Earth perigee alt.`, `Earth apogee alt.`. They are engineering telemetry presented at the
  same weight as `Transfer time`.
- The right panel repeats the elapsed-transfer story, and the bottom timeline repeats the
  start/end dates a third time.
- `Configure mission` and `Recenter view` are both `.cta2` and sit side by side
  (`src/mission.js:257`). The next step and a camera utility have identical visual weight.

### 2.3 03 Mission settings

Missing:
- The darkness ruler is cut off. `#mission .p2-config` has `clientHeight 476` against
  `scrollHeight 635` at 1440x900, so the ruler at y=683 to y=751 is below the fold when the
  panel is at `scrollTop 0`. The visitor sets a number and cannot see where it lands against the
  candidate marks without scrolling a panel they had no reason to think was scrollable.
- The ruler marks are labelled `A / 204 h`, `B / 222 h`, `C / 273 h`, `D / 318 h`. Letters
  again, no names.
- The scan candidates are labelled `D81 / 273 h`, an internal grid id. The same point is called
  `DATA-SELECTED 81` on the site map and `D81` on the marker.

Contradiction:
- `4 / 4 sites within this darkness limit` (`src/mission.js:494`) counts only the four NASA
  regions. The candidate pool is six. The sentence is true for one set and read as true for the
  other.
- `Requested conditions 0 / 3` counts the three checkboxes but not the darkness limit, which is
  a fourth requirement and is evaluated later (`src/rank.js:105`). A visitor who only changed the
  darkness limit sees `0 / 3` and concludes nothing was recorded.

### 2.4 04 Launch film

- The skip button reads `Skip to arrival` (`src/mission.js:283`) but lands on the site map, not
  on a lunar arrival. The screen's own announcement at `src/mission.js:698` correctly says
  `Opening lunar site selection.` The visible label and the behaviour disagree.
- The reference card gives `+02:08 / REF.` and `+08:06 / REF.` next to a counter that stops at
  `09.5` seconds. Neither reference time can ever be reached in this clip, and `Altitude / speed`
  reads `NOT IN THIS CLIP`. Two thirds of the card is unusable by construction.

### 2.5 05 Site map

Missing:
- Two clicks are required to land: the first frames the site, the second commits. Nothing on
  screen says this. The only instruction is `Drag to turn the body, scroll to come closer.`
  (`index.html:327`). After the first click the marker gets a `sel` class and the camera moves,
  and the visitor has no reason to click the same row again.

Too dark:
- The candidate panel background is `rgba(0, 0, 0, 0.6)` (`#select .panel`) over an already dark
  globe. Combining a 60 percent black overlay with a low-luminance terrain surface leaves the
  panel body around one tenth of full brightness before text is drawn on it. This is the screen
  where the visitor makes their decision and it is the darkest one in the product.

Row hierarchy:
- The site name is **9.5 px** (`#sel-site-list .nm`), the figures are 10.1 px, the reason line
  is 10.1 px in `#8B979E`. The most important text on the screen — which site this is — is set
  smaller than the credits at the bottom of the panel.

### 2.6 Site detail (surface view)

This screen was empty at `aeffc63` and now carries data. It overshot.

Missing:
- No sentence. Nineteen rows across four panels, and none of them says what it adds up to. A
  visitor reading `76.6% Sunlit`, `83.6% Earth link`, `61.8% Both at once` has to invent the
  judgement themselves.
- No reference horizon. `Sun now -0.33 deg` is shown next to a `SUNLIT` badge. Both are correct:
  `lit` is `disk fraction > 0.5` against the *local terrain horizon* (`src/sites.js:62`), not
  against 0 deg, and Malapert stands on a ridge. But the horizon elevation is not on screen, so
  the pair reads as a contradiction. The one number that makes the conclusion legible is the one
  that is missing.
- `Longest night 318 h` and `Longest blackout 123 h` sit side by side with no distinction. They
  are different quantities (sun below the terrain horizon versus direct-to-Earth link blocked)
  and the risk each carries is never stated. At site A they are 204 h and 336 h — the ordering
  inverts, so a visitor who infers one from the other will be wrong at half the sites.

Too much / mis-scaled:
- `Coordinates 85.952 deg S - 356.61 deg E`. Longitude 356.61 E is 3.39 W. The raw catalogue
  value is `356.611` (`src/data/sites.json`) and `src/main.js:397` only normalises the modulo. No
  atlas writes a longitude that way.
- `Nearest fault 91.5 km - scarp Amundsen` with a footnote explaining it is a proximity proxy.
  On a decision screen a number that carries a warning and explicitly cannot support a decision
  is worse than no number.
- Five ways off this screen (`Back`, `Back to Site Map`, `Analyse This Site`,
  `Return to Moon`, `Rover Close-up`), none of them marked as the intended next step.

### 2.7 Analysis

This is the terminal screen and the weakest.

Contradiction, reproduced:
- Heading reads **`Suitable as configured`** (`src/main.js:1487`, unconditional).
- Body reads `Meets every stated requirement, and adds strong Earth link (83.6%)`.
- The requirement panel reads `Earth link 83.6% PASS` and `Dark limit 312 h PASS`.
- The visitor set zero requirements. Both rows are unconditional `true` in `src/rank.js:104-105`
  when the corresponding need is absent, and `src/main.js:1494` never falls through to its
  `No requirements set` branch because `verdicts` is never empty.

The correct behaviour already exists and is not reachable. `src/rank.js` `explain()` returns
`No requirements were set, so this is ranked on measured conditions alone: ...` in exactly this
case, and `src/main.js:1506` calls it. Four lines above, `src/main.js:1487` overwrites the
heading with an unconditional `Suitable as configured`. The guard and the copy were written;
the renderer bypasses both. This is the single most damaging defect for a judging audience: a
conclusion-shaped statement with no premise.

### 2.8 Two different statistics are labelled the same way

Measured from `src/data/sites.json`:

| Field | Definition | Check |
|---|---|---|
| `sun_visible_pct` | mean over 2026-2040 | A 82.21, per-year mean 82.21 — a true mean |
| `longest_dark_h` | **maximum** over 2026-2040 | D 318, per-year max 318, per-year min 312 |

The analysis header labels both `2026 ANNUAL MEANS`, and the site detail credit says
`Figures: 2026 annual`. A mean and a worst case carry the same label on the same row.

The consequence is visible in the numbers: the darkness limit is compared against the 15-year
worst case (`src/rank.js:82` uses `st.longest_dark_h`, the max), while the pad ruler plots a
baseline that is described as a period reference (`src/mission.js` `updateCandidates`,
`feedback.periodLabel`). Two different bases screen the same candidate in two consecutive
screens, and neither screen says which base it is using.

Site C shows why the distinction matters: its 15-year figure is 273 h but its worst single
calendar year is 270 h, because a dark period can straddle a year boundary. A reader told these
are annual means cannot reconcile either number.

### 2.9 `Sun now -0.33 deg` next to `SUNLIT`

This is not a bug, and that is the problem. `src/sites.js:62` sets `lit = frac > 0.5` where
`frac` is the fraction of the solar disk above the **local terrain horizon**, not above zero.
At Malapert the horizon in that azimuth is below 0, so the disk is still mostly visible with its
centre at -0.33 deg. The verdict is right. The screen never shows the horizon elevation, so the
only numbers the visitor can see contradict each other.

### 2.10 Relay station — the best-built screen, with two broken handoffs

This screen is the strongest in the product: one clear subject, a label per assembly, parameters
with a source. It is also untouched by the mission and carries two defects at its exits.

- `Descend to Site A` is hard-coded. `hud.onDescend` calls `go('explore')` (`src/main.js:688`)
  with no site argument, so the screen it lands on has no committed site — the ten-dash state in
  section 6. If the visitor arrived from a mission that selected D, the button still says A.
- `Shackleton Crater 67 km to site` is computed against the crater centre
  (`src/main.js:268`, `hud.bind('o-dist', ... distanceTo(groundAt(crater.center)) ...)`) but
  labelled as a distance to *the site*. At Malapert the distance to the chosen site is 122 km,
  not 67.
- `PPE - HALO - I-Hab - Airlock - Canadarm` names five modules, four of them never expanded
  anywhere, and `HALO` here denotes a habitat module while `HALO` is also the station's own name
  in the header two lines above.
- `Apolune` / `Perilune` are unexpanded, and the same screen family uses `Earth perigee/apogee`
  on the transfer screen, so the visitor meets two apsis vocabularies with one explained nowhere.

### 2.11 The zone tint turns the surface view into a colour wash

`src/main.js:332` sets the zone-tint strength per mode:

```js
const ZONEA = { home: 0.28, explore: 0.5, orbit: 0.34, rover: 0 };
```

The comment above it explains why rover is `0`: at close range a 480 m zone cell is larger than
the whole view, so the tint "would read as a flat wash". The surface view is at the same scale —
it is the same near camera — and its strength is the highest of any screen.

Reproduced at Connecting Ridge: the ground renders as one large blue field filling most of the
frame, while the `Ground Classes` legend beside it lists four classes. At that camera distance
one cell covers the view, so the legend offers four categories and the picture shows one. The
result reads as a translucent UI overlay rather than as ground, and it conceals the terrain the
screen exists to show.

This is the clearest case in the product of information that is present, accurate, and still
useless: the data layer was computed at 480 m, the camera is at metres, and nothing in the UI
says the two do not match at this scale.

---

## 3. Cross-screen: the same thing under different names

| Concept | Names in use | Where |
|---|---|---|
| Site A | `Shackleton Rim`, `Site A`, `A`, `Shackleton Crater`, `SHAckleton Rim` | home, orbit button, site map, surface default title |
| Candidate 5 | `D81`, `DATA-SELECTED 81`, `Data-Selected 81` | settings ruler, site map marker, site map row, analysis header |
| Relay station | `HALO`, `Relay Station`, `LUNAR RELAY STATION`, `LLN-LRS01`, `Relay Orbit` | button, header, kicker, panel |
| Longest night | `Longest night`, `N h dark`, `Dark limit`, `Longest acceptable night` | home table, site map row, analysis, settings |
| Earth-link outage | `Longest blackout` | site detail only, easily read as the previous one |

The relay station case is the clearest: one object, five names on one screen, and `HALO` also
appears inside the module string `PPE - HALO - I-Hab - Airlock - Canadarm` as a *part*. Four of
those five part names are never expanded anywhere in the product.

---

## 4. Layout at other aspect ratios

The HUD is laid out with absolute positions and fixed panel widths, so it does not degrade
gracefully. Reproduced on the site map:

**900 x 900 (square)**

- The zone legend panel overlaps the candidate panel; the legend's right edge is covered.
- Site markers on the map (`MALAPERT MASSIF`, `DE GERLACHE RIM`) are drawn underneath the
  panels and clipped.
- `Fly to Pole` and `Whole Moon` are gone.
- The candidate panel stays 400 px wide with its content un-reflowed: the site name and its
  `MEETS` badge collide, the reason line wraps to three lines.

**390 x 844 (phone)**

- The top bar is cropped on the right; the clock is half cut.
- The left legend is pushed off-screen, leaving a 60 px sliver with text broken one character
  per line (`AR`, `SI`, `un`, `ark`, `ve`).
- **The candidate list disappears entirely.** There is no way to choose a site at this size.
- The scale ruler labels read `180 / 120 / 77 / 38 / 19 / 58 / 96 / 130`, which is not in order.
- `Fly to Pole`, `Whole Moon` and `Back` are all unreachable.

If the entry is judged on a laptop only this may never be seen. If a judge opens it on a phone
or in a narrow window, the decisive screen of the product is unusable.

---

## 5. Typography and contrast

Measured on the live page at 1440x900.

- **49 distinct font sizes** are in use across the HUD (8, 8.64, 8.832, 9, 9.36, 9.4944, 9.6,
  9.7152, 9.804, 9.84, 9.936, 10, 10.08, 10.1568 ... 51.84, 53.28). That is not a scale, it is
  49 independent decisions, and it is why the layout reads as uneven.
- The most important strings are the smallest:

| Element | Size |
|---|---|
| Candidate site name, site map | 9.5 px |
| Candidate figures and reason line | 10.1 px |
| Data credits and footnotes | 8.6-9.4 px |
| Step indicator | 9 px |
| Row labels (`dt`) in every panel | 10-11.4 px |
| Setting checkbox sub-labels (`NOT REQUESTED`) | 8 px |

- Panel backgrounds are a flat `rgba(0,0,0,0.6)` with no backdrop blur, laid over a dark scene.
  On the site map this puts body text on roughly one tenth of full luminance.

A floor of 12 px for any text a visitor is meant to read, and a 5-step scale
(12 / 14 / 18 / 28 / 44) would remove most of the perceived clutter without deleting a single
piece of information. Much of what reads as "too much information" is actually "too much
information at 9 px".

---

### 5.1 Contrast and focus are mostly fine — the problem is that nothing is focusable

Worth recording so the good parts are not lost, and so the real defect is not misdescribed.

Measured WCAG contrast ratios (panel `rgba(0,0,0,0.6)` composited over scene luminance 40 and 80):

| Pair | Ratio |
|---|---|
| body `#f2f4f5` on panel | 17.3 / 14.8 |
| label `#b4bdc4` on panel | 10.0 |
| secondary `#8b979e` on panel | 6.4 / 5.5 |
| accent `#ff6959` on black | 7.4 |
| accent `#e2200f` on black | 4.5 |

All pass 4.5:1 for normal text. The product is not low-contrast; it is **small**. That is why
raising type size alone would fix most of the perceived legibility problem.

There are 16 `:focus-visible` rules and every button has a visible focus ring. Only two elements
suppress the outline, both deliberately (`#rover:focus`, `#mission h1:focus`, containers that are
focused programmatically for screen readers).

The actual accessibility defect is in section 6.1: the candidate rows are not focusable, so
there is nothing for those focus styles to apply to.

---

## 6. Failure states

Only boot has one. `src/hud.js:82-95` adds a `Retry` button when a load fails. Every other
screen has no failure path.

| Screen | If it fails now |
|---|---|
| 01-04 | blank or a stale value; no message |
| 05 site map globe | the screen never appears; the mission screen is already hidden, so the visitor sees the background scene with no HUD |
| Site detail | panels render with `-` in every row and no explanation |
| Analysis | cannot be reached; the button stays disabled with no reason given |
| Launch film | one error line and a retry button, the only handled case |

`#explore` reached without a committed site is the worst of these: `surfaceHud.set()` is called
only from `descendTo()` (`src/main.js:1377`), while `hud.onEnter` and `hud.onDescend` both call
`go('explore')` directly (`src/main.js:684`, `:688`). Reproduced: entering the surface view that
way shows ten `-` fields, a title of `Shackleton Crater`, and a disabled `Analyse This Site`.

### 6.1 The candidate list cannot be used without a mouse

Measured on the site map:

- Seven candidate rows, all `<div>` with a click listener and `cursor: pointer`.
- `tabIndex` on every row: `0` focusable elements; no `role`, no key handler.
- The only focusable controls on the screen are `Back`, the clock button, `Fly to Pole` and
  `Whole Moon`.

A keyboard user can therefore reach the site map, fly the view and leave it, but cannot choose a
site at all — and choosing a site is the task. The same is true of the 19-row table on `#home`.

### 6.2 The site map cannot be landed on with one click, and nothing says so

`src/main.js` requires `framedSite === s.id` before `descendTo`, so the first click only frames.
No instruction on the screen mentions a second click. Combined with 6.1, a visitor using a
pointer has one unlabelled two-step gesture as the only way forward, and a visitor using a
keyboard has none.

### 6.3 Hostile input at the mission settings screen

Tested by dispatching `input` on `[data-ui="max-dark"]` and reading the feedback line:

| Input | Feedback | LAUNCH |
|---|---|---|
| empty | error: `Enter the stay duration and maximum darkness.` | disabled |
| `-5` | error: `Maximum darkness must be zero or more hours.` | disabled |
| `abc` | error: `Enter the stay duration and maximum darkness.` | disabled |
| `0` | `0 / 4 sites within this darkness limit` | **enabled** |
| `1e9` | `4 / 4 sites within this darkness limit` | **enabled** |

Validation exists for the empty and negative cases, which is good. Two gaps remain:

- A limit that no candidate can meet (`0`) still allows launch, with no warning that the mission
  as configured is impossible.
- There is no upper bound, so `1e9` is accepted and reported as `4 / 4`.
- Every row above counts four sites. The pool is six, and the two scanned candidates are never
  in the count.

### 6.4 Up to seven seconds with no interface at all

`go()` hides the outgoing HUD at `src/main.js:469` and only raises the next one inside the
flight's completion callback. The flight durations are fixed:

| Transition | Duration |
|---|---|
| `orbit` to `explore` | **7000 ms** |
| to `orbit` | 6000 ms |
| `home` from `orbit` | 5200 ms |
| to `explore` from `home` | 4200 ms |
| to `home` | 3600 ms |

During that window the screen shows only the 3D scene at intermediate exposure. Reproduced: the
relay screen to the surface view reports no screen up for the whole 7 s. There is no "descending"
label, no progress, and Escape is inert because the flight owns the frame. A visitor who does not
know a 7-second cinematic is coming reads it as a hang.

### 6.5 Load and runtime cost

Measured on a mid-range Mac at 1440x900, DPR 2 (canvas 2039x1274).

Payload, development server, transfer sizes:

| Asset | Size |
|---|---|
| `terrain_inner.bin` | 18.2 MB |
| `station.glb` | 16.3 MB |
| `terrain_outer.bin` | 15.5 MB |
| `ephem.bin` (2026-2040) | 10.4 MB |
| `moon_spole_relief.jpg` | 7.1 MB |
| `terrain_hero.bin` | 5.6 MB |

On disk the data and models total 21.4 MB. The build inlines everything because
`vite.config.js` sets `assetsInlineLimit: () => true`, so `dist/index.html` is **37.5 MB** — a
1.76x inflation over the raw assets, 1.33x of which is base64 by construction. On a slow
connection or from a phone this is a 40 MB download before anything renders.

Runtime:

- 120 Hz display, uncapped. Median frame 8.3 ms, which is full rate for a 120 Hz panel. **There
  is no frame cap**, so the scene renders 120 times a second with three shadow maps and a bloom
  pass. On a 120 Hz laptop this is double the work of 60 fps for no visual gain, and it is what
  makes the fans spin.
- Sustained frame pacing on the surface view: fps 64.5, p50 8.4 ms, **p95 60 ms, worst 177 ms**,
  18 frames over 33 ms in a 4-second window.
- During the 7 s landing flight the frame rate holds at the display rate (120 fps, worst frame
  9.4 ms), so the flight itself is smooth. The stutter is not in the flight.
- JS heap after the full flow: **505 MB**. This is the number to watch on a mid-range laptop or a
  phone; 500 MB of live JS heap plus a 2039x1274 framebuffer and three shadow maps is close to
  what a mobile browser will tolerate before a tab is discarded.

The boot sequence itself is fast and should not be changed: the log's own timestamps put
`SYSTEMS NOMINAL` at **0.88 s** after script start, with decode, terrain build, shadow allocation
and site loading all under 0.9 s. The cost of this product is the payload, not the start-up.

One inconsistency visible in that same log: it reports `19 sites - 0.5 deg azimuth step` while the
mission intro reports `6 CANDIDATES`. Both are true of different sets (all sites versus the pool
being offered), and the product never says which is which.

---

## 7. What would make the flow feel continuous

Ordered by how much they change the experience per unit of work. None of these add a feature.

1. **One sentence per screen stating what it is for and what the next step is.** Every screen
   currently opens with a noun phrase (`Departure geometry.`, `Choose a Site`, `Suitable as
   configured`) and none closes with a next step.
2. **One primary button per screen.** Demote `Recenter view`, `Return to Moon`, `Rover Close-up`
   and the duplicate back links to secondary weight; keep exactly one `.cta` per screen.
3. **Carry the five-step strip past step 05**, or replace it with a persistent mission strip
   (date, site, step) in the topbar that every screen shares.
4. **Name the sites everywhere.** One display string per site (`A - Shackleton Rim`), used on
   the settings ruler, the map marker, the map row, the surface header and the analysis header.
5. **Say what the numbers mean, or drop them.** `Suitable as configured` must become either a
   real requirement-by-requirement verdict or `Ranked on measured conditions`.
6. **Raise the type floor to 12 px and collapse to a five-step scale.**
7. **Make the site map a single click to land**, or label the two-step interaction.
8. **Give the site detail one sentence of plain language** above the panels, and add the local
   horizon elevation next to `Sun now` so `SUNLIT` at -0.33 deg stops reading as a bug.

---

## 8. Decision table

One row per screen: what the visitor is there to decide, the one control that takes them
forward, what that decision has to carry, and what happens when the screen cannot do its job.
The last column is the empty one everywhere except boot.

| # | Screen | The visitor decides | The one primary control | Carries forward | If it fails today |
|---|---|---|---|---|---|
| 0 | boot | nothing | none | — | `Retry` button (`src/hud.js:82`) — the only handled failure in the product |
| 1 | arrival date | when | `Plan my journey` | `arriveH` | stays on the screen with an inline error; acceptable |
| 2 | Earth-Moon | accept the transfer | `Configure mission` | unchanged `arriveH` | none; the transit canvas can fail silently and leave a black panel |
| 3 | mission settings | stay length, four requirements | `LAUNCH` | `{arriveH, launchH, stayH, needs}` | validation exists for empty/negative; `0` and `1e9` pass and still allow launch |
| 4 | launch film | nothing (it is a movie) | `Skip to arrival` | config | error line + retry; the only other handled case |
| 5 | site map | **which site** | one row, **twice** | `{site, entry, year, needs}` | no keyboard path at all; Back lands on a screen outside the flow |
| 6 | site detail | is this site good | `Analyse This Site` (or `Rover Close-up`) | unchanged | ten dash fields if entered from `Enter Navigation` or `Descend to Site A`; disabled analyse button, no reason given |
| 6a | rover | drive it | none — it is a dead end except Back | none | no failure path; rover is fixed to site A while the header claims the chosen site |
| 7 | analysis | nothing — it should be the answer | none; `Back to Site Map` is the only exit | — | unreachable without a committed site; renders `Suitable as configured` with no requirements set |

Two things this table makes obvious:

- **Step 5 is the only real decision in the product**, and it is the one screen with no keyboard
  access, the smallest type, the darkest panel, and a two-click gesture nothing explains.
- **Step 7 has no decision and no primary control.** The flow ends on a screen that reports a
  verdict the visitor cannot act on, change, or compare against another site.

### 8.1 What each screen should carry, for comparison

If the strip is added, this is the minimum a shared mission bar needs to hold: the arrival date,
the stay length, the site (once chosen), and which of the four requirements were asked for. Every
one of those is already in `mission.cfg` and `mission.site`; nothing new has to be computed.
