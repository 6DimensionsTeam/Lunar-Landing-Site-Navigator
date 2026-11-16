# Historical landing advisors handoff

Base: main 671be00. This branch adds only src/advisors.js, its native tests and this note.

Interface: reviewSite(site, entry) returns mission, year, source, failure, field, pass, value, note. pass is null when evidence is insufficient, never an implicit pass or a safety score. No candidate identifiers are hard-coded. Existing ranking, candidatePool, mission contracts, HUD and data are unchanged.

Cases: HAKUTO-R Mission 1 (operator statement), Mars Polar Lander (NASA review; probable mechanism), Peregrine Mission One (operator review; most likely mechanism). Each record links its official source. Engineering failures cannot be certified from site averages.

Validation (Node 24.11.1): all three advisors tests passed. Full suite: 12 of 13 files exited successfully; annual-calendar.test.mjs exits unsuccessfully after its two assertions pass because asynchronous module resolution attempts ./rank.js from a data: URL. The affected calendar/test files are unchanged from main. Do not report the entire suite as green. Production Vite build passed. Browser visual QA was not performed; this branch adds no UI.

Old branch correction: d26bf8e removes the unsupported 100 km fault veto and its PASS/FAIL row from olivia/landing-analysis-rewards. It retains fault distance only as a note. That old branch should not be merged wholesale; cherry-pick only coordinated changes if needed.
